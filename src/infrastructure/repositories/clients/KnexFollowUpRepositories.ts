import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import {
  CurrentLocation,
  ForgottenVisitRepository,
  ForgottenVisitRow,
  JustificationPeriodRow,
  JustificationRepository,
  JustificationRow,
  NotificationDetailRow,
  NotificationThreadRepository,
  StatusRequestRow,
  ThreadNotification,
  TrackingPoint,
  TrackingRepository,
} from '../../../domain/repositories/followup';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';
import { mapVisit } from './KnexVisitRepository';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const count = (r: unknown) => Number((r as { c?: number } | undefined)?.c ?? 0);

// ═══════════════════════ الزيارات المنسيّة ═══════════════════════

export class KnexForgottenVisitRepository implements ForgottenVisitRepository {
  constructor(private readonly db: Knex) {}

  /** `Visit::openWorkspaceVisit()` + تعريف «المنسيّة» في لوحة زيارات الويب */
  private query(threshold: string, today: string) {
    return this.db('visits as v')
      .leftJoin('users as u', 'u.id', 'v.employee_id')
      .leftJoin('clients as c', 'c.id', 'v.client_id')
      .whereNull('v.departure_time')
      .where((q) => q.whereNull('v.stage').orWhereNotIn('v.stage', ['completed', 'cancelled']))
      .where((q) => q.whereNotNull('v.started_at').orWhere('v.recording_method', 'manual'))
      .where((q) =>
        q
          .where((s) => s.whereNotNull('v.started_at').where('v.started_at', '<', threshold))
          .orWhere((n) => n.whereNull('v.started_at').whereRaw('DATE(v.visit_date) < ?', [today])),
      )
      .select('v.*', 'u.name as employee_name', 'c.trade_name as client_name', 'c.code as client_code');
  }

  private map(r: Record<string, unknown>): ForgottenVisitRow {
    return { ...mapVisit(r), clientName: str(r.client_name), clientCode: str(r.client_code) };
  }

  async list(threshold: string, today: string, userIds: number[] | null, limit: number) {
    const q = this.query(threshold, today);
    if (userIds !== null) q.whereIn('v.employee_id', userIds.length ? userIds : [0]);
    return (await q.orderBy('v.started_at').limit(limit)).map((r: Record<string, unknown>) => this.map(r));
  }

  async find(id: number, threshold: string, today: string) {
    const r = await this.query(threshold, today).where('v.id', id).first();
    return r ? this.map(r) : null;
  }

  /** `$user->hasRole([...])` — أدوار Spatie */
  async usersWithRoleNames(roles: string[]): Promise<number[]> {
    const ids = await this.db('model_has_roles as mr').join('roles as r', 'r.id', 'mr.role_id').where('mr.model_type', 'like', '%User').whereIn('r.name', roles).pluck('mr.model_id');
    return ids.map(Number);
  }
}

// ═══════════════════════ التبريرات ═══════════════════════

export class KnexJustificationRepository implements JustificationRepository {
  constructor(private readonly db: Knex) {}

  private base(userId: number) {
    return this.db('employee_client_visits as e')
      .leftJoin('clients as c', 'c.id', 'e.client_id')
      .leftJoin('users as a', 'a.id', 'e.approved_by')
      .where('e.employee_id', userId)
      .select('e.*', 'c.trade_name as client_name', 'c.code as client_code', 'a.name as approver_name');
  }

  /** `excludePeriodCoveredDates()` — فترات التبرير المعتمدة تغطّي زياراتها */
  private excludeCovered(q: Knex.QueryBuilder) {
    q.whereNotExists(
      this.db('visit_justifications as j')
        .select(this.db.raw('1'))
        .whereRaw('j.employee_id = e.employee_id')
        .whereRaw('j.client_id = e.client_id')
        .where('j.status', 1)
        .whereRaw('j.date_from <= e.visit_date')
        .whereRaw('j.date_to >= e.visit_date'),
    );
  }

  private beforeToday(q: Knex.QueryBuilder, today: string) {
    q.where((w) => w.where((s) => s.whereNotNull('e.visit_date').where('e.visit_date', '<', today)).orWhereNull('e.visit_date'));
  }

