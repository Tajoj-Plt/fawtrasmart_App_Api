import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { CreditNoteListFilters, CreditNoteRepository, CreditNoteRow, SettlementInvoice } from '../../../domain/repositories/sales';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const BASE_QTY = 'COALESCE(NULLIF(it.quantity_in_base_unit, 0), it.quantity * COALESCE(NULLIF(it.conversion_factor, 0), 1))';
const SALE_TYPES = ['normal', 'pos', 'online'];
/** أنواع السندات التي تسدّد الرصيد الافتتاحي — `ClientDebtSettlement::previousBalance()` */
const OPENING_PAYMENT_TYPES = ['previous_balance_payment', 'opening_balance_payment', 'credit_note_previous_balance'];

const COLUMNS = [
  'cn.*',
  'c.trade_name as client_name',
  'b.name as branch_name',
  'i.code as invoice_code',
  'u.name as created_by_name',
];

function map(r: Record<string, unknown>): CreditNoteRow {
  return {
    id: Number(r.id),
    creditNumber: str(r.credit_number),
    clientId: num(r.client_id),
    clientName: str(r.client_name),
    branchId: num(r.branch_id),
    branchName: str(r.branch_name),
    invoiceId: num(r.invoice_id),
    invoiceCode: str(r.invoice_code),
    createdBy: num(r.created_by),
    createdByName: str(r.created_by_name),
    employeeId: num(r.employee_id),
    storeHouseId: num(r.store_house_id),
    creditDate: str(r.credit_date),
    releaseDate: str(r.release_date),
    currency: str(r.currency),
    subtotal: Number(r.subtotal ?? 0),
    discountAmount: Number(r.discount_amount ?? 0),
    totalDiscount: Number(r.total_discount ?? 0),
    totalTax: Number(r.total_tax ?? 0),
    shippingCost: Number(r.shipping_cost ?? 0),
    shippingTax: Number(r.shipping_tax ?? 0),
    grandTotal: Number(r.grand_total ?? 0),
    status: num(r.status),
    notes: str(r.notes),
    createdAt: str(r.created_at),
  };
}

/** `credit_notifications` وتسويتها على الفواتير (`journal_entry_invoices`) */
export class KnexCreditNoteRepository implements CreditNoteRepository {
  constructor(private readonly db: Knex) {}

  private base(db: Knex) {
    return db('credit_notifications as cn')
      .leftJoin('clients as c', 'c.id', 'cn.client_id')
      .leftJoin('branches as b', 'b.id', 'cn.branch_id')
      .leftJoin('invoices as i', 'i.id', 'cn.invoice_id')
      .leftJoin('users as u', 'u.id', 'cn.created_by');
  }

