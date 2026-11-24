import { User } from '../../../domain/entities';
import { OverviewFigures, RecordScope } from '../../../domain/entities/accounting';
import { AppError } from '../../../domain/errors/AppError';
import { AccountingRepository, ListResult } from '../../../domain/repositories/accounting';
import {
  AccessContext,
  AccountingGroup,
  AccountingSectionKey,
  evaluateItem,
  findAccountingItem,
  resolveAccountingSections,
} from '../../../domain/services/AccountingCatalog';
import { AccountingAccess } from '../../services/AccountingAccess';
import { DataScopeService } from '../../services/DataScopeService';
import { PeriodResolver, ResolvedPeriod } from '../../services/PeriodResolver';

export interface ListParams {
  page?: number;
  perPage?: number;
  search?: string;
  period?: string;
  status?: string;
  state?: string;
  kind?: string;
  type?: string;
  parentId?: number;
}

export interface PeriodDTO {
  key: string | null;
  label: string;
  isDefault: boolean;
  unconfigured: boolean;
  from: string | null;
  to: string | null;
}

export interface AccountingListDTO<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totals?: Record<string, number>;
  period: PeriodDTO | null;
}

const clamp = (n: number | undefined, min: number, max: number, fallback: number) => (n && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback);

/**
 * وحدة الحسابات — القائمة الجانبية وشاشات العرض بنفس قواعد الويب:
 * صلاحية الدور + مفتاح التطبيق + الباقة، ثم نطاق الرؤية (فرع/منشئ/فترة) على كل قائمة.
 */
export class AccountingUseCases {
  constructor(
    private readonly guard: AccountingAccess,
    private readonly dataScope: DataScopeService,
    private readonly periods: PeriodResolver,
    private readonly repo: AccountingRepository,
  ) {}

  private load(userId: number) {
    return this.guard.load(userId);
  }

  private assertSection(key: AccountingSectionKey, ctx: AccessContext) {
    this.guard.assertSection(key, ctx);
  }

  async sections(userId: number): Promise<{ groups: AccountingGroup[] }> {
    const { ctx } = await this.load(userId);
    return { groups: resolveAccountingSections(ctx) };
  }

  /** الفترة + قيود النطاق لهذا المستخدم */
  private async scopes(user: User, permissions: Set<string>, periodKey: string | undefined) {
    const state = await this.dataScope.state(user, permissions);
    const [creatorIds, node, period] = await Promise.all([
      this.dataScope.accessibleUserIds(user, permissions, state),
      this.dataScope.headerBranchNode(user, state),
      this.periods.resolve(periodKey),
    ]);
    const branchIds = await this.dataScope.branchFilterIds(node);
    const scope: RecordScope = { branchIds, creatorIds, periodIds: period.periodIds };
    return { scope, period, state };
  }

  private periodDto(p: ResolvedPeriod): PeriodDTO {
    return { key: p.key, label: p.label, isDefault: p.isDefault, unconfigured: p.unconfigured, from: p.from, to: p.to };
  }

  private shape<T>(result: ListResult<T>, period: ResolvedPeriod | null): AccountingListDTO<T> {
    return { items: result.items, total: result.total, page: result.page, perPage: result.perPage, totals: result.totals, period: period ? this.periodDto(period) : null };
  }

  private paging(p: ListParams) {
    return { page: clamp(p.page, 1, 100000, 1), perPage: clamp(p.perPage, 1, 50, 20), search: p.search?.trim() || undefined };
  }

  async periodOptions() {
    const { years, periods } = await this.periods.options();
    const resolved = await this.periods.resolve(undefined);
    const yearName = new Map(years.map((y) => [y.id, y.name]));

    return {
      default: resolved.key ?? 'all',
      options: [
        { key: 'all', label: 'كل الفترات', group: null as string | null },
        ...years.map((y) => ({ key: `year:${y.id}`, label: y.name, group: null as string | null })),
        ...periods.map((p) => ({ key: String(p.id), label: p.name, group: yearName.get(p.fiscalYearId) ?? null })),
      ],
    };
  }

