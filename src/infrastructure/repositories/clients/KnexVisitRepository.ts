import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { ClientNotificationRow, VisitDocument, VisitReceipt, VisitRepository, VisitRow } from '../../../domain/repositories/visits';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const WALLETS = ['client_wallet', 'supplier_wallet'];

export function mapVisit(r: Record<string, unknown>): VisitRow {
  return {
    id: Number(r.id),
    employeeId: Number(r.employee_id),
    employeeName: str(r.employee_name),
    clientId: Number(r.client_id),
    visitNumber: str(r.visit_number),
    visitDate: str(r.visit_date),
    stage: str(r.stage),
    startedAt: str(r.started_at),
    pausedAt: str(r.paused_at),
    totalPausedSeconds: Number(r.total_paused_seconds ?? 0),
    arrivalTime: str(r.arrival_time),
    departureTime: str(r.departure_time),
    outcome: str(r.outcome),
    outcomeNotes: str(r.outcome_notes),
    cancelReason: str(r.cancel_reason),
    recordingMethod: str(r.recording_method),
    clientLatitude: num(r.client_latitude),
    clientLongitude: num(r.client_longitude),
  };
}

/** مساحة عمل الزيارة — `visits` وما يُكتب أثناءها */
export class KnexVisitRepository implements VisitRepository {
  constructor(private readonly db: Knex) {}

  private visits() {
    return this.db('visits as v').leftJoin('users as u', 'u.id', 'v.employee_id').select('v.*', 'u.name as employee_name');
  }

  async find(id: number): Promise<VisitRow | null> {
    const r = await this.visits().where('v.id', id).first();
    return r ? mapVisit(r) : null;
  }

  async openToday(userId: number, clientId: number, today: string, tx?: Tx): Promise<VisitRow | null> {
    const r = await conn(this.db, tx)('visits as v')
      .leftJoin('users as u', 'u.id', 'v.employee_id')
      .select('v.*', 'u.name as employee_name').where('v.employee_id', userId).where('v.client_id', clientId).whereRaw('DATE(v.visit_date) = ?', [today]).whereNull('v.departure_time').orderBy('v.id').first();
    return r ? mapVisit(r) : null;
  }

  async startedOpenToday(userId: number, today: string): Promise<VisitRow | null> {
    const r = await this.db('visits as v')
      .leftJoin('users as u', 'u.id', 'v.employee_id')
      .select('v.*', 'u.name as employee_name')
      .where('v.employee_id', userId)
      .whereRaw('DATE(v.visit_date) = ?', [today])
      .whereNotNull('v.started_at')
      .whereNull('v.departure_time')
      .where((q) => q.whereNull('v.stage').orWhere('v.stage', '!=', 'cancelled'))
      .orderBy('v.id', 'desc')
      .first();
    return r ? mapVisit(r) : null;
  }

