import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { NamedOption } from '../../../domain/repositories/clients';
import { DescribedClient, ItineraryRepository, ItineraryRow } from '../../../domain/repositories/visits';
import { conn } from '../../db/KnexUnitOfWork';
import { constrainClientTree } from './KnexClientRepository';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function mapRow(r: Record<string, unknown>): ItineraryRow {
  return {
    id: Number(r.id),
    employeeId: Number(r.employee_id),
    clientId: Number(r.client_id),
    addedBy: num(r.added_by),
    visitDate: str(r.visit_date),
    plannedTime: str(r.planned_time),
    dayOfWeek: str(r.day_of_week),
    year: num(r.year),
    weekNumber: num(r.week_number),
    sequence: num(r.sequence),
    status: str(r.status),
    visitStatus: str(r.visit_status) || null,
    startedAt: str(r.started_at),
    completedAt: str(r.completed_at),
  };
}

/** «خط سيري اليومي» — صفوف `employee_client_visits` ليومٍ واحد ومُنتقي الإضافة */
export class KnexItineraryRepository implements ItineraryRepository {
  constructor(private readonly db: Knex) {}

  private day(userId: number, date: string, db: Knex = this.db) {
    return db('employee_client_visits').where('employee_id', userId).whereRaw('DATE(visit_date) = ?', [date]);
  }

  async dayRows(userId: number, date: string): Promise<ItineraryRow[]> {
    const rows = await this.day(userId, date).orderByRaw('sequence IS NULL').orderBy('sequence').orderBy('id').select('*');
    return rows.map(mapRow);
  }

  async row(id: number): Promise<ItineraryRow | null> {
    const r = await this.db('employee_client_visits').where('id', id).first();
    return r ? mapRow(r) : null;
  }

  async describeClients(ids: number[]): Promise<Map<number, DescribedClient>> {
    const out = new Map<number, DescribedClient>();
    const unique = [...new Set(ids)];
    if (!unique.length) return out;

    const [clients, coords, lastVisits] = await Promise.all([
      this.db('clients as c')
        .leftJoin('statuses as s', 's.id', 'c.status_id')
        .whereIn('c.id', unique)
        .select('c.id', 'c.trade_name', 'c.first_name', 'c.last_name', 'c.code', 'c.tree_node_id', 'c.branch_id', 's.name as status_name', 's.color as status_color', 'c.status_id'),
      this.db('locations').whereIn('client_id', unique).whereNull('client_relation_id').whereNotNull('latitude').whereNotNull('longitude').orderBy('id', 'desc').select('client_id', 'latitude', 'longitude'),
      this.db('visits').whereIn('client_id', unique).groupBy('client_id').select('client_id', this.db.raw('MAX(visit_date) AS last_visit')),
    ]);

    const coordMap = new Map<number, { lat: number; lng: number }>();
    for (const l of coords as Record<string, unknown>[]) {
      const cid = Number(l.client_id);
      if (!coordMap.has(cid)) coordMap.set(cid, { lat: Number(l.latitude), lng: Number(l.longitude) });
    }
    const lastMap = new Map((lastVisits as Record<string, unknown>[]).map((v) => [Number(v.client_id), str(v.last_visit)]));

    for (const c of clients as Record<string, unknown>[]) {
      const id = Number(c.id);
      const trade = str(c.trade_name);
      const name = trade && trade.trim() !== '' ? trade : `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || `#${id}`;
      const loc = coordMap.get(id);
      out.set(id, {
        id,
        name,
        code: String(c.code ?? ''),
        status: c.status_id && c.status_name !== null ? { name: String(c.status_name), color: str(c.status_color) } : null,
        nodeId: num(c.tree_node_id) || num(c.branch_id),
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null,
        lastVisit: lastMap.get(id)?.slice(0, 10) ?? null,
      });
    }
    return out;
  }