  private map(r: Record<string, unknown>): JustificationRow {
    return {
      id: Number(r.id),
      employeeId: Number(r.employee_id),
      clientId: Number(r.client_id),
      visitDate: str(r.visit_date)?.slice(0, 10) ?? null,
      dayOfWeek: str(r.day_of_week),
      justification: str(r.justification),
      justificationDate: str(r.justification_date),
      justificationApproved: num(r.justification_approved),
      approvedBy: str(r.approver_name),
      client: r.client_name !== null && r.client_name !== undefined ? { id: Number(r.client_id), tradeName: str(r.client_name), code: str(r.client_code) } : null,
    };
  }

  /** `needingJustificationQuery()` */
  async needing(userId: number, today: string, ids: number[] | null = null, limit = 200) {
    const q = this.base(userId)
      .where('e.status', 'unactive')
      .where((w) => w.whereNull('e.justification').orWhere('e.justification', ''));
    this.beforeToday(q, today);
    this.excludeCovered(q);
    if (ids !== null) q.whereIn('e.id', ids.length ? ids : [0]);
    const rows = await q.orderBy('e.visit_date', 'desc').orderBy('e.id', 'desc').limit(limit);
    return rows.map((r: Record<string, unknown>) => this.map(r));
  }

  /** `pendingApprovalQuery()` */
  async awaitingApprovalCount(userId: number, today: string) {
    const q = this.db('employee_client_visits as e')
      .where('e.employee_id', userId)
      .whereNotNull('e.justification')
      .where('e.justification', '!=', '')
      .where((w) => w.whereNull('e.justification_approved').orWhere('e.justification_approved', 0));
    this.beforeToday(q, today);
    this.excludeCovered(q);
    return count(await q.count({ c: 'e.id' }).first());
  }

  async submitted(userId: number, page: number, perPage: number) {
    const where = (q: Knex.QueryBuilder) => q.where('e.employee_id', userId).whereNotNull('e.justification').where('e.justification', '!=', '');
    const total = count(await where(this.db('employee_client_visits as e')).count({ c: 'e.id' }).first());
    if (!total) return { rows: [], total };
    const rows = await where(this.base(userId)).orderBy('e.justification_date', 'desc').orderBy('e.id', 'desc').limit(perPage).offset((page - 1) * perPage);
    return { rows: rows.map((r: Record<string, unknown>) => this.map(r)), total };
  }

  async periods(userId: number, limit: number): Promise<JustificationPeriodRow[]> {
    const rows = await this.db('visit_justifications as j')
      .leftJoin('clients as c', 'c.id', 'j.client_id')
      .where('j.employee_id', userId)
      .orderBy('j.date_from', 'desc')
      .limit(limit)
      .select('j.id', 'j.date_from', 'j.date_to', 'j.status', 'j.reason', 'c.trade_name');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      client: str(r.trade_name),
      dateFrom: str(r.date_from)?.slice(0, 10) ?? null,
      dateTo: str(r.date_to)?.slice(0, 10) ?? null,
      status: (r.status as number | string | null) ?? null,
      reason: str(r.reason),
    }));
  }

  async own(userId: number, id: number) {
    const r = await this.base(userId).where('e.id', id).first();
    return r ? this.map(r) : null;
  }

  async update(id: number, values: Record<string, unknown>, tx?: Tx) {
    await conn(this.db, tx)('employee_client_visits').where('id', id).update(values);
  }

  async managerIds(): Promise<number[]> {
    return (await this.db('users').whereIn('role', ['admin', 'manager']).pluck('id')).map(Number);
  }
}

// ═══════════════════════ الإشعار وردوده ═══════════════════════

export class KnexNotificationThreadRepository implements NotificationThreadRepository {
  private since: { value: string | null; at: number } | null = null;

  constructor(private readonly db: Knex) {}

