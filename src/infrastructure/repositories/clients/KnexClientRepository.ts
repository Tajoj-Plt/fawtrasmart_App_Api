import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import {
  ClientContactRow,
  ClientExtras,
  ClientListFilters,
  ClientRepository,
  ClientRow,
  ClientScope,
  LedgerParent,
  NamedOption,
} from '../../../domain/repositories/clients';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

/** `addcslashes($term, '%_\\')` — حروف LIKE الخاصة تُطابَق حرفياً */
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** حسابات المحافظ لا تدخل «المستحق» — `Account::scopeLedger()` */
const WALLETS = ['client_wallet', 'supplier_wallet'];
function ledger(q: Knex.QueryBuilder, alias = 'accounts') {
  q.where((w) => w.whereNull(`${alias}.type_accont`).orWhereNotIn(`${alias}.type_accont`, WALLETS));
}

function mapClient(r: Record<string, unknown>): ClientRow {
  return {
    id: Number(r.id),
    code: str(r.code),
    tradeName: str(r.trade_name),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    phone: str(r.phone),
    mobile: str(r.mobile),
    email: str(r.email),
    statusId: num(r.status_id),
    registrationStageId: num(r.registration_stage_id),
    categoryId: num(r.category_id),
    branchId: num(r.branch_id),
    treeNodeId: num(r.tree_node_id),
    clientType: num(r.client_type),
    taxNumber: str(r.tax_number),
    commercialRegistration: str(r.commercial_registration),
    currency: str(r.currency),
    printingMethod: num(r.printing_method),
    itemQuantityLimit: num(r.item_quantity_limit),
    creditLimit: num(r.credit_limit),
    notes: str(r.notes),
    street1: str(r.street1),
    street2: str(r.street2),
    city: str(r.city),
    region: str(r.region),
    postalCode: str(r.postal_code),
    country: str(r.country),
    attachments: str(r.attachments),
    exemptVisitLocation: bool(r.exempt_visit_location),
    createdAt: str(r.created_at),
  };
}

/** `AffiliationTree::constrainClients()` — التبعيّة الصريحة أوّلاً، والأعمدة القديمة لمن لا تبعيّة له */
export function constrainClientTree(db: Knex, q: Knex.QueryBuilder, ids: number[]) {
  if (!ids.length) {
    q.whereRaw('0 = 1');
    return;
  }
  q.where((w) => {
    w.whereIn('clients.tree_node_id', ids).orWhere((legacy) => {
      legacy.whereNull('clients.tree_node_id').where((any) => {
        any.whereIn('clients.branch_id', ids).orWhereExists(
          db('neighborhoods as n').select(db.raw('1')).whereRaw('n.client_id = clients.id').whereIn('n.region_id', ids),
        );
      });
    });
  });
}

/** العملاء — استعلامات شاشة «إدارة العملاء» وكتاباتها بجداول الويب نفسها */
export class KnexClientRepository implements ClientRepository {
  constructor(private readonly db: Knex) {}

  // ═══════════════════════ النطاق والفلاتر ═══════════════════════

  private constrainTree(q: Knex.QueryBuilder, ids: number[]) {
    constrainClientTree(this.db, q, ids);
  }

  private applyScope(q: Knex.QueryBuilder, scope: ClientScope) {
    switch (scope.kind) {
      case 'none':
        q.whereRaw('1 = 0');
        return;
      case 'all':
        return;
      case 'tree':
        this.constrainTree(q, scope.nodeIds);
        return;
      case 'ids':
        if (scope.ids.length) q.whereIn('clients.id', scope.ids);
        else q.whereRaw('1 = 0');
        return;
      case 'regions':
        // `whereHas('neighborhood.Region', whereIn('id', …))`
        q.whereExists(
          this.db('neighborhoods as n')
            .select(this.db.raw('1'))
            .join('branches as rg', 'rg.id', 'n.region_id')
            .whereRaw('n.client_id = clients.id')
            .whereIn('rg.id', scope.groupIds.length ? scope.groupIds : [0]),
        );
    }
  }

