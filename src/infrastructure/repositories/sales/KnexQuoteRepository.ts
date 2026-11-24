import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { QuoteListFilters, QuoteRepository, QuoteRow } from '../../../domain/repositories/sales';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const COLUMNS = ['q.*', 'c.trade_name as client_name', 'u.name as created_by_name', 'e.first_name as employee_first', 'e.middle_name as employee_middle', 'i.code as invoice_code'];

function map(r: Record<string, unknown>): QuoteRow {
  return {
    id: Number(r.id),
    type: String(r.type ?? 'quote'),
    number: str(r.quote_number),
    clientId: num(r.client_id),
    clientName: str(r.client_name),
    branchId: num(r.branch_id),
    invoiceId: num(r.invoice_id),
    invoiceCode: str(r.invoice_code),
    createdBy: num(r.created_by),
    createdByName: str(r.created_by_name),
    employeeId: num(r.employee_id),
    employeeName: `${r.employee_first ?? ''} ${r.employee_middle ?? ''}`.trim() || null,
    quoteDate: str(r.quote_date),
    expiryDate: str(r.expiry_date),
    paymentTerms: str(r.payment_terms),
    currency: str(r.currency),
    discountType: str(r.discount_type),
    discountAmount: Number(r.discount_amount ?? 0),
    shippingCost: Number(r.shipping_cost ?? 0),
    shippingTax: Number(r.shipping_tax ?? 0),
    taxType: str(r.tax_type),
    subtotal: Number(r.subtotal ?? 0),
    totalDiscount: Number(r.total_discount ?? 0),
    totalTax: Number(r.total_tax ?? 0),
    grandTotal: Number(r.grand_total ?? 0),
    status: String(r.status ?? 'Draft'),
    notes: str(r.notes),
    createdAt: str(r.created_at),
  };
}

/** `quotes` (عرض السعر وأمر البيع بعمود `type`) وبنودها في `invoice_items.quotation_id` */
export class KnexQuoteRepository implements QuoteRepository {
  constructor(private readonly db: Knex) {}

  private base(db: Knex) {
    return db('quotes as q')
      .leftJoin('clients as c', 'c.id', 'q.client_id')
      .leftJoin('users as u', 'u.id', 'q.created_by')
      .leftJoin('employees as e', 'e.id', 'q.employee_id')
      .leftJoin('invoices as i', 'i.id', 'q.invoice_id');
  }

  // `quotes` بلا `updated_at` — `created_at` وحده
  async insert(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('quotes').insert({ ...row, created_at: now });
    return Number(id);
  }

  async update(id: number, patch: Record<string, unknown>, tx: Tx) {
    await conn(this.db, tx)('quotes').where('id', id).update(patch);
  }

  async delete(id: number, docType: string, tx: Tx) {
    const db = conn(this.db, tx);
    await db('invoice_items').where('quotation_id', id).del();
    await db('taxs_invoice').where('invoice_id', id).where('type_invoice', docType).del();
    await db('quotes').where('id', id).del();
  }

  async find(id: number, type: string, tx?: Tx) {
    const r = await this.base(conn(this.db, tx)).where('q.id', id).where('q.type', type).first(COLUMNS);
    return r ? map(r) : null;
  }

  async lock(id: number, tx: Tx) {
    await conn(this.db, tx)('quotes').where('id', id).forUpdate().select('id');
  }

  async replaceItems(id: number, docType: string, items: Array<Record<string, unknown>>, taxRows: Array<Record<string, unknown>>, now: string, tx: Tx) {
    const db = conn(this.db, tx);
    await db('invoice_items').where('quotation_id', id).del();
    await db('taxs_invoice').where('invoice_id', id).where('type_invoice', docType).del();
    if (items.length) await db('invoice_items').insert(items.map((i) => ({ ...i, quotation_id: id, created_at: now, updated_at: now })));
    if (taxRows.length) await db('taxs_invoice').insert(taxRows.map((t) => ({ ...t, invoice_id: id, type_invoice: docType, created_at: now, updated_at: now })));
  }

  async page(f: QuoteListFilters, page: number, perPage: number) {
    const q = this.db('quotes as q').where('q.type', f.type);
    const { branchIds, userIds, employeeIds } = f.scope;
    if (branchIds !== null) q.whereIn('q.branch_id', branchIds.length ? branchIds : [0]);
    else if (userIds !== null) q.where((w) => w.whereIn('q.created_by', userIds.length ? userIds : [0]).orWhereIn('q.employee_id', employeeIds && employeeIds.length ? employeeIds : [0]));
    if (f.headerBranchIds !== null) q.where((w) => w.whereIn('q.branch_id', f.headerBranchIds as number[]).orWhereNull('q.branch_id'));
    if (f.clientId !== undefined) q.where('q.client_id', f.clientId);
    if (f.number) q.where('q.quote_number', 'like', likeTerm(f.number));
    if (f.status) q.where('q.status', f.status);
    if (f.fromDate) q.where('q.quote_date', '>=', f.fromDate);
    if (f.toDate) q.where('q.quote_date', '<=', f.toDate);
    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'q.id' });
    const ids = (await q.clone().orderBy('q.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('q.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c) };
    const rows = await this.base(this.db).whereIn('q.id', ids).orderBy('q.id', 'desc').select(COLUMNS);
    return { rows: rows.map(map), total: Number(c) };
  }
}