  async visible(id: number, userId: number): Promise<NotificationDetailRow | null> {
    const r = await this.db('notifications as n')
      .leftJoin('users as s', 's.id', 'n.user_id')
      .leftJoin('users as r', 'r.id', 'n.receiver_id')
      .leftJoin('clients as c', 'c.id', 'n.client_id')
      .where('n.id', id)
      .where((q) => q.where('n.user_id', userId).orWhere('n.receiver_id', userId))
      .first('n.*', 's.name as sender_name', 'r.name as receiver_name', 'c.trade_name as client_name');
    if (!r) return null;
    return {
      id: Number(r.id),
      title: str(r.title),
      description: str(r.description),
      type: str(r.type),
      read: bool(r.read),
      userId: num(r.user_id),
      receiverId: num(r.receiver_id),
      clientId: num(r.client_id),
      isScheduled: bool(r.is_scheduled),
      scheduledAt: str(r.scheduled_at),
      createdAt: str(r.created_at),
      from: r.user_id && r.sender_name !== null ? { id: Number(r.user_id), name: String(r.sender_name) } : null,
      to: r.receiver_id && r.receiver_name !== null ? { id: Number(r.receiver_id), name: String(r.receiver_name) } : null,
      client: r.client_id && r.client_name !== null ? { id: Number(r.client_id), tradeName: str(r.client_name) } : null,
    };
  }

  async markRead(id: number, now: string) {
    await this.db('notifications').where('id', id).update({ read: 1, updated_at: now });
  }

  /** مخزَّنٌ ساعةً — كما في تكامل لارافل */
  async linkedRepliesSince(): Promise<string | null> {
    if (this.since && Date.now() - this.since.at < 3_600_000) return this.since.value;
    const r = await this.db('notifications').where('type', 'reply').whereNotNull('parent_id').min({ m: 'created_at' }).first();
    this.since = { value: str((r as { m?: unknown } | undefined)?.m), at: Date.now() };
    return this.since.value;
  }

  private replies() {
    return this.db('notifications as n').leftJoin('users as u', 'u.id', 'n.user_id').select('n.id', 'n.description', 'n.created_at', 'u.name as from_name');
  }

  private mapReply = (r: Record<string, unknown>) => ({ id: Number(r.id), description: str(r.description), from: str(r.from_name), createdAt: str(r.created_at) });

  async linkedReplies(parentId: number) {
    return (await this.replies().where('n.parent_id', parentId).orderBy('n.created_at').orderBy('n.id')).map(this.mapReply);
  }

  async repliesByIds(ids: number[]) {
    if (!ids.length) return [];
    return (await this.replies().whereIn('n.id', ids).orderBy('n.created_at').orderBy('n.id')).map(this.mapReply);
  }

  /** ردٌّ قديمٌ بلا رابطٍ قد يخصّ هذا الإشعار؟ — شرط «مجموعة المرشَّحين» نفسه */
  async legacyReplyPossible(row: ThreadNotification, titles: string[]): Promise<boolean> {
    const q = this.db('notifications')
      .where('type', 'reply')
      .whereNull('parent_id')
      .where('created_at', '>=', row.createdAt ?? '1970-01-01 00:00:00')
      .where((w) => {
        if (row.clientId) w.where('client_id', row.clientId);
        w.orWhere((loose) =>
          loose.whereNull('client_id').where((m) => {
            m.whereIn('title', titles.length ? titles : ['']);
            if (row.receiverId) {
              m.orWhere((a) => a.where('user_id', row.userId ?? 0).where('receiver_id', row.receiverId!)).orWhere((b) => b.where('user_id', row.receiverId!).where('receiver_id', row.userId ?? 0));
            }
          }),
        );
      });
    return Boolean(await q.first('id'));
  }

  private mapThread = (r: Record<string, unknown>): ThreadNotification => ({
    id: Number(r.id),
    title: str(r.title),
    description: str(r.description),
    clientId: num(r.client_id),
    userId: num(r.user_id),
    receiverId: num(r.receiver_id),
    createdAt: str(r.created_at),
    parentId: num(r.parent_id),
  });

  async allReplies() {
    const rows = await this.db('notifications').where('type', 'reply').orderBy('created_at').orderBy('id').select('id', 'title', 'client_id', 'user_id', 'receiver_id', 'created_at', 'parent_id');
    return rows.map(this.mapThread);
  }

  async threadOriginals(o: { titles: string[]; clientIds: number[]; repliers: number[]; addressees: number[] }) {
    const rows = await this.db('notifications')
      .where((q) => q.whereNull('type').orWhere('type', '!=', 'reply'))
      .where((q) => {
        q.whereIn('title', o.titles.length ? o.titles : ['']);
        if (o.clientIds.length) q.orWhereIn('client_id', o.clientIds);
        if (o.repliers.length) q.orWhere((p) => p.whereIn('receiver_id', o.repliers).whereIn('user_id', o.addressees));
      })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .select('id', 'title', 'client_id', 'user_id', 'receiver_id', 'created_at', 'description');
    return rows.map(this.mapThread);
  }