  /** فلاتر شاشة العملاء (`applyFilters()`) + البحث بالاسم أو الكود أو الهاتف */
  private applyFilters(q: Knex.QueryBuilder, f: ClientListFilters) {
    const db = this.db;

    if (f.search) {
      const term = likeTerm(f.search.trim());
      q.where((w) => w.where('clients.trade_name', 'like', term).orWhere('clients.code', 'like', term).orWhere('clients.phone', 'like', term).orWhere('clients.mobile', 'like', term));
    }
    if (f.clientId) q.where('clients.id', f.clientId);
    if (f.name) q.where('clients.trade_name', 'like', likeTerm(f.name));
    if (f.status !== undefined) {
      if (f.status === 'no_status') q.whereNull('clients.status_id');
      else q.where('clients.status_id', f.status);
    }
    if (f.registrationStageId !== undefined) q.where('clients.registration_stage_id', f.registrationStageId);
    if (f.regionNodeIds) this.constrainTree(q, f.regionNodeIds);
    if (f.branchNodeIds) this.constrainTree(q, f.branchNodeIds);
    if (f.neighborhood) {
      const term = f.neighborhood;
      q.whereExists(
        db('neighborhoods as nb')
          .select(db.raw('1'))
          .whereRaw('nb.client_id = clients.id')
          .where((w) => w.where('nb.name', 'like', likeTerm(term)).orWhere('nb.id', Math.trunc(Number(term)) || 0)),
      );
    }
    if (f.dateFrom) q.where('clients.created_at', '>=', `${f.dateFrom} 00:00:00`);
    if (f.dateTo) q.where('clients.created_at', '<=', `${f.dateTo} 23:59:59`);
    if (f.categoryId !== undefined) q.where('clients.category_id', f.categoryId);
    if (f.clientType !== undefined) q.where('clients.client_type', f.clientType);
    if (f.employeeId !== undefined) q.where('clients.employee_id', f.employeeId);
    if (f.overCreditLimit) {
      q.whereNotNull('clients.credit_limit')
        .where('clients.credit_limit', '>', 0)
        .whereExists(
          db('accounts')
            .select(db.raw('1'))
            .whereRaw('accounts.client_id = clients.id')
            .modify((s) => ledger(s))
            .whereRaw('accounts.balance > clients.credit_limit'),
        );
    }
    if (f.customerTarget !== undefined) {
      if (f.customerTarget === 'no_target') q.whereNull('clients.customer_target_id');
      else q.where('clients.customer_target_id', f.customerTarget);
    }
    if (f.lastInvoice) {
      const { from, to } = f.lastInvoice;
      q.whereExists(db('invoices as li').select(db.raw('1')).whereRaw('li.client_id = clients.id').whereBetween('li.invoice_date', [from, to]));
    }
    if (f.lastPayment) {
      const { from, to } = f.lastPayment;
      // `whereHas('invoices.payments')` — والعلاقة نفسها مقيَّدة بـ«دفعات العملاء»
      q.whereExists(
        db('invoices as pi')
          .select(db.raw('1'))
          .join('payments_process as pp', 'pp.invoice_id', 'pi.id')
          .whereRaw('pi.client_id = clients.id')
          .where('pp.type', 'client payments')
          .whereBetween('pp.created_at', [from, to]),
      );
    }
    if (f.lastActivity) {
      const { from, to } = f.lastActivity;
      q.whereRaw(
        `clients.id in (select client_id from (
             select invoices.client_id, invoices.invoice_date as date from invoices
             union all select invoices.client_id, payments_process.created_at as date from payments_process inner join invoices on payments_process.invoice_id = invoices.id
             union all select accounts.client_id, receipts.created_at as date from accounts inner join receipts on accounts.id = receipts.account_id
           ) as activities group by client_id having MAX(activities.date) BETWEEN ? AND ?)`,
        [from, to],
      );
    }
    if (f.excludeIds?.length) q.whereNotIn('clients.id', f.excludeIds);
    if (f.onlyIds) {
      if (f.onlyIds.length) q.whereIn('clients.id', f.onlyIds);
      else q.whereRaw('1 = 0');
    }
    if (f.withLocation) {
      // `whereHas('locations', …)` — بقيود العلاقة نفسها
      q.whereExists(
        db('locations as lc')
          .select(db.raw('1'))
          .whereRaw('lc.client_id = clients.id')
          .whereNull('lc.client_relation_id')
          .whereNotNull('lc.latitude')
          .whereNotNull('lc.longitude')
          .where('lc.latitude', '!=', 0)
          .where('lc.longitude', '!=', 0)
          .where('lc.latitude', '!=', '')
          .where('lc.longitude', '!=', ''),
      );
    }
  }

