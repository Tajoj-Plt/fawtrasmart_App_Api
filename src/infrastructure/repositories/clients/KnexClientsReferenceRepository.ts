import { Knex } from 'knex';
import { ModuleSettingsRow, SettingRow } from '../../../domain/services/clients/ClientSettings';
import { TreeNode } from '../../../domain/services/clients/BranchTree';
import { ClientsReferenceRepository, CurrencyRow, LedgerParent, NamedOption, PlanUsageItem, StatusOption, SubscriptionRecord } from '../../../domain/repositories/clients';
import { bool } from '../../db/knex';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(v));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** البيانات المرجعية لوحدة العملاء — كلّها قراءة، وأغلبها يُحفظ مؤقتاً في طبقة التطبيق */
export class KnexClientsReferenceRepository implements ClientsReferenceRepository {
  constructor(private readonly db: Knex) {}

  async subscriptionRecord(): Promise<SubscriptionRecord | null> {
    const r = await this.db('fawtra_subscription')
      .first('snapshot', 'is_active', 'is_expired', 'is_trial', 'status', 'end_date', 'consecutive_failures', 'last_error')
      .catch(() => null);
    if (!r) return null;
    return {
      hasSnapshot: r.snapshot !== null && r.snapshot !== undefined && r.snapshot !== '',
      isActive: bool(r.is_active),
      isExpired: bool(r.is_expired),
      isTrial: bool(r.is_trial),
      status: (r.status as string | null) ?? null,
      endDate: r.end_date ? String(r.end_date).slice(0, 10) : null,
      consecutiveFailures: Number(r.consecutive_failures ?? 0),
      lastError: (r.last_error as string | null) ?? null,
    };
  }

  async planFeature(key: string): Promise<{ allowed: boolean; label: string }> {
    try {
      const row = await this.db('fawtra_subscription').first('snapshot');
      if (!row?.snapshot) return { allowed: true, label: key };
      const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
      const plan = snap?.plan?.plan ?? snap?.plan ?? {};
      const permissions = (plan?.permissions ?? {}) as Record<string, unknown>;
      const allowed = !(key in permissions) || Boolean(permissions[key]);
      const labels = (plan?.permission_labels ?? {}) as Record<string, string>;
      const usage = (Array.isArray(snap?.usage) ? snap.usage : []) as Array<Record<string, unknown>>;
      const label = labels[key] ?? (usage.find((u) => u?.key === key)?.label as string | undefined) ?? key;
      return { allowed, label };
    } catch {
      return { allowed: true, label: key };
    }
  }

  async settingRows(): Promise<SettingRow[]> {
    const rows = await this.db('general_client_settings').select('*');
    return rows.map((r: Record<string, unknown>) => {
      const { key, options, is_active, ...columns } = r;
      return { key: String(key), isActive: bool(is_active), columns, options: parseJson(options) };
    });
  }

  async moduleSettings(): Promise<ModuleSettingsRow> {
    const row = await this.db('client_module_settings').first().catch(() => null);
    // صفٌّ غائب = كل الأقسام مفعّلة، كما يُنشئه `ClientModuleSetting::current()`
    const on = (v: unknown) => (row ? bool(v) : true);
    return {
      visitsEnabled: on(row?.visits_enabled),
      itineraryEnabled: on(row?.itinerary_enabled),
      locationEnabled: on(row?.location_enabled),
      exemptLocationEnabled: on(row?.exempt_location_enabled),
      notesEnabled: on(row?.notes_enabled),
    };
  }