  async update(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void> {
    await conn(this.db, tx)('visits').where('id', id).update(values);
  }

  async updateIf(id: number, guard: 'notStarted' | 'open', values: Record<string, unknown>): Promise<boolean> {
    const q = this.db('visits').where('id', id).whereNull('departure_time');
    if (guard === 'notStarted') q.whereNull('started_at');
    return (await q.update(values)) > 0;
  }

  async lockClient(clientId: number, tx: Tx): Promise<void> {
    await conn(this.db, tx)('clients').where('id', clientId).forUpdate().first('id');
  }

  /** `EmployeeClientVisit::markStartedFor()` */
  async markStartedFor(employeeId: number, clientId: number, date: string, now: string): Promise<void> {
    await this.db('employee_client_visits')
      .where({ employee_id: employeeId, client_id: clientId })
      .whereRaw('DATE(visit_date) = ?', [date])
      .whereNull('started_at')
      .update({ visit_status: 'started', started_at: now, updated_at: now });
  }

  /** `EmployeeClientVisit::markCompletedFor()` — لا شيء ما دامت زيارة مساحة عملٍ مفتوحة */
  async markCompletedFor(employeeId: number, clientId: number, date: string, now: string, durationMinutes: number | null): Promise<void> {
    const open = await this.db('visits')
      .where({ employee_id: employeeId, client_id: clientId })
      .whereRaw('DATE(visit_date) = ?', [date])
      .whereNull('departure_time')
      .where((q) => q.where('recording_method', 'manual').orWhereNotNull('started_at'))
      .first('id');
    if (open) return;

    const update: Record<string, unknown> = { status: 'active', visit_status: 'completed', completed_at: now, updated_at: now };
    if (durationMinutes !== null) update.actual_duration_minutes = Math.max(0, durationMinutes);

    await this.db('employee_client_visits')
      .where({ employee_id: employeeId, client_id: clientId })
      .whereRaw('DATE(visit_date) = ?', [date])
      .where((q) => q.where('visit_status', '!=', 'completed').orWhereNull('visit_status'))
      .update(update);
  }

  async contactShifts(clientId: number) {
    const rows = await this.db('client_employee_notes').where('client_id', clientId).select('shift_start', 'shift_end');
    return rows.map((r: Record<string, unknown>) => ({ shiftStart: str(r.shift_start), shiftEnd: str(r.shift_end) }));
  }

  async hasNoteSince(clientId: number, userId: number, since: string): Promise<boolean> {
    return Boolean(await this.db('client_relations').where({ client_id: clientId, employee_id: userId }).where('created_at', '>=', since).first('id'));
  }

  async latestNoteIdSince(clientId: number, userId: number, since: string): Promise<number | null> {
    const r = await this.db('client_relations').where({ client_id: clientId, employee_id: userId }).where('created_at', '>=', since).orderBy('id', 'desc').first('id');
    return r ? Number(r.id) : null;
  }

  /** `VisitRules::hasSaleOrCollectionSince()` — فاتورةٌ أنشأها، أو سند قبضٍ على حساب العميل */
  async hasSaleOrCollectionSince(clientId: number, userId: number, since: string): Promise<boolean> {
    if (await this.db('invoices').where({ client_id: clientId, created_by: userId }).where('created_at', '>=', since).first('id')) return true;
    const account = await this.db('accounts').where('client_id', clientId).where((q) => q.whereNull('type_accont').orWhereNotIn('type_accont', WALLETS)).orderBy('id').first('id');
    if (!account) return false;
    return Boolean(await this.db('receipts').where({ account_id: account.id, created_by: userId }).where('created_at', '>=', since).first('id'));
  }

  async hasObservations(visitId: number): Promise<boolean> {
    return Boolean(await this.db('visit_competitor_observations').where('visit_id', visitId).first('id'));
  }

  async observations(visitId: number) {
    const rows = await this.db('visit_competitor_observations').where('visit_id', visitId).orderBy('created_at', 'desc').orderBy('id', 'desc').select('competitor_id', 'competitor_name', 'asset_count', 'photo_path');
    return rows.map((o: Record<string, unknown>) => ({ competitorId: num(o.competitor_id), name: String(o.competitor_name ?? ''), assetCount: Number(o.asset_count ?? 0), photoPath: str(o.photo_path) }));
  }

  /** نطاق رصد هذه الملاحظة (أو رصدٌ بلا ملاحظة لهذا المندوب) في الزيارة */
  async observationScope(visitId: number, noteId: number | null, userId: number) {
    const q = this.db('visit_competitor_observations').where('visit_id', visitId);
    if (noteId) q.where('client_relation_id', noteId);
    else q.whereNull('client_relation_id').where('employee_id', userId);
    const rows = await q.select('competitor_id');
    return { any: rows.length > 0, competitorIds: rows.map((r: Record<string, unknown>) => num(r.competitor_id)).filter((v: number | null): v is number => v !== null) };
  }

  async insertObservation(values: Record<string, unknown>, tx: Tx): Promise<void> {
    await conn(this.db, tx)('visit_competitor_observations').insert(values);
  }

  async countNoteCompetitors(noteId: number): Promise<number> {
    const r = await this.db('visit_competitor_observations').where('client_relation_id', noteId).whereNotNull('competitor_id').count<{ c: number }[]>({ c: 'id' }).first();
    return Number((r as { c?: number } | undefined)?.c ?? 0);
  }

  async setNoteCompetitorDocuments(noteId: number, count: number): Promise<void> {
    await this.db('client_relations').where('id', noteId).update({ competitor_documents: count });
  }

  async activeCompetitors(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db('competitors').whereIn('id', ids).where('is_active', 1).select('id', 'name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name ?? '')]));
  }

  async competitorByName(name: string) {
    const r = await this.db('competitors').whereRaw('LOWER(name) = ?', [name.toLowerCase()]).orderBy('id').first('id', 'name', 'is_active');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), isActive: bool(r.is_active) } : null;
  }