  private base(scope: ClientScope, filters: ClientListFilters) {
    const q = this.db('clients');
    this.applyScope(q, scope);
    this.applyFilters(q, filters);
    return q;
  }

  async page(scope: ClientScope, filters: ClientListFilters, page: number, perPage: number) {
    if (scope.kind === 'none') return { rows: [], total: 0 };

    const q = this.base(scope, filters);
    const countRow = await q.clone().count<{ c: number }[]>({ c: 'clients.id' }).first();
    const total = Number((countRow as { c?: number } | undefined)?.c ?? 0);
    if (!total) return { rows: [], total };

    if (filters.sort === 'name') q.orderBy('clients.trade_name');
    else q.orderBy('clients.id', 'desc');

    const rows = await q.select('clients.*').limit(perPage).offset((page - 1) * perPage);
    return { rows: rows.map(mapClient), total };
  }

  async list(scope: ClientScope, filters: ClientListFilters, limit: number): Promise<ClientRow[]> {
    if (scope.kind === 'none') return [];
    const rows = await this.base(scope, filters).select('clients.*').limit(limit);
    return rows.map(mapClient);
  }

  async find(id: number, tx?: Tx): Promise<ClientRow | null> {
    const r = await conn(this.db, tx)('clients').where('id', id).first();
    return r ? mapClient(r) : null;
  }

  async inScope(scope: ClientScope, clientId: number): Promise<boolean> {
    if (scope.kind === 'none') return false;
    const q = this.db('clients').where('clients.id', clientId);
    this.applyScope(q, scope);
    return Boolean(await q.first('clients.id'));
  }

  // ═══════════════════════ العرض ═══════════════════════

  /** `with(['status_client', 'locations', 'neighborhood', 'branch'])` */
  async extras(rows: ClientRow[]): Promise<Map<number, ClientExtras>> {
    const out = new Map<number, ClientExtras>();
    if (!rows.length) return out;

    const ids = rows.map((r) => r.id);
    const statusIds = uniq(rows.map((r) => r.statusId).filter((v): v is number => v !== null));
    const branchIds = uniq(rows.map((r) => r.branchId).filter((v): v is number => v !== null));

    const [statuses, branches, hoods, locations] = await Promise.all([
      statusIds.length ? this.db('statuses').whereIn('id', statusIds).select('id', 'name', 'color') : [],
      branchIds.length ? this.db('branches').whereIn('id', branchIds).select('id', 'name') : [],
      this.db('neighborhoods').whereIn('client_id', ids).orderBy('id').select('client_id', 'name', 'region_id'),
      // `hasOne(...)->latest()` — أحدث نقطة للعميل نفسه لا لملاحظاته
      this.db('locations')
        .whereIn('client_id', ids)
        .whereNull('client_relation_id')
        .whereNotNull('latitude')
        .whereNotNull('longitude')
        .where('latitude', '!=', 0)
        .where('longitude', '!=', 0)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .select('client_id', 'latitude', 'longitude'),
    ]);

    const statusMap = new Map((statuses as Record<string, unknown>[]).map((s) => [Number(s.id), { id: Number(s.id), name: String(s.name ?? ''), color: str(s.color) }]));
    const branchMap = new Map((branches as Record<string, unknown>[]).map((b) => [Number(b.id), { id: Number(b.id), name: String(b.name ?? '') }]));
    const hoodMap = new Map<number, { name: string; regionId: number | null }>();
    for (const h of hoods as Record<string, unknown>[]) {
      const cid = Number(h.client_id);
      if (!hoodMap.has(cid)) hoodMap.set(cid, { name: String(h.name ?? ''), regionId: num(h.region_id) });
    }
    const locMap = new Map<number, { latitude: number; longitude: number }>();
    for (const l of locations as Record<string, unknown>[]) {
      const cid = Number(l.client_id);
      if (!locMap.has(cid)) locMap.set(cid, { latitude: Number(l.latitude), longitude: Number(l.longitude) });
    }

    for (const r of rows) {
      out.set(r.id, {
        status: r.statusId !== null ? statusMap.get(r.statusId) ?? null : null,
        branch: r.branchId !== null ? branchMap.get(r.branchId) ?? null : null,
        neighborhood: hoodMap.get(r.id) ?? null,
        location: locMap.get(r.id) ?? null,
      });
    }
    return out;
  }