  async treeNodes(): Promise<TreeNode[]> {
    const rows = await this.db('branches').select('id', 'name', 'code', 'parent_id', 'node_type', 'is_territory', 'territory_office_id', 'is_main', 'status');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      code: (r.code as string | null) ?? null,
      parentId: num(r.parent_id),
      nodeType: (r.node_type as string | null) || null,
      isTerritory: bool(r.is_territory),
      territoryOfficeId: num(r.territory_office_id),
      isMain: bool(r.is_main),
      status: num(r.status),
    }));
  }

  /** `Statuses::assignable()->ordered()` — نشط/موقوف */
  async assignableStatuses(): Promise<StatusOption[]> {
    const rows = await this.db('statuses').whereNull('section').whereNotNull('kpi_role').orderBy('sort_order').orderBy('name').select('id', 'name', 'color');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), color: (r.color as string | null) ?? null }));
  }

  /** أوضاع العميل (مراحل التسجيل) */
  async registrationStages(): Promise<StatusOption[]> {
    const rows = await this.db('statuses').where('section', 'registration_stage').orderBy('sort_order').orderBy('name').select('id', 'name', 'color');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), color: (r.color as string | null) ?? null }));
  }

  async statusName(id: number | null): Promise<string | null> {
    if (!id) return null;
    const r = await this.db('statuses').where('id', id).first('name');
    return r?.name === undefined || r?.name === null ? null : String(r.name);
  }

  async statusExists(id: number): Promise<boolean> {
    return Boolean(await this.db('statuses').where('id', id).first('id'));
  }

  async categories(): Promise<NamedOption[]> {
    const rows = await this.db('categories_clients').orderBy('name').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  /** حاملو صلاحية الاعتماد — `ClientStatusRequest::approvers()` (بالدور `users.role_id`) */
  async approvers(permission: string): Promise<NamedOption[]> {
    const roleIds = this.db('role_has_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('p.name', permission).select('rp.role_id');
    const rows = await this.db('users').whereIn('role_id', roleIds).orderBy('name').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async isApprover(userId: number, permission: string): Promise<boolean> {
    if (!userId) return false;
    const roleIds = this.db('role_has_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('p.name', permission).select('rp.role_id');
    return Boolean(await this.db('users').where('id', userId).whereIn('role_id', roleIds).first('id'));
  }

  async defaultCurrency(): Promise<CurrencyRow | null> {
    const r = await this.db('system_currencies').where('is_default', 1).first().catch(() => null);
    if (!r) return null;
    return {
      code: String(r.code ?? 'SAR'),
      symbol: (r.native_symbol as string | null) || (r.symbol as string | null) || String(r.code ?? 'SAR'),
      decimalPlaces: r.decimal_places === null || r.decimal_places === undefined ? 2 : Math.max(0, Number(r.decimal_places)),
      thousandsSeparator: (r.thousands_separator as string | null) || ',',
      decimalSeparator: (r.decimal_separator as string | null) || '.',
      positiveFormat: (r.positive_format as string | null) || 'standard',
      negativeFormat: (r.negative_format as string | null) || 'standard',
      roundingMethod: (r.rounding_method as string | null) || 'round',
    };
  }

  /** `AccountingSettings::account('clients_account')` — الحساب الأب لذمم العملاء */
  async ledgerParent(key: string): Promise<LedgerParent | null> {
    const setting = await this.db('accounting_settings').where('key', key).where('is_active', 1).whereNotNull('account_id').first('account_id').catch(() => null);
    if (!setting?.account_id) return null;
    const a = await this.db('accounts').where('id', setting.account_id).first('id', 'code', 'account_type', 'balance_type');
    return a ? { id: Number(a.id), code: String(a.code ?? ''), accountType: (a.account_type as string | null) ?? null, balanceType: (a.balance_type as string | null) ?? null } : null;
  }

  /** إعدادات الإشعارات — نوعٌ معطَّل لا يُنشأ (`NotificationSetting::allows()`) */
  async notificationSettings(): Promise<Record<string, boolean>> {
    try {
      const rows = await this.db('notification_settings').select('key', 'is_enabled');
      return Object.fromEntries(rows.map((r: Record<string, unknown>) => [String(r.key), bool(r.is_enabled)]));
    } catch {
      return {};
    }
  }

  /** بند حدٍّ من لقطة الاشتراك — `SubscriptionGate::limit()` */
  async planUsage(feature: string): Promise<{ item: PlanUsageItem | null; subscriptionStart: string | null }> {
    try {
      const row = await this.db('fawtra_subscription').first('snapshot');
      if (!row?.snapshot) return { item: null, subscriptionStart: null };
      const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
      const list = Array.isArray(snap?.usage) ? snap.usage : Object.values(snap?.usage ?? {});
      const found = (list as Array<Record<string, unknown>>).find((u) => u?.key === feature) ?? (snap?.usage?.[feature] as Record<string, unknown> | undefined);
      const item: PlanUsageItem | null = found
        ? {
            label: String(found.label ?? feature),
            period: (found.period as string | null) ?? null,
            unlimited: bool(found.unlimited),
            allowance: Number(found.allowance ?? -1),
            used: Number(found.used ?? 0),
          }
        : null;
      return { item, subscriptionStart: (snap?.subscription?.start_date as string | null) ?? null };
    } catch {
      return { item: null, subscriptionStart: null };
    }
  }

  async userProximityRadius(userId: number): Promise<number | null> {
    const r = await this.db('users').where('id', userId).first('visit_proximity_radius_km').catch(() => null);
    const v = r?.visit_proximity_radius_km;
    return v === null || v === undefined ? null : Number(v);
  }

  /** `User::regionGroups` — مجموعات مناطق الموظف (`employee_group` ↔ عقد `is_territory`) */
  async regionGroupIds(employeeId: number): Promise<number[]> {
    const rows = await this.db('employee_group as eg')
      .join('branches as b', 'b.id', 'eg.group_id')
      .where('eg.employee_id', employeeId)
      .where('b.is_territory', 1)
      .pluck('b.id');
    return rows.map(Number);
  }

  /** الموظفون المتاحون لإسناد العملاء — `scopeEmployeesToClientDepartments()` */
  async assignableEmployees(departmentIds: number[], alsoIds: number[]): Promise<Array<{ id: number; name: string; department: string | null; departmentId: number | null }>> {
    const q = this.db('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').whereNull('e.deleted_at');
    if (departmentIds.length) {
      q.where((w) => {
        w.whereIn('e.department_id', departmentIds);
        if (alsoIds.length) w.orWhereIn('e.id', alsoIds);
      });
    }
    const rows = await q.select('e.id', 'e.first_name', 'e.middle_name', 'e.department_id', 'd.name as department_name').orderBy('e.id');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      name: `${r.first_name ?? ''} ${r.middle_name ?? ''}`.trim(),
      department: (r.department_name as string | null) ?? null,
      departmentId: num(r.department_id),
    }));
  }

  async employeeDepartment(employeeId: number): Promise<{ exists: boolean; departmentId: number | null }> {
    const r = await this.db('employees').where('id', employeeId).whereNull('deleted_at').first('department_id');
    return { exists: Boolean(r), departmentId: r ? num(r.department_id) : null };
  }

  async activeCompetitors(): Promise<NamedOption[]> {
    const rows = await this.db('competitors').where('is_active', 1).orderBy('name').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async userNames(ids: number[]): Promise<Map<number, { name: string; roleId: number | null; roleName: string | null }>> {
    if (!ids.length) return new Map();
    const rows = await this.db('users as u').leftJoin('roles as r', 'r.id', 'u.role_id').whereIn('u.id', ids).select('u.id', 'u.name', 'u.role_id', 'r.name as role_name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), { name: String(r.name ?? ''), roleId: num(r.role_id), roleName: (r.role_name as string | null) ?? null }]));
  }
}
