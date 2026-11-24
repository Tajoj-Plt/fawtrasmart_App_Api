import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { ClosingRow, ClosingStockProduct, DailyClosingRepository, WorkspaceVisit } from '../../../domain/repositories/sales';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** أعمدة «المُدخَل» و«النظام» في `daily_closings` */
export const CLOSING_FIELDS = ['sales', 'cash_sales', 'receipts', 'collections', 'returns', 'cash_refunds', 'expenses', 'stock_quantity'] as const;

/**
 * قراءات الإقفال اليومي — `DailyClosingLedger` بقيوده ومستنداته، و`daily_closings`
 * وتفاصيل مخزونها. `employeeId` هنا هو `users.id` كما في الويب.
 */
export class KnexDailyClosingRepository implements DailyClosingRepository {
  private receiptsCancelColumn: Promise<boolean> | null = null;

  constructor(private readonly db: Knex) {}

  /** `receipts.cancelled_at` — ترحيلُه قد لا يكون شُغِّل في كل قاعدة */
  private hasReceiptCancel(): Promise<boolean> {
    if (!this.receiptsCancelColumn) {
      this.receiptsCancelColumn = this.db
        .raw("SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'receipts' AND column_name = 'cancelled_at'")
        .then((r: unknown) => Number(((r as unknown[][])[0][0] as Record<string, unknown>).c) > 0)
        .catch(() => false);
    }
    return this.receiptsCancelColumn;
  }

  async accountId(key: string, fallback: number): Promise<number> {
    const r = await this.db('accounting_settings').where('key', key).where((w) => w.whereNull('is_active').orWhere('is_active', 1)).first('account_id').catch(() => null);
    return r && r.account_id ? Number(r.account_id) : fallback;
  }

  // ═══════════════════════ أرقام النظام ═══════════════════════