  /** «المستحق» — `Account::ledger()` مجموعاً لكل عميل باستعلامٍ واحد */
  async dueBalances(ids: number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    const rows = await this.db('accounts')
      .whereIn('client_id', ids)
      .modify((q) => ledger(q))
      .groupBy('client_id')
      .select('client_id', this.db.raw('SUM(balance) as total_due'));
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.client_id), Number(r.total_due ?? 0)]));
  }

  /** `Client::whereIn('id', …)->orderBy('trade_name')->get(['id','trade_name','code'])` في `ClientController::index()` */
  async briefs(ids: number[]): Promise<Array<{ id: number; tradeName: string; code: string | null }>> {
    if (!ids.length) return [];
    const rows = await this.db('clients').whereIn('id', ids).orderBy('trade_name').select('id', 'trade_name', 'code');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      tradeName: String(r.trade_name ?? ''),
      code: r.code === null || r.code === undefined || r.code === '' ? null : String(r.code),
    }));
  }

  async category(id: number | null): Promise<NamedOption | null> {
    if (!id) return null;
    const r = await this.db('categories_clients').where('id', id).first('id', 'name');
    return r ? { id: Number(r.id), name: String(r.name ?? '') } : null;
  }

  async contacts(clientId: number): Promise<ClientContactRow[]> {
    const rows = await this.db('contacts').where('client_id', clientId).orderBy('id').select('id', 'first_name', 'last_name', 'email', 'phone', 'mobile');
    return rows.map((c: Record<string, unknown>) => ({
      id: Number(c.id),
      firstName: str(c.first_name),
      lastName: str(c.last_name),
      email: str(c.email),
      phone: str(c.phone),
      mobile: str(c.mobile),
    }));
  }

  async assignedEmployees(clientId: number): Promise<NamedOption[]> {
    const rows = await this.db('client_employee as ce')
      .join('employees as e', 'e.id', 'ce.employee_id')
      .where('ce.client_id', clientId)
      .whereNull('e.deleted_at')
      .orderBy('ce.id')
      .select('e.id', 'e.first_name', 'e.middle_name');
    const seen = new Set<number>();
    return rows
      .filter((e: Record<string, unknown>) => (seen.has(Number(e.id)) ? false : (seen.add(Number(e.id)), true)))
      .map((e: Record<string, unknown>) => ({ id: Number(e.id), name: `${e.first_name ?? ''} ${e.middle_name ?? ''}`.trim() }));
  }

  // ═══════════════════════ اليوم والزيارة ═══════════════════════

  async todayVisits(userId: number, clientIds: number[], today: string) {
    if (!clientIds.length) return [];
    const rows = await this.db('visits')
      .where('employee_id', userId)
      .whereIn('client_id', clientIds)
      .whereRaw('DATE(visit_date) = ?', [today])
      .orderBy('id')
      .select('id', 'client_id', 'stage', 'departure_time');
    return rows.map((v: Record<string, unknown>) => ({ id: Number(v.id), clientId: Number(v.client_id), stage: str(v.stage), departed: v.departure_time !== null }));
  }

  async openVisitId(userId: number, clientId: number, today: string): Promise<number | null> {
    const v = await this.db('visits')
      .where('employee_id', userId)
      .where('client_id', clientId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .whereNull('departure_time')
      .orderBy('id')
      .first('id');
    return v ? Number(v.id) : null;
  }

  /** `EmployeeClientVisit::pendingItineraryClientIdsFor()` */
  async pendingItineraryClientIds(userId: number, today: string): Promise<number[]> {
    const ids = await this.db('employee_client_visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .where((q) => q.where('visit_status', '!=', 'completed').orWhereNull('visit_status'))
      .pluck('client_id');
    return uniq(ids);
  }

  /** `EmployeeClientVisit::finishedTodayClientIdsFor()` */
  async finishedTodayClientIds(userId: number, today: string): Promise<number[]> {
    const rows = await this.db('employee_client_visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .select('client_id', 'visit_status');

    const groups = new Map<number, boolean>();
    const pending = new Set<number>();
    for (const r of rows as Record<string, unknown>[]) {
      const cid = Number(r.client_id);
      const done = r.visit_status === 'completed';
      groups.set(cid, (groups.get(cid) ?? true) && done);
      if (!done) pending.add(cid);
    }
    const byItinerary = [...groups.entries()].filter(([, all]) => all).map(([cid]) => cid);

    const workspace = await this.db('visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .where('stage', 'completed')
      .pluck('client_id');
    const byWorkspace = workspace.map(Number).filter((cid: number) => !pending.has(cid));

    return uniq([...byItinerary, ...byWorkspace]);
  }

  /** `HiddenClient::getHiddenClientsForUser()` — بتنظيفَيه كما في الويب */
  async hiddenClientIds(userId: number, now: string, dayStart: string): Promise<number[]> {
    await this.db('hidden_clients').where('expires_at', '<', now).del();
    await this.db('hidden_clients').where('hidden_at', '<', dayStart).del();
    const ids = await this.db('hidden_clients').where('user_id', userId).where('hidden_at', '>=', dayStart).where('expires_at', '>', now).pluck('client_id');
    return ids.map(Number);
  }

  /** `ClientAccessService::todayItineraryClientIds()` — `employee_id` هنا هو `users.id` */
  async itineraryClientIds(userIds: number[] | null, dayNameEn: string, year: number, week: number): Promise<number[]> {
    const q = this.db('employee_client_visits').where('day_of_week', dayNameEn).where('year', year).where('week_number', week);
    if (userIds !== null) q.whereIn('employee_id', userIds.length ? userIds : [0]);
    return (await q.pluck('client_id')).map(Number);
  }

  async todayItineraryRows(userId: number, today: string) {
    const rows = await this.db('employee_client_visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .where((q) => q.whereNull('visit_status').orWhere('visit_status', '!=', 'cancelled'))
      .orderBy('id')
      .select('client_id', 'added_by');
    return rows.map((r: Record<string, unknown>) => ({ clientId: Number(r.client_id), addedBy: num(r.added_by) }));
  }

  async assignedClientIds(employeeIds: number[]): Promise<number[]> {
    if (!employeeIds.length) return [];
    return (await this.db('client_employee').whereIn('employee_id', employeeIds).pluck('client_id')).map(Number);
  }

  async employeeGroupIds(employeeIds: number[]): Promise<number[]> {
    if (!employeeIds.length) return [];
    return (await this.db('employee_group').whereIn('employee_id', employeeIds).pluck('group_id')).map(Number);
  }

  async allEmployeeIds(): Promise<number[]> {
    return (await this.db('employees').whereNull('deleted_at').pluck('id')).map(Number);
  }

  // ═══════════════════════ الكتابة ═══════════════════════

  async insert(fields: Record<string, unknown>, tx: Tx): Promise<number> {
    const row = { ...fields };
    // خطّاف `Client::saving` — الفرعُ موقعٌ تنظيميٌّ صالح حين لا تبعيّة صريحة
    if (!row.tree_node_id && row.branch_id) row.tree_node_id = Number(row.branch_id);
    const [id] = await conn(this.db, tx)('clients').insert(row);
    return Number(id);
  }

  async update(id: number, fields: Record<string, unknown>, tx: Tx): Promise<void> {
    const row = { ...fields };
    if ('tree_node_id' in row && !row.tree_node_id && row.branch_id) row.tree_node_id = Number(row.branch_id);
    await conn(this.db, tx)('clients').where('id', id).update(row);
  }

  async phoneTaken(phone: string, exceptId: number | null): Promise<boolean> {
    const q = this.db('clients').where('phone', phone);
    if (exceptId) q.whereNot('id', exceptId);
    return Boolean(await q.first('id'));
  }

  async emailTaken(email: string, exceptUserId: number | null): Promise<boolean> {
    const q = this.db('users').where('email', email);
    if (exceptUserId) q.whereNot('id', exceptUserId);
    return Boolean(await q.first('id'));
  }

  async loginUserId(clientId: number): Promise<number | null> {
    const r = await this.db('users').where('client_id', clientId).orderBy('id').first('id');
    return r ? Number(r.id) : null;
  }

  async createContact(clientId: number, values: Record<string, unknown>, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('contacts').insert({ ...values, client_id: clientId, created_at: now, updated_at: now });
  }

  /** مزامنة جهات الاتصال — المُرسَل بمعرّفه يُحدَّث، والجديد يُنشأ، وما غاب يُحذف */
  async syncContacts(clientId: number, incoming: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void> {
    const db = conn(this.db, tx);
    const existing = new Set((await db('contacts').where('client_id', clientId).pluck('id')).map(Number));
    const keep = incoming.map((c) => Number(c.id ?? 0)).filter(Boolean);

    await db('contacts').where('client_id', clientId).whereNotIn('id', keep.length ? keep : [0]).del();

    for (const contact of incoming) {
      const { id, ...values } = contact;
      const cid = Number(id ?? 0);
      if (cid && existing.has(cid)) {
        await db('contacts').where('id', cid).update({ ...values, updated_at: now });
      } else {
        await db('contacts').insert({ ...values, client_id: clientId, created_at: now, updated_at: now });
      }
    }
  }

  async replaceAssignments(clientId: number, employeeIds: number[], now: string, tx: Tx): Promise<void> {
    const db = conn(this.db, tx);
    await db('client_employee').where('client_id', clientId).del();
    for (const employeeId of uniq(employeeIds)) {
      await db('client_employee').insert({ client_id: clientId, employee_id: employeeId, created_at: now, updated_at: now });
    }
  }

  async addAssignment(clientId: number, employeeId: number, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('client_employee').insert({ client_id: clientId, employee_id: employeeId, created_at: now, updated_at: now });
  }

  /** `ClientEmployee::firstOrCreate()` */
  async ensureAssignment(clientId: number, employeeId: number, now: string, tx: Tx): Promise<void> {
    const db = conn(this.db, tx);
    const exists = await db('client_employee').where({ client_id: clientId, employee_id: employeeId }).first('id');
    if (!exists) await db('client_employee').insert({ client_id: clientId, employee_id: employeeId, created_at: now, updated_at: now });
  }

  async addLocation(clientId: number, latitude: unknown, longitude: unknown, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('locations').insert({ client_id: clientId, latitude, longitude, created_at: now, updated_at: now });
  }

  /** `$client->locations()->delete()` ثم إنشاء — الحذف مقيَّدٌ بقيود العلاقة نفسها */
  async replaceLocation(clientId: number, latitude: unknown, longitude: unknown, now: string, tx: Tx): Promise<void> {
    const db = conn(this.db, tx);
    await db('locations')
      .where('client_id', clientId)
      .whereNull('client_relation_id')
      .whereNotNull('latitude')
      .whereNotNull('longitude')
      .where('latitude', '!=', 0)
      .where('longitude', '!=', 0)
      .del();
    await db('locations').insert({ client_id: clientId, latitude, longitude, created_at: now, updated_at: now });
  }

  async neighborhood(clientId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('neighborhoods').where('client_id', clientId).orderBy('id').first('id', 'name', 'region_id');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), regionId: num(r.region_id) } : null;
  }

  async createNeighborhood(clientId: number, name: string, regionId: number, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('neighborhoods').insert({ name, region_id: regionId, client_id: clientId, created_at: now, updated_at: now });
  }

  /** `Neighborhood::updateOrCreate(['client_id' => …], …)` */
  async upsertNeighborhood(clientId: number, name: string, regionId: number, now: string, tx: Tx): Promise<void> {
    const db = conn(this.db, tx);
    const current = await db('neighborhoods').where('client_id', clientId).orderBy('id').first('id');
    if (current) await db('neighborhoods').where('id', current.id).update({ name, region_id: regionId, updated_at: now });
    else await db('neighborhoods').insert({ name, region_id: regionId, client_id: clientId, created_at: now, updated_at: now });
  }

  async createLoginUser(clientId: number, payload: { name: string; email: string; phone: string }, passwordHash: string, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('users').insert({ ...payload, role: 'client', client_id: clientId, password: passwordHash, created_at: now, updated_at: now });
  }

  async updateLoginUser(userId: number, payload: { name: string; email: string; phone: string }, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('users').where('id', userId).update({ ...payload, updated_at: now });
  }

  async ledgerAccountId(clientId: number, tx?: Tx): Promise<number | null> {
    const r = await conn(this.db, tx)('accounts').where('client_id', clientId).modify((q) => ledger(q)).orderBy('id').first('id');
    return r ? Number(r.id) : null;
  }

  /** `ensureClientLedgerAccount()` — الكود التالي تحت الحساب الأب، بتخطّي المستعمَل */
  async createLedgerAccount(clientId: number, name: string, parent: LedgerParent, now: string, tx: Tx): Promise<number> {
    const db = conn(this.db, tx);
    const nextCode = (code: string) => code.slice(0, -1) + String(Math.trunc(Number(code.slice(-1)) || 0) + 1);

    const last = await db('accounts').where('parent_id', parent.id).orderBy('code', 'desc').first('code');
    let code = last ? nextCode(String(last.code)) : `${parent.code}1`;
    while (await db('accounts').where('code', code).first('id')) code = nextCode(code);

    const [id] = await db('accounts').insert({
      name,
      client_id: clientId,
      account_type: parent.accountType,
      code,
      balance_type: 'debit',
      parent_id: parent.id,
      opening_balance: 0,
      opening_balance_type: parent.balanceType,
      is_active: 1,
      created_at: now,
      updated_at: now,
    });
    return Number(id);
  }

  async renameLedgerAccount(accountId: number, name: string, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('accounts').where('id', accountId).update({ name, updated_at: now });
  }

  async upsertItineraryRow(
    v: { employeeId: number; clientId: number; dayOfWeek: string; year: number; weekNumber: number; visitDate: string },
    now: string,
    tx: Tx,
  ): Promise<{ id: number; created: boolean }> {
    const db = conn(this.db, tx);
    const keys = { employee_id: v.employeeId, client_id: v.clientId, day_of_week: v.dayOfWeek, year: v.year, week_number: v.weekNumber };
    const existing = await db('employee_client_visits').where(keys).orderBy('id').first('id');
    if (existing) {
      await db('employee_client_visits').where('id', existing.id).update({ visit_date: v.visitDate, status: 'active', updated_at: now });
      return { id: Number(existing.id), created: false };
    }
    const [id] = await db('employee_client_visits').insert({ ...keys, visit_date: v.visitDate, status: 'active', created_at: now, updated_at: now });
    return { id: Number(id), created: true };
  }

  async clearExemptLocation(clientId: number, now: string, tx?: Tx): Promise<string | null> {
    const db = conn(this.db, tx);
    const c = await db('clients').where('id', clientId).first('exempt_visit_location', 'trade_name');
    if (!c || !bool(c.exempt_visit_location)) return null;
    await db('clients').where('id', clientId).update({ exempt_visit_location: 0, updated_at: now });
    return String(c.trade_name ?? '');
  }

  async createVisit(values: Record<string, unknown>, tx?: Tx): Promise<number> {
    const [id] = await conn(this.db, tx)('visits').insert(values);
    return Number(id);
  }

  async visitOf(visitId: number) {
    const v = await this.db('visits').where('id', visitId).first('id', 'client_id', 'visit_number', 'visit_date');
    return v ? { id: Number(v.id), clientId: Number(v.client_id), visitNumber: str(v.visit_number), visitDate: str(v.visit_date) } : null;
  }

  async setColumn(clientId: number, column: 'status_id' | 'registration_stage_id' | 'last_note_at', value: unknown, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('clients').where('id', clientId).update({ [column]: value, updated_at: now });
  }

  async insertStatusRequest(table: 'client_status_requests' | 'client_stage_requests', values: Record<string, unknown>, tx: Tx): Promise<void> {
    await conn(this.db, tx)(table).insert(values);
  }

  async invoiceBelongsTo(invoiceId: number, clientId: number): Promise<boolean> {
    return Boolean(await this.db('invoices').where('id', invoiceId).where('client_id', clientId).first('id'));
  }
}