  async statusRequests(clientId: number): Promise<StatusRequestRow[]> {
    const rows = await this.db('client_status_requests').where('client_id', clientId).orderBy('id');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      clientId: Number(r.client_id),
      requestedBy: Number(r.requested_by),
      oldStatusId: num(r.old_status_id),
      newStatusId: num(r.new_status_id),
      status: str(r.status),
      approvedBy: num(r.approved_by),
      notes: str(r.notes),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    }));
  }

  async statusNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const rows = await this.db('statuses').whereIn('id', ids).select('id', 'name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name ?? '')]));
  }

  async userNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const rows = await this.db('users').whereIn('id', ids).select('id', 'name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name ?? '')]));
  }
}

// ═══════════════════════ تتبّع الموقع ═══════════════════════

export class KnexTrackingRepository implements TrackingRepository {
  constructor(private readonly db: Knex) {}

  async lastPoint(userId: number, tx: Tx): Promise<TrackingPoint | null> {
    const r = await conn(this.db, tx)('employee_tracking').where('employee_id', userId).orderBy('created_at', 'desc').orderBy('id', 'desc').first();
    return r ? { latitude: Number(r.latitude), longitude: Number(r.longitude), trackingDate: String(r.tracking_date).slice(0, 10), createdAt: String(r.created_at) } : null;
  }

  async insertPoint(userId: number, p: TrackingPoint, tx: Tx) {
    await conn(this.db, tx)('employee_tracking').insert({ employee_id: userId, latitude: p.latitude, longitude: p.longitude, tracking_date: p.trackingDate, created_at: p.createdAt, updated_at: p.createdAt });
  }

  async saveCurrent(userId: number, latitude: number, longitude: number, now: string, tx: Tx) {
    const db = conn(this.db, tx);
    const row = await db('locations').where('employee_id', userId).whereNull('client_id').whereNull('client_relation_id').orderBy('id').first('id');
    if (row) await db('locations').where('id', row.id).update({ latitude, longitude, updated_at: now });
    else await db('locations').insert({ employee_id: userId, client_id: null, client_relation_id: null, latitude, longitude, created_at: now, updated_at: now });
  }

  async path(userId: number, date: string) {
    const rows = await this.db('employee_tracking').where('employee_id', userId).where('tracking_date', date).orderBy('created_at').orderBy('id').select('latitude', 'longitude', 'tracking_date', 'created_at');
    return rows.map((r: Record<string, unknown>) => ({ latitude: Number(r.latitude), longitude: Number(r.longitude), trackingDate: String(r.tracking_date).slice(0, 10), createdAt: String(r.created_at) }));
  }

  private located() {
    return this.db('locations').whereNotNull('employee_id').whereNull('client_id').whereNotNull('latitude').whereNotNull('longitude').where('latitude', '!=', 0);
  }

  private map = (r: Record<string, unknown>): CurrentLocation => ({ employeeId: Number(r.employee_id), latitude: Number(r.latitude), longitude: Number(r.longitude), updatedAt: str(r.updated_at) });

  async current(userId: number) {
    const r = await this.located().where('employee_id', userId).orderBy('updated_at', 'desc').first('employee_id', 'latitude', 'longitude', 'updated_at');
    return r ? this.map(r) : null;
  }

  async team(since: string, userIds: number[] | null) {
    const q = this.located().where('updated_at', '>=', since);
    if (userIds !== null) q.whereIn('employee_id', userIds.length ? userIds : [0]);
    const rows = await q.orderBy('updated_at', 'desc').select('employee_id', 'latitude', 'longitude', 'updated_at');
    const seen = new Set<number>();
    return rows.map(this.map).filter((l: CurrentLocation) => (seen.has(l.employeeId) ? false : (seen.add(l.employeeId), true)));
  }

  async userNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const rows = await this.db('users').whereIn('id', ids).select('id', 'name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name ?? '')]));
  }
}