  async insertCompetitor(values: Record<string, unknown>): Promise<number> {
    const [id] = await this.db('competitors').insert(values);
    return Number(id);
  }

  async updateContactShift(contactId: number, start: string, end: string, now: string): Promise<void> {
    await this.db('client_employee_notes').where('id', contactId).update({ shift_start: start, shift_end: end, updated_at: now });
  }

  private async withReplies(rows: Record<string, unknown>[]): Promise<ClientNotificationRow[]> {
    const ids = rows.map((r) => Number(r.id));
    const hasParent = await this.db.schema.hasColumn('notifications', 'parent_id');
    const replies = hasParent && ids.length ? await this.db('notifications').whereIn('parent_id', ids).orderBy('id').select('parent_id', 'description', 'created_at') : [];
    const byParent = new Map<number, Array<{ description: string | null; createdAt: string | null }>>();
    for (const r of replies as Record<string, unknown>[]) {
      const list = byParent.get(Number(r.parent_id)) ?? [];
      list.push({ description: str(r.description), createdAt: str(r.created_at) });
      byParent.set(Number(r.parent_id), list);
    }
    return rows.map((n) => ({
      id: Number(n.id),
      title: str(n.title),
      description: str(n.description),
      read: bool(n.read),
      from: str(n.sender_name),
      createdAt: str(n.created_at),
      replies: byParent.get(Number(n.id)) ?? [],
      userId: num(n.user_id),
      clientId: num(n.client_id),
    }));
  }

  /** إشعارات الإدارة عن هذا العميل للمستخدم — المُرسَلة أو المجدولة التي حان وقتها، غير المقروء أوّلاً */
  async clientNotifications(clientId: number, userId: number, now: string): Promise<ClientNotificationRow[]> {
    const rows = await this.db('notifications as n')
      .leftJoin('users as u', 'u.id', 'n.user_id')
      .where('n.client_id', clientId)
      .where('n.type', 'client_popup')
      .where('n.receiver_id', userId)
      .where((q) => q.where('n.is_sent', 1).orWhere((s) => s.where('n.is_scheduled', 1).where('n.scheduled_at', '<=', now)))
      .orderBy('n.read')
      .orderBy('n.id', 'desc')
      .limit(20)
      .select('n.*', 'u.name as sender_name');
    return this.withReplies(rows);
  }

  async ownedClientNotification(id: number, clientId: number, userId: number): Promise<ClientNotificationRow | null> {
    const r = await this.db('notifications as n')
      .leftJoin('users as u', 'u.id', 'n.user_id')
      .where({ 'n.id': id, 'n.client_id': clientId, 'n.type': 'client_popup', 'n.receiver_id': userId })
      .first('n.*', 'u.name as sender_name');
    return r ? (await this.withReplies([r]))[0] : null;
  }

  async markNotificationRead(id: number, now: string, tx?: Tx): Promise<void> {
    await conn(this.db, tx)('notifications').where('id', id).update({ read: 1, updated_at: now });
  }