  async overview(userId: number, periodKey?: string): Promise<{ figures: OverviewFigures; period: PeriodDTO }> {
    const { user, ctx } = await this.load(userId);
    const allowed = (key: AccountingSectionKey) => {
      const found = findAccountingItem(key);
      if (!found) return false;
      const e = evaluateItem(found.group, found.item, ctx);
      return e.visible && !e.locked;
    };

    this.assertSection('overview', ctx);
    const { scope, period, state } = await this.scopes(user, ctx.permissions, periodKey);

    const employeeIds = await this.dataScope.accessibleEmployeeIds(user, ctx.permissions, state);
    const treasuryIds = employeeIds === null ? null : await this.repo.treasuryIdsForEmployees(employeeIds);

    const figures = await this.repo.overview({
      scope,
      entryScope: scope,
      treasuryIds,
      want: { expenses: allowed('expenses'), incomes: allowed('incomes'), entries: allowed('journal'), treasuries: allowed('treasuries') },
    });

    return { figures, period: this.periodDto(period) };
  }

  async list(userId: number, section: AccountingSectionKey, params: ListParams): Promise<AccountingListDTO<unknown>> {
    const { user, ctx } = await this.load(userId);
    this.assertSection(section, ctx);

    const paging = this.paging(params);

    // الأقسام بلا قيد فترة/منشئ (شجرة الحسابات ومراكز التكلفة) كما في الويب
    if (section === 'chart') return this.shape(await this.repo.chartAccounts({ ...paging, type: params.type, parentId: params.parentId }), null);
    if (section === 'cost_centers') return this.shape(await this.repo.costCenters(paging), null);

    if (section === 'treasuries') {
      const state = await this.dataScope.state(user, ctx.permissions);
      const employeeIds = await this.dataScope.accessibleEmployeeIds(user, ctx.permissions, state);
      const treasuryIds = employeeIds === null ? null : await this.repo.treasuryIdsForEmployees(employeeIds);
      const kind = params.kind === 'bank' || params.kind === 'cash' ? params.kind : undefined;
      const active = params.state === 'active' ? true : params.state === 'inactive' ? false : undefined;
      return this.shape(await this.repo.treasuries({ ...paging, treasuryIds, kind, active }), null);
    }

    const { scope, period } = await this.scopes(user, ctx.permissions, params.period);

    switch (section) {
      case 'expenses': {
        const state = params.state === 'reversed' || params.state === 'all' ? params.state : 'active';
        return this.shape(await this.repo.expenses(scope, { ...paging, state }), period);
      }
      case 'incomes': {
        const state = params.state === 'cancelled' || params.state === 'all' ? params.state : 'active';
        // «عرض سندات قبض العملاء المسنَدين إليه» — يضيف سندات عملائه إلى سنداته وسندات فريقه (عرضٌ لا تعديل)
        const assignedClientIds =
          scope.creatorIds && user.employeeId && ctx.permissions.has('account.incomes.view_assigned_clients') ? await this.repo.assignedClientIds(user.employeeId) : undefined;
        return this.shape(await this.repo.incomes(scope, { ...paging, state, assignedClientIds }), period);
      }
      case 'journal': {
        const status = params.status === '0' ? 0 : params.status === '1' ? 1 : undefined;
        return this.shape(await this.repo.journalEntries(scope, { ...paging, status }), period);
      }
      case 'payable_cheques':
        return this.shape(await this.repo.payableCheques(scope, { ...paging, status: params.status || undefined }), period);
      case 'received_cheques':
        return this.shape(await this.repo.receivedCheques(scope, { ...paging, status: params.status || undefined }), period);
      case 'cheque_books':
        return this.shape(await this.repo.chequeBooks(scope, paging), period);
      default:
        throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');
    }
  }
}