  async insert(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('credit_notifications').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async update(id: number, patch: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('credit_notifications').where('id', id).update({ ...patch, updated_at: now });
  }

  async find(id: number, tx?: Tx) {
    const r = await this.base(conn(this.db, tx)).where('cn.id', id).first(COLUMNS);
    return r ? map(r) : null;
  }

  async lock(id: number, tx: Tx) {
    await conn(this.db, tx)('credit_notifications').where('id', id).forUpdate().select('id');
  }

  async lockInvoice(invoiceId: number, tx: Tx) {
    await conn(this.db, tx)('invoices').where('id', invoiceId).forUpdate().select('id');
  }

  async page(f: CreditNoteListFilters, page: number, perPage: number) {
    const q = this.db('credit_notifications as cn');
    const { branchIds, userIds, employeeIds } = f.scope;
    if (branchIds !== null) q.whereIn('cn.branch_id', branchIds.length ? branchIds : [0]);
    else if (userIds !== null) q.where((w) => w.whereIn('cn.created_by', userIds.length ? userIds : [0]).orWhereIn('cn.employee_id', employeeIds && employeeIds.length ? employeeIds : [0]));
    if (f.headerBranchIds !== null) q.where((w) => w.whereIn('cn.branch_id', f.headerBranchIds as number[]).orWhereNull('cn.branch_id'));
    if (f.clientId !== undefined) q.where('cn.client_id', f.clientId);
    if (f.number) q.where('cn.credit_number', 'like', likeTerm(f.number));
    if (f.status !== undefined) q.where('cn.status', f.status);
    if (f.branchIds) q.whereIn('cn.branch_id', f.branchIds);
    q.whereBetween('cn.credit_date', [f.start, f.end]);

    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'cn.id' });
    const ids = (await q.clone().orderBy('cn.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('cn.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c) };
    const rows = await this.base(this.db).whereIn('cn.id', ids).orderBy('cn.id', 'desc').select(COLUMNS);
    return { rows: rows.map(map), total: Number(c) };
  }

  async openInvoices(clientId: number, tx?: Tx): Promise<SettlementInvoice[]> {
    const db = conn(this.db, tx);
    const q = db('invoices as i')
      .where('i.client_id', clientId)
      .where('i.is_paid', 0)
      .whereNot('i.type', 'returned')
      .whereNull('i.voided_at')
      .whereNotExists((s) => s.select(this.db.raw(1)).from('invoices as r').where('r.type', 'returned').whereRaw('r.reference_number = i.id'))
      .orderBy('i.invoice_date')
      .orderBy('i.id');
    const rows = await (tx ? q.forUpdate() : q).select('i.id', 'i.code', 'i.invoice_date', 'i.grand_total', 'i.due_value', 'i.wallet_paid_amount', 'i.returned_payment');
    if (!rows.length) return [];
    const paid = new Map<number, number>();
    for (const p of await db('payments_process')
      .whereIn('invoice_id', rows.map((r: Record<string, unknown>) => Number(r.id)))
      .where('type', 'client payments')
      .where((w) => w.whereNull('payment_status').orWhere('payment_status', '!=', 5))
      .groupBy('invoice_id')
      .select('invoice_id', this.db.raw('COALESCE(SUM(amount), 0) as paid'))) {
      paid.set(Number(p.invoice_id), Number(p.paid ?? 0));
    }
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      code: str(r.code),
      invoiceDate: str(r.invoice_date),
      grandTotal: Number(r.grand_total ?? 0),
      dueValue: Number(r.due_value ?? r.grand_total ?? 0),
      walletPaidAmount: Number(r.wallet_paid_amount ?? 0),
      returnedPayment: Number(r.returned_payment ?? 0),
      paid: paid.get(Number(r.id)) ?? 0,
    }));
  }

  async ledgerBalance(accountId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('journal_entry_details').where('account_id', accountId).first(this.db.raw('COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) as b'));
    return Number((r as Record<string, unknown> | undefined)?.b ?? 0);
  }

  async openingBalance(accountId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('journal_entry_details as d')
      .join('journal_entries as j', 'j.id', 'd.journal_entry_id')
      .where('d.account_id', accountId)
      .where('j.reference_type', 'OPB')
      .first(this.db.raw('COALESCE(SUM(d.debit), 0) - COALESCE(SUM(d.credit), 0) as b'));
    return Number((r as Record<string, unknown> | undefined)?.b ?? 0);
  }

  async openingPaid(clientId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('payments_process').where('client_id', clientId).whereIn('type', OPENING_PAYMENT_TYPES).first(this.db.raw('COALESCE(SUM(amount), 0) as s'));
    return Number((r as Record<string, unknown> | undefined)?.s ?? 0);
  }

  async insertLink(entryId: number, invoiceId: number, amount: number, now: string, tx: Tx) {
    await conn(this.db, tx)('journal_entry_invoices').insert({ entry_id: entryId, invoice_id: invoiceId, invoice_type: 'sale', allocation_amount: amount, created_at: now });
  }

  async links(creditNoteId: number, clientId: number, tx?: Tx) {
    const db = conn(this.db, tx);
    const entryIds = await db('journal_entries').where('reference_type', 'CN').where('reference_number', String(creditNoteId)).where('client_id', clientId).pluck('id');
    if (!entryIds.length) return [];
    const rows = await db('journal_entry_invoices').whereIn('entry_id', entryIds).where('invoice_type', 'sale').orderBy('link_id').select('link_id', 'invoice_id', 'allocation_amount');
    return rows.map((r: Record<string, unknown>) => ({ linkId: Number(r.link_id), invoiceId: Number(r.invoice_id), amount: Number(r.allocation_amount ?? 0) }));
  }

  async deleteLinks(linkIds: number[], tx: Tx) {
    if (linkIds.length) await conn(this.db, tx)('journal_entry_invoices').whereIn('link_id', linkIds).del();
  }

  async setLinking(entryId: number, linkingType: string, batch: string | null, tx: Tx) {
    await conn(this.db, tx)('journal_entries').where('id', entryId).update({ linking_type: linkingType, batch_reference: batch });
  }

  async previousBalancePaid(creditNoteId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('payments_process').where('reference_number', `CN-${creditNoteId}`).where('type', 'credit_note_previous_balance').first(this.db.raw('COALESCE(SUM(amount), 0) as s'));
    return Number((r as Record<string, unknown> | undefined)?.s ?? 0);
  }

  async deletePreviousBalancePayments(creditNoteId: number, tx: Tx) {
    await conn(this.db, tx)('payments_process').where('reference_number', `CN-${creditNoteId}`).where('type', 'credit_note_previous_balance').del();
  }

  async addReturned(invoiceId: number, delta: number, now: string, tx: Tx) {
    await conn(this.db, tx)('invoices')
      .where('id', invoiceId)
      .update({ returned_payment: this.db.raw('ROUND(GREATEST(0, COALESCE(returned_payment, 0) + ?), 2)', [delta]), updated_at: now });
  }

  async entries(creditNoteId: number, clientId: number, tx: Tx) {
    const rows = await conn(this.db, tx)('journal_entries').where('reference_type', 'CN').where('reference_number', String(creditNoteId)).where('client_id', clientId).orderBy('id').select('id', 'currency');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), currency: str(r.currency) }));
  }

  async deleteTaxRows(creditNoteId: number, tx: Tx) {
    await conn(this.db, tx)('taxs_invoice').where('invoice_id', creditNoteId).where('type_invoice', 'credit').del();
  }

  async clientReturnable(clientId: number, productId: number) {
    const sold = await this.db('invoice_items as it')
      .join('invoices as i', 'i.id', 'it.invoice_id')
      .where('i.client_id', clientId)
      .whereIn('i.type', SALE_TYPES)
      .whereNull('i.voided_at')
      .where('it.product_id', productId)
      .first(this.db.raw(`COALESCE(SUM(${BASE_QTY}), 0) as q`));
    const viaReturns = await this.db('invoice_items as it')
      .join('invoices as i', 'i.id', 'it.invoice_id')
      .where('i.client_id', clientId)
      .where('i.type', 'returned')
      .where('it.product_id', productId)
      .first(this.db.raw(`COALESCE(SUM(${BASE_QTY}), 0) as q`));
    const viaCredits = await this.db('invoice_items as it')
      .join('credit_notifications as cn', 'cn.id', 'it.credit_note_id')
      .where('cn.client_id', clientId)
      .whereNotIn('cn.status', [0, 5])
      .where('it.product_id', productId)
      .first(this.db.raw(`COALESCE(SUM(${BASE_QTY}), 0) as q`));
    const last = await this.db('invoice_items as it')
      .join('invoices as i', 'i.id', 'it.invoice_id')
      .where('i.client_id', clientId)
      .whereIn('i.type', SALE_TYPES)
      .whereNull('i.voided_at')
      .where('it.product_id', productId)
      .where('it.unit_price', '>', 0)
      .orderBy('i.invoice_date', 'desc')
      .orderBy('it.id', 'desc')
      .first(this.db.raw('it.unit_price / COALESCE(NULLIF(it.conversion_factor, 0), 1) as p'));
    const q = (r: unknown) => Number((r as Record<string, unknown> | undefined)?.q ?? 0);
    return { sold: q(sold), returned: q(viaReturns) + q(viaCredits), lastBasePrice: last ? Number((last as Record<string, unknown>).p) : null };
  }
}