  /** مستندات الزيارة (نافذتها ومنشئوها) أو آخر مستندات العميل — `documents()` */
  async documents(o: { clientId: number; creators: number[]; since: string | null; until: string | null; visitOnly: boolean; limit: number }): Promise<VisitDocument[]> {
    const window = (q: Knex.QueryBuilder, creator = 'created_by') => {
      if (o.visitOnly) {
        q.whereIn(creator, o.creators);
        if (o.since) q.where('created_at', '>=', o.since);
        if (o.until) q.where('created_at', '<=', o.until);
      }
      return q.orderBy('created_at', 'desc').limit(o.limit);
    };
    const docs: VisitDocument[] = [];
    const push = (group: string, type: string, id: unknown, number: unknown, amount: unknown, at: unknown, extra: Partial<VisitDocument> = {}) =>
      docs.push({ group, type, id: Number(id), number: str(number), amount: amount !== null && amount !== undefined ? Math.round(Number(amount) * 100) / 100 : null, at: str(at), ...extra });

    // فاتورةٌ عليها مرتجعُ مبيعات لا تُعرض بين الفواتير — مرتجعُها يظهر في تبويب المرتجعات
    const invoicesQ = this.db('invoices as i')
      .where('i.client_id', o.clientId)
      .where((q) => q.whereNull('i.type').orWhere('i.type', '!=', 'returned'))
      .whereNotExists((s) => s.select(this.db.raw(1)).from('invoices as r').where('r.type', 'returned').whereRaw('r.reference_number = i.id'));
    for (const i of await window(invoicesQ).select('i.id', 'i.code', 'i.grand_total', 'i.payment_status', 'i.created_at')) {
      push('invoices', 'invoice', i.id, i.code, i.grand_total, i.created_at, { paymentStatus: Number(i.payment_status ?? 0) });
    }
    for (const r of await window(this.db('invoices').where('client_id', o.clientId).where('type', 'returned')).select('id', 'code', 'grand_total', 'created_at')) {
      push('returns', 'sales_return', r.id, r.code, r.grand_total, r.created_at);
    }

    const account = await this.db('accounts').where('client_id', o.clientId).where((q) => q.whereNull('type_accont').orWhereNotIn('type_accont', WALLETS)).orderBy('id').first('id');
    const accountId = account ? Number(account.id) : null;

    for (const r of await window(this.db('receipts').where((q) => {
      q.where('client_id', o.clientId);
      if (accountId) q.orWhere('account_id', accountId);
    })).select('id', 'code', 'amount', 'created_at')) {
      push('receipts', 'receipt', r.id, r.code, r.amount, r.created_at);
    }

    const invoiceIds = (await this.db('invoices').where('client_id', o.clientId).pluck('id')).map(Number);
    // سند القبض المالي يوزّع نفسه على الفواتير (`IncomesController::applyPaymentToInvoices`) فيكتب لكلّ
    // فاتورةٍ صفّاً هنا برقم السند (`receipt_id`) — هي أنصبةُ سندٍ ظهر أعلاه، لا دفعاتٌ أخرى
    for (const p of await window(
      this.db('payments_process').whereIn('type', ['client payments', 'sale']).whereNull('receipt_id').where((q) => {
        q.where('client_id', o.clientId);
        if (invoiceIds.length) q.orWhereIn('invoice_id', invoiceIds);
      }),
      'employee_id',
    ).select('id', 'reference_number', 'amount', 'created_at')) {
      push('receipts', 'client_payment', p.id, p.reference_number || String(p.id).padStart(6, '0'), p.amount, p.created_at);
    }

    if (accountId) {
      for (const e of await window(this.db('expenses').where('account_id', accountId)).select('id', 'code', 'amount', 'created_at')) {
        push('expenses', 'expense', e.id, e.code, e.amount, e.created_at);
      }
    }
    for (const c of await window(this.db('credit_notifications').where('client_id', o.clientId)).select('id', 'credit_number', 'grand_total', 'created_at')) {
      push('credit_notes', 'credit_note', c.id, c.credit_number, c.grand_total, c.created_at);
    }
    for (const x of await window(this.db('product_exchanges').where('client_id', o.clientId)).select('id', 'code', 'created_at')) {
      push('exchanges', 'exchange', x.id, x.code, null, x.created_at);
    }

    return docs.sort((a, b) => (a.at ?? '') < (b.at ?? '') ? 1 : (a.at ?? '') > (b.at ?? '') ? -1 : 0);
  }

  async clientReceipt(receiptId: number, clientId: number): Promise<VisitReceipt | null> {
    const account = await this.db('accounts').where('client_id', clientId).where((q) => q.whereNull('type_accont').orWhereNotIn('type_accont', WALLETS)).orderBy('id').first('id');
    const r = await this.db('receipts')
      .where('id', receiptId)
      .where((q) => {
        q.where('client_id', clientId);
        if (account) q.orWhere('account_id', Number(account.id));
      })
      .first('id', 'code', 'date', 'amount', 'total_amount', 'description', 'seller', 'currency', 'cancelled_at');
    if (!r) return null;
    const amount = Number(r.amount ?? 0);
    return {
      id: Number(r.id),
      code: str(r.code),
      date: r.date ? String(r.date).slice(0, 10) : null,
      amount,
      totalAmount: Number(r.total_amount ?? 0) || amount,
      description: str(r.description),
      seller: str(r.seller),
      currency: str(r.currency),
      cancelled: r.cancelled_at !== null && r.cancelled_at !== undefined,
    };
  }

  /** `$user->hasRole()` — أدوار Spatie في `model_has_roles` */
  async hasSpatieRole(userId: number, role: string): Promise<boolean> {
    const r = await this.db('model_has_roles as mr').join('roles as r', 'r.id', 'mr.role_id').where('mr.model_id', userId).where('mr.model_type', 'like', '%User').where('r.name', role).first('mr.role_id');
    return Boolean(r);
  }
}