  async clientContacts(ids: number[]) {
    const rows = ids.length ? await this.db('clients').whereIn('id', ids).select('id', 'phone', 'mobile', 'city', 'street1') : [];
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), { phone: str(r.phone), mobile: str(r.mobile), city: str(r.city), street1: str(r.street1) }]));
  }

  /** `Visit::startedWorkspaceClientIdsFor()` */
  async startedWorkspaceClientIds(userId: number, today: string): Promise<number[]> {
    const ids = await this.db('visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .whereNotNull('started_at')
      .whereNull('departure_time')
      .where((q) => q.whereNull('stage').orWhere('stage', '!=', 'cancelled'))
      .pluck('client_id');
    return [...new Set(ids.map(Number))];
  }

  async recentNotes(clientId: number, limit: number) {
    const rows = await this.db('client_relations').where('client_id', clientId).orderBy('id', 'desc').limit(limit).select('description', 'attachments', 'created_at');
    return rows.map((r: Record<string, unknown>) => ({ description: str(r.description), attachments: str(r.attachments), createdAt: str(r.created_at) }));
  }

  /** «في المسار» — زيارةٌ لم تنتهِ ولم تُلغَ ذلك اليوم (`openClientIds()`) */
  async openClientIds(userId: number, date: string): Promise<number[]> {
    const ids = await this.day(userId, date)
      .where((q) => q.whereNull('visit_status').orWhereNotIn('visit_status', ['completed', 'cancelled']))
      .where((q) => q.whereNotNull('visit_status').orWhere('status', '!=', 'active'))
      .pluck('client_id');
    return [...new Set(ids.map(Number))];
  }

  async countDay(userId: number, date: string, tx?: Tx): Promise<number> {
    const r = await this.day(userId, date, conn(this.db, tx)).count<{ c: number }[]>({ c: 'id' }).first();
    return Number((r as { c?: number } | undefined)?.c ?? 0);
  }

  async existsOnDay(userId: number, date: string, clientId: number): Promise<boolean> {
    return Boolean(await this.day(userId, date).where('client_id', clientId).first('id'));
  }

  /** `ItineraryWeekService::isLocked()` — بلا فحص الإعداد (يفحصه المستدعي) */
  async isDayStarted(userId: number, year: number, week: number, day: string): Promise<boolean> {
    const r = await this.db('employee_client_visits')
      .where({ employee_id: userId, year, week_number: week, day_of_week: day })
      .whereIn('visit_status', ['started', 'completed'])
      .first('id');
    return Boolean(r);
  }

  /** `renumberDay()` — يرقّم صفوف اليوم 1..n بترتيب العرض ويُعيد n */
  async renumberDay(userId: number, date: string, tx: Tx): Promise<number> {
    const db = conn(this.db, tx);
    const rows = await this.day(userId, date, db).orderByRaw('sequence IS NULL').orderBy('sequence').orderBy('id').select('id', 'sequence');
    for (let i = 0; i < rows.length; i++) {
      if (Number(rows[i].sequence) !== i + 1) await db('employee_client_visits').where('id', rows[i].id).update({ sequence: i + 1 });
    }
    return rows.length;
  }

  async insertRow(values: Record<string, unknown>, tx?: Tx): Promise<number> {
    const [id] = await conn(this.db, tx)('employee_client_visits').insert(values);
    return Number(id);
  }

  async updateRow(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void> {
    await conn(this.db, tx)('employee_client_visits').where('id', id).update(values);
  }

  /** `ItineraryWeekService::assignedClientIds()` — عبر `users.employee_id` */
  async assignedClientIds(userId: number): Promise<number[]> {
    const u = await this.db('users').where('id', userId).first('employee_id');
    if (!u?.employee_id) return [];
    return [...new Set((await this.db('client_employee').where('employee_id', u.employee_id).pluck('client_id')).map(Number))];
  }

  /** موظفو عُقَد: فرعُ ملفّ الموظف أولاً، وإن خلا فـ`users.branch_id` — `constrainUsersToNodes()` */
  private inNodes(q: Knex.QueryBuilder, nodeIds: number[]) {
    const db = this.db;
    q.where((w) =>
      w
        .whereIn('users.employee_id', db('employees').whereNull('deleted_at').whereIn('branch_id', nodeIds.length ? nodeIds : [0]).select('id'))
        .orWhere((u) => u.whereIn('users.branch_id', nodeIds.length ? nodeIds : [0]).whereIn('users.employee_id', db('employees').whereNull('deleted_at').whereNull('branch_id').select('id'))),
    );
  }

  private inDepartments(q: Knex.QueryBuilder, departmentIds: number[]) {
    if (!departmentIds.length) return;
    q.whereIn('users.employee_id', this.db('employees').whereNull('deleted_at').whereIn('department_id', departmentIds).select('id'));
  }

  async employeeOptions(opts: { scopeUserIds: number[] | null; headerNodeIds: number[] | null; departmentIds: number[]; excludeUserId: number }): Promise<NamedOption[]> {
    const q = this.db('users').whereNotNull('users.employee_id').whereNot('users.id', opts.excludeUserId);
    this.inDepartments(q, opts.departmentIds);
    if (opts.scopeUserIds !== null) q.whereIn('users.id', opts.scopeUserIds.length ? opts.scopeUserIds : [0]);
    if (opts.headerNodeIds !== null) this.inNodes(q, opts.headerNodeIds);
    const rows = await q.orderBy('users.name').select('users.id', 'users.name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async usersWithEmployees(ids: number[]): Promise<NamedOption[]> {
    if (!ids.length) return [];
    const rows = await this.db('users').whereIn('id', ids).whereNotNull('employee_id').orderBy('name').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async userInDepartments(userId: number, departmentIds: number[]): Promise<boolean> {
    const q = this.db('users').where('users.id', userId);
    this.inDepartments(q, departmentIds);
    return Boolean(await q.first('users.id'));
  }

  async userInNodes(userId: number, nodeIds: number[]): Promise<boolean> {
    const q = this.db('users').where('users.id', userId);
    this.inNodes(q, nodeIds);
    return Boolean(await q.first('users.id'));
  }

  async employeeBranchIds(employeeId: number): Promise<number[]> {
    const rows = await this.db('employee_branch').where('employee_id', employeeId).pluck('branch_id');
    return [...new Set(rows.map(Number).filter(Boolean))];
  }

  async userName(id: number): Promise<string | null> {
    const r = await this.db('users').where('id', id).first('name');
    return r ? String(r.name ?? '') : null;
  }

  async userExists(id: number): Promise<boolean> {
    return Boolean(await this.db('users').where('id', id).first('id'));
  }

  private scoped(constraints: number[][]) {
    const q = this.db('clients');
    for (const ids of constraints) constrainClientTree(this.db, q, ids);
    return q;
  }

  async pickerClients(constraints: number[][], term: string, limit: number) {
    const q = this.scoped(constraints);
    if (term) {
      const like = likeTerm(term);
      q.where((w) => w.where('clients.trade_name', 'like', like).orWhere('clients.code', 'like', like).orWhere('clients.first_name', 'like', like).orWhere('clients.last_name', 'like', like));
    }
    const countRow = await q.clone().count<{ c: number }[]>({ c: 'clients.id' }).first();
    const ids = await q.orderBy('clients.trade_name').limit(limit).pluck('clients.id');
    return { ids: ids.map(Number), total: Number((countRow as { c?: number } | undefined)?.c ?? 0) };
  }

  async clientsWithin(constraints: number[][], ids: number[]): Promise<number[]> {
    if (!ids.length) return [];
    return (await this.scoped(constraints).whereIn('clients.id', ids).pluck('clients.id')).map(Number);
  }
}