  async grossSales(userId: number, from: string, to: string, salesAccount: number) {
    const r = await this.db('journal_entry_details as d')
      .join('journal_entries as j', 'j.id', 'd.journal_entry_id')
      .whereBetween('j.date', [from, to])
      .where('j.created_by_employee', userId)
      .where('d.account_id', salesAccount)
      .first(this.db.raw('COALESCE(SUM(d.credit), 0) - COALESCE(SUM(d.debit), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async cashSaleInvoices(userId: number, date: string) {
    const rows = await this.db('invoices').where('created_by', userId).whereRaw('DATE(invoice_date) = ?', [date]).where('payment_status', 1).whereIn('type', ['normal', 'pos']).select('id', 'grand_total');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), grandTotal: Number(r.grand_total ?? 0) }));
  }

  /** `nonCashSettlements()` — ما سُوِّي بإشعارٍ دائن أو بسند قبضٍ عامّ لا بنقد الفاتورة */
  async nonCashSettlements(invoiceIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!invoiceIds.length) return out;
    const rows = await this.db('payments_process as p')
      .whereIn('p.invoice_id', invoiceIds)
      .where((w) => w.whereNull('p.payment_status').orWhere('p.payment_status', '!=', 5))
      .where((w) =>
        w.where('p.type', 'credit_note_settlement').orWhere((v) =>
          v.where('p.type', 'client payments').whereExists((s) =>
            s
              .select(this.db.raw(1))
              .from('receipts as r')
              .join('accounts as a', 'a.id', 'r.account_id')
              .whereRaw('a.client_id = p.client_id')
              .where((m) => m.whereRaw('CAST(r.id AS CHAR) = BINARY p.reference_number').orWhereRaw('BINARY r.code = BINARY p.reference_number')),
          ),
        ),
      )
      .groupBy('p.invoice_id')
      .select('p.invoice_id', this.db.raw('SUM(p.amount) as settled'));
    for (const r of rows as Record<string, unknown>[]) out.set(Number(r.invoice_id), Number(r.settled ?? 0));
    return out;
  }

  async receipts(userId: number, from: string, to: string) {
    const r = await this.db('receipts').where('created_by', userId).whereBetween('date', [from, to]).where('status', 1).first(this.db.raw('COALESCE(SUM(amount), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async cashRefunds(userId: number, date: string) {
    const r = await this.db('payments_process as p')
      .join('invoices as i', 'i.id', 'p.invoice_id')
      .where('p.type', 'treasury_return')
      .whereRaw('DATE(p.payment_date) = ?', [date])
      .where((w) => w.whereNull('p.payment_status').orWhere('p.payment_status', '!=', 5))
      .where('i.created_by', userId)
      .first(this.db.raw('COALESCE(SUM(p.amount), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  /** المرتجعات والإشعارات الدائنة — والملغاة منها لا تُعدّ (الويب يعدّها) */
  async returns(userId: number, from: string, to: string) {
    const a = await this.db('invoices').where('created_by', userId).whereBetween('invoice_date', [from, to]).where('type', 'returned').first(this.db.raw('COALESCE(SUM(grand_total), 0) as v'));
    const b = await this.db('credit_notifications').where('created_by', userId).whereBetween('created_at', [from, to]).whereNotIn('status', [0, 5]).first(this.db.raw('COALESCE(SUM(grand_total), 0) as v'));
    return Number((a as Record<string, unknown> | undefined)?.v ?? 0) + Number((b as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async treasuryAndBankAccountIds(cashParent: number, bankParent: number) {
    return (await this.db('accounts').whereIn('parent_id', [cashParent, bankParent]).pluck('id')).map(Number);
  }

  async cancelledExpenseRefs() {
    const refs = await this.db('journal_entries').where('reference_number', 'like', '%-REV').where('reference_type', 'EXP').pluck('reference_number');
    return refs.map((r: unknown) => String(r).replace('-REV', ''));
  }

  async employeeTreasuryId(hrEmployeeId: number): Promise<number | null> {
    const r = await this.db('treasury_employees').where('employee_id', hrEmployeeId).first('treasury_id').catch(() => null);
    return r && r.treasury_id ? Number(r.treasury_id) : null;
  }

  /** `fetchExpenseJournalIdsCreditingTreasury()` ثمّ `filterValidExpenseJournalIds()` */
  async expenseEntryIds(userId: number, from: string, to: string, treasuryId: number, cancelledRefs: string[], ownOnly: boolean, treasuryAndBank: number[], salesReturns: number) {
    const q = this.db('journal_entry_details as d')
      .join('journal_entries as j', 'j.id', 'd.journal_entry_id')
      .whereBetween('j.date', [from, to])
      .where('j.status', 1)
      .whereNotIn('j.reference_type', ['PCAN', 'SR'])
      .where('j.reference_number', 'not like', '%-REV')
      .where('d.account_id', treasuryId)
      .where('d.credit', '>', 0);
    if (cancelledRefs.length) q.whereNotIn('j.reference_number', cancelledRefs);
    if (ownOnly) q.where('j.reference_type', 'EXP').where('j.created_by_employee', userId);
    const ids = [...new Set((await q.pluck('d.journal_entry_id')).map(Number))];
    if (!ids.length) return [];
    const details = await this.db('journal_entry_details').whereIn('journal_entry_id', ids).select('journal_entry_id', 'account_id', 'debit', 'credit');
    const excluded = new Set<number>();
    for (const id of ids) {
      const rows = (details as Record<string, unknown>[]).filter((d) => Number(d.journal_entry_id) === id);
      const tDebit = rows.some((d) => treasuryAndBank.includes(Number(d.account_id)) && Number(d.debit) > 0);
      const tCredit = rows.some((d) => treasuryAndBank.includes(Number(d.account_id)) && Number(d.credit) > 0);
      const sr = rows.some((d) => Number(d.account_id) === salesReturns);
      if ((tDebit && tCredit) || sr) excluded.add(id);
    }
    return ids.filter((id) => !excluded.has(id));
  }

  async creditSum(entryIds: number[], accountId: number) {
    if (!entryIds.length) return 0;
    const r = await this.db('journal_entry_details').whereIn('journal_entry_id', entryIds).where('account_id', accountId).where('credit', '>', 0).first(this.db.raw('COALESCE(SUM(credit), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async userEmployeeId(userId: number): Promise<number | null> {
    const r = await this.db('users').where('id', userId).first('employee_id');
    return r ? num(r.employee_id) : null;
  }

  async stockProducts(hrEmployeeId: number): Promise<ClosingStockProduct[]> {
    const warehouses = (await this.db('default_warehouses').where('employee_id', hrEmployeeId).pluck('storehouse_id')).map(Number);
    if (!warehouses.length) return [];
    const rows = await this.db('product_details as pd')
      .leftJoin('products as p', 'p.id', 'pd.product_id')
      .whereIn('pd.store_house_id', warehouses)
      .where('pd.quantity', '>', 0)
      .groupBy('pd.product_id', 'p.name')
      .select('pd.product_id', 'p.name', this.db.raw('SUM(pd.quantity) as total'));
    return rows.map((r: Record<string, unknown>) => ({ productId: Number(r.product_id), productName: str(r.name) ?? `منتج #${r.product_id}`, systemQuantity: Number(r.total ?? 0) }));
  }

  // ═══════════════════════ الزيارات ═══════════════════════

  async itineraryRows(userId: number, date: string) {
    const rows = await this.db('employee_client_visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [date])
      .orderByRaw('sequence IS NULL')
      .orderBy('sequence')
      .orderBy('id')
      .select('id', 'client_id', 'visit_status', 'status', 'started_at', 'completed_at', 'missed_reason', 'actual_duration_minutes');
    return rows.map((r: Record<string, unknown>) => ({
      clientId: Number(r.client_id),
      visitStatus: str(r.visit_status),
      status: str(r.status),
      startedAt: str(r.started_at),
      completedAt: str(r.completed_at),
      missedReason: str(r.missed_reason),
      minutes: num(r.actual_duration_minutes),
    }));
  }

  /** `workspaceVisits()` — زيارات مساحة العمل الفعلية (بدأت، أو يدويةٌ مكتملة)، بلا الملغاة */
  async workspaceVisits(userId: number, date: string, nowSql: string): Promise<Map<number, WorkspaceVisit>> {
    const rows = await this.db('visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [date])
      .where((w) => w.whereNotNull('started_at').orWhere((m) => m.where('recording_method', 'manual').where((s) => s.whereNull('stage').orWhere('stage', 'completed'))))
      .where((w) => w.whereNull('stage').orWhere('stage', '!=', 'cancelled'))
      .orderBy('id')
      .select('id', 'client_id', 'stage', 'outcome', 'started_at', 'departure_time', 'total_paused_seconds', 'paused_at');
    const secs = (a: string, b: string) => Math.abs(new Date(b.replace(' ', 'T') + 'Z').getTime() - new Date(a.replace(' ', 'T') + 'Z').getTime()) / 1000;
    const out = new Map<number, WorkspaceVisit>();
    for (const v of rows as Record<string, unknown>[]) {
      const clientId = Number(v.client_id);
      const started = str(v.started_at);
      const departure = str(v.departure_time);
      const completed = v.stage === 'completed' || departure !== null;
      const ended = completed ? departure : null;
      let minutes: number | null = null;
      if (started && ended) {
        // `getElapsedSecondsAttribute()`
        let elapsed = secs(started, departure ?? nowSql) - Number(v.total_paused_seconds ?? 0);
        const paused = str(v.paused_at);
        if (paused) elapsed -= secs(paused, nowSql);
        minutes = Math.max(0, Math.floor(Math.max(0, elapsed) / 60));
      }
      const current = out.get(clientId);
      if (current && current.endedAt && !ended) continue;
      out.set(clientId, { clientId, minutes, outcome: str(v.outcome) || null, endedAt: ended, startedAt: started });
    }
    return out;
  }

  async clientNames(ids: number[]) {
    const out = new Map<number, { name: string | null; code: string | null }>();
    if (!ids.length) return out;
    for (const r of await this.db('clients').whereIn('id', ids).select('id', 'trade_name', 'code')) out.set(Number(r.id), { name: str(r.trade_name), code: str(r.code) });
    return out;
  }

  /** `clientsWithSaleOrCollection()` */
  async servedClientIds(userId: number, date: string): Promise<Set<number>> {
    const invoiced = await this.db('invoices').where('created_by', userId).whereRaw('DATE(invoice_date) = ?', [date]).whereIn('type', ['normal', 'pos']).pluck('client_id');
    const q = this.db('receipts as r').join('accounts as a', 'a.id', 'r.account_id').where('r.created_by', userId).whereRaw('DATE(r.date) = ?', [date]);
    if (await this.hasReceiptCancel()) q.whereNull('r.cancelled_at');
    const collected = await q.pluck('a.client_id');
    return new Set([...invoiced, ...collected].filter(Boolean).map(Number));
  }

  // ═══════════════════════ الإقفالات ═══════════════════════

  async existing(userId: number, date: string, tx?: Tx) {
    const r = await conn(this.db, tx)('daily_closings').where('employee_id', userId).where('date', date).first('id');
    return r ? Number(r.id) : null;
  }

  /** قفل صفّ المستخدم — إقفالان متزامنان لليوم نفسه يتتابعان فيُرفض الثاني */
  async lockUser(userId: number, tx: Tx) {
    await conn(this.db, tx)('users').where('id', userId).forUpdate().select('id');
  }

  async insert(row: Record<string, unknown>, stock: Array<Record<string, unknown>>, now: string, tx: Tx) {
    const db = conn(this.db, tx);
    const [id] = await db('daily_closings').insert({ ...row, created_at: now, updated_at: now });
    for (let i = 0; i < stock.length; i += 200) {
      await db('daily_closing_stock_details').insert(stock.slice(i, i + 200).map((s) => ({ ...s, daily_closing_id: Number(id), created_at: now, updated_at: now })));
    }
    return Number(id);
  }

  private map(r: Record<string, unknown>): ClosingRow {
    const reported: Record<string, number> = {};
    const system: Record<string, number> = {};
    for (const f of CLOSING_FIELDS) {
      reported[f] = Number(r[`reported_${f}`] ?? 0);
      system[f] = Number(r[`system_${f}`] ?? 0);
    }
    return { id: Number(r.id), employeeId: Number(r.employee_id), employeeName: str(r.employee_name), date: String(r.date).slice(0, 10), status: str(r.status), notes: str(r.notes), reported, system, createdAt: str(r.created_at) };
  }

  async page(f: { employeeId: number | null; fromDate?: string; toDate?: string }, page: number, perPage: number) {
    const q = this.db('daily_closings as d');
    if (f.employeeId !== null) q.where('d.employee_id', f.employeeId);
    if (f.fromDate) q.where('d.date', '>=', f.fromDate);
    if (f.toDate) q.where('d.date', '<=', f.toDate);
    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'd.id' });
    const rows = await q.clone().leftJoin('users as u', 'u.id', 'd.employee_id').orderBy('d.date', 'desc').orderBy('d.id', 'desc').limit(perPage).offset((page - 1) * perPage).select('d.*', 'u.name as employee_name');
    return { rows: rows.map((r: Record<string, unknown>) => this.map(r)), total: Number(c) };
  }

  async find(id: number) {
    const r = await this.db('daily_closings as d').leftJoin('users as u', 'u.id', 'd.employee_id').where('d.id', id).first('d.*', 'u.name as employee_name');
    return r ? this.map(r) : null;
  }

  async stockDetails(id: number) {
    const rows = await this.db('daily_closing_stock_details').where('daily_closing_id', id).orderBy('id').select('product_id', 'product_name', 'reported_quantity', 'system_quantity');
    return rows.map((r: Record<string, unknown>) => ({ productId: Number(r.product_id), productName: str(r.product_name), reportedQuantity: Number(r.reported_quantity ?? 0), systemQuantity: Number(r.system_quantity ?? 0) }));
  }
}
