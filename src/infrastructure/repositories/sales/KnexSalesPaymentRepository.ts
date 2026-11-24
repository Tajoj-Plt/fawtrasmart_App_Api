import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { PayableInvoice, PaymentListFilters, PaymentRow, SalesPaymentRepository } from '../../../domain/repositories/sales';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** أنواع السندات في شاشة «مدفوعات العملاء» */
const PAYMENT_TYPES = ['client payments', 'sale'];

const PAYMENT_COLUMNS = [
  'p.id',
  'p.invoice_id',
  'i.code as invoice_code',
  'i.created_by as invoice_created_by',
  'i.employee_id as invoice_employee_id',
  'i.branch_id as invoice_branch_id',
  'i.currency',
  'p.client_id',
  'i.client_id as invoice_client_id',
  'c.trade_name as client_name',
  'ic.trade_name as invoice_client_name',
  'p.branch_id',
  'b.name as branch_name',
  'p.treasury_id',
  'a.name as treasury_name',
  'p.amount',
  'p.payment_date',
  'p.Payment_method as payment_method',
  'pm.name as payment_method_name',
  'p.reference_number',
  'p.notes',
  'p.payment_status',
  'p.employee_id',
  'u.name as collector_name',
  'p.created_at',
];

function mapPayment(r: Record<string, unknown>): PaymentRow {
  return {
    id: Number(r.id),
    invoiceId: num(r.invoice_id),
    invoiceCode: str(r.invoice_code),
    invoiceCreatedBy: num(r.invoice_created_by),
    invoiceEmployeeId: num(r.invoice_employee_id),
    invoiceBranchId: num(r.invoice_branch_id),
    // سنداتٌ قديمة بلا `client_id` — العميل من فاتورتها
    clientId: num(r.client_id) ?? num(r.invoice_client_id),
    clientName: str(r.client_name) ?? str(r.invoice_client_name),
    branchId: num(r.branch_id),
    branchName: str(r.branch_name),
    treasuryId: num(r.treasury_id),
    treasuryName: str(r.treasury_name),
    amount: Number(r.amount ?? 0),
    paymentDate: str(r.payment_date),
    paymentMethod: num(r.payment_method),
    paymentMethodName: str(r.payment_method_name),
    referenceNumber: str(r.reference_number),
    notes: str(r.notes),
    paymentStatus: num(r.payment_status),
    collectorId: num(r.employee_id),
    collectorName: str(r.collector_name),
    currency: str(r.currency),
    createdAt: str(r.created_at),
  };
}

function mapPayable(r: Record<string, unknown>): PayableInvoice {
  return {
    id: Number(r.id),
    code: str(r.code),
    type: str(r.type),
    clientId: num(r.client_id),
    clientName: str(r.client_name),
    branchId: num(r.branch_id),
    createdBy: num(r.created_by),
    employeeId: num(r.employee_id),
    grandTotal: Number(r.grand_total ?? 0),
    dueValue: Number(r.due_value ?? r.grand_total ?? 0),
    walletPaidAmount: Number(r.wallet_paid_amount ?? 0),
    returnedPayment: Number(r.returned_payment ?? 0),
    paymentStatus: num(r.payment_status),
    currency: str(r.currency),
    disablePartialPayment: bool(r.disable_partial_payment),
    voidedAt: str(r.voided_at),
    invoiceDate: str(r.invoice_date),
    createdAt: str(r.created_at),
  };
}

/** قراءة سندات القبض على الفواتير — `payments_process` (`employee_id` فيه = `users.id`) */
export class KnexSalesPaymentRepository implements SalesPaymentRepository {
  constructor(private readonly db: Knex) {}

  private base(db: Knex) {
    return db('payments_process as p')
      .leftJoin('invoices as i', 'i.id', 'p.invoice_id')
      .leftJoin('clients as c', 'c.id', 'p.client_id')
      .leftJoin('clients as ic', 'ic.id', 'i.client_id')
      .leftJoin('branches as b', 'b.id', 'p.branch_id')
      .leftJoin('accounts as a', 'a.id', 'p.treasury_id')
      .leftJoin('payment_methods as pm', 'pm.id', 'p.Payment_method')
      .leftJoin('users as u', 'u.id', 'p.employee_id');
  }

  /** نطاق فاتورة السند — `scopeSalesDocuments()` على `invoices` */
  private invoiceScope(w: Knex.QueryBuilder, scope: PaymentListFilters['scope']) {
    if (scope.branchIds !== null) w.whereIn('i.branch_id', scope.branchIds.length ? scope.branchIds : [0]);
    else if (scope.userIds !== null) {
      w.where((x) => x.whereIn('i.created_by', scope.userIds!.length ? scope.userIds! : [0]).orWhereIn('i.employee_id', scope.employeeIds && scope.employeeIds.length ? scope.employeeIds : [0]));
    }
  }

  async page(f: PaymentListFilters, page: number, perPage: number) {
    const q = this.db('payments_process as p').leftJoin('invoices as i', 'i.id', 'p.invoice_id').whereIn('p.type', PAYMENT_TYPES);

    if (f.assignedEmployeeId !== null) {
      // «عملائي المُسنَدون» — عميل الفاتورة مُسنَدٌ إلى موظّفه
      q.whereExists((s) => s.select(this.db.raw(1)).from('client_employee as ce').whereRaw('ce.client_id = i.client_id').where('ce.employee_id', f.assignedEmployeeId));
    } else if (f.collectorIds !== null || f.scope.branchIds !== null || f.scope.userIds !== null) {
      q.where((w) => {
        w.whereIn('p.employee_id', f.collectorIds && f.collectorIds.length ? f.collectorIds : [0]);
        w.orWhere((x) => {
          x.whereNotNull('i.id');
          this.invoiceScope(x, f.scope);
        });
      });
    }
    if (f.headerBranchIds !== null) q.where((w) => w.whereIn('p.branch_id', f.headerBranchIds as number[]).orWhereNull('p.branch_id'));

    if (f.clientId !== undefined) q.where((w) => w.where('p.client_id', f.clientId as number).orWhere((x) => x.whereNull('p.client_id').where('i.client_id', f.clientId as number)));
    if (f.invoiceNumber) q.where('i.code', 'like', likeTerm(f.invoiceNumber));
    if (f.reference) q.where('p.reference_number', 'like', likeTerm(f.reference));
    if (f.paymentStatus !== undefined) q.where('p.payment_status', f.paymentStatus);
    if (f.amountFrom !== undefined) q.where('p.amount', '>=', f.amountFrom);
    if (f.amountTo !== undefined) q.where('p.amount', '<=', f.amountTo);
    if (f.collectedBy !== undefined) q.where('p.employee_id', f.collectedBy);
    if (f.treasuryId !== undefined) q.where('p.treasury_id', f.treasuryId);
    if (f.paymentMethod !== undefined) q.where('p.Payment_method', f.paymentMethod);
    if (f.branchIds) q.where((w) => w.whereIn('p.branch_id', f.branchIds as number[]).orWhereNull('p.branch_id'));
    if (f.search) {
      const like = likeTerm(f.search);
      const term = f.search;
      q.where((w) => {
        w.where('p.notes', 'like', like)
          .orWhere('p.reference_number', 'like', like)
          .orWhere('i.code', 'like', like)
          .orWhereExists((s) =>
            s
              .select(this.db.raw(1))
              .from('clients as sc')
              .whereRaw('sc.id = COALESCE(p.client_id, i.client_id)')
              .where((n) => n.where('sc.trade_name', 'like', like).orWhere('sc.first_name', 'like', like).orWhere('sc.last_name', 'like', like).orWhere('sc.code', 'like', like)),
          );
        if (/^\d+$/.test(term)) w.orWhere('p.id', Number(term));
      });
    }
    q.whereBetween(this.db.raw('DATE(p.payment_date)') as unknown as string, [f.start, f.end]);

    const [{ c, s }] = await q.clone().select(this.db.raw('COUNT(p.id) as c'), this.db.raw('COALESCE(SUM(p.amount), 0) as s'));
    const ids = (await q.clone().orderBy('p.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('p.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c), sum: Number(s) };
    const rows = await this.base(this.db).whereIn('p.id', ids).orderBy('p.id', 'desc').select(PAYMENT_COLUMNS);
    return { rows: rows.map(mapPayment), total: Number(c), sum: Number(s) };
  }

  async find(id: number) {
    const r = await this.base(this.db).where('p.id', id).whereIn('p.type', PAYMENT_TYPES).first(PAYMENT_COLUMNS);
    return r ? mapPayment(r) : null;
  }

  async invoices(ids: number[], tx?: Tx) {
    if (!ids.length) return [];
    const rows = await conn(this.db, tx)('invoices as i')
      .leftJoin('clients as c', 'c.id', 'i.client_id')
      .whereIn('i.id', ids)
      .select('i.id', 'i.code', 'i.type', 'i.client_id', 'c.trade_name as client_name', 'i.branch_id', 'i.created_by', 'i.employee_id', 'i.grand_total', 'i.due_value', 'i.wallet_paid_amount', 'i.returned_payment', 'i.payment_status', 'i.currency', 'i.disable_partial_payment', 'i.voided_at', 'i.invoice_date', 'i.created_at');
    return rows.map(mapPayable);
  }

  async lockInvoices(ids: number[], tx: Tx) {
    if (ids.length) await conn(this.db, tx)('invoices').whereIn('id', ids).orderBy('id').forUpdate().select('id');
  }

  async paidTotals(invoiceIds: number[], tx?: Tx) {
    const out = new Map<number, number>();
    if (!invoiceIds.length) return out;
    const rows = await conn(this.db, tx)('payments_process')
      .whereIn('invoice_id', invoiceIds)
      .where('type', 'client payments')
      .where((w) => w.whereNull('payment_status').orWhere('payment_status', '!=', 5))
      .groupBy('invoice_id')
      .select('invoice_id', this.db.raw('COALESCE(SUM(amount), 0) as paid'));
    for (const r of rows as Record<string, unknown>[]) out.set(Number(r.invoice_id), Number(r.paid ?? 0));
    return out;
  }

  async installmentInvoiceIds(invoiceIds: number[]) {
    if (!invoiceIds.length) return new Set<number>();
    const rows = await this.db('installments').whereIn('invoice_id', invoiceIds).pluck('invoice_id').catch(() => [] as unknown[]);
    return new Set((rows as unknown[]).map(Number));
  }

  /** `getClientUnpaidInvoices()` — مستحقّةٌ في النطاق، لا مرتجعة ولا مُشعَرة دائناً، الأقدم أوّلاً */
  async unpaidInvoiceIds(clientId: number, scope: PaymentListFilters['scope'], headerBranchIds: number[] | null) {
    const q = this.db('invoices as i')
      .where('i.client_id', clientId)
      .whereIn('i.payment_status', [2, 3])
      .where('i.due_value', '>', 0)
      .whereNot('i.type', 'returned')
      .whereNull('i.voided_at')
      .whereNotExists((s) => s.select(this.db.raw(1)).from('invoices as r').where('r.type', 'returned').whereRaw('r.reference_number = i.id'))
      .whereNotExists((s) => s.select(this.db.raw(1)).from('credit_notifications as cn').whereRaw('cn.invoice_id = i.id').whereNotIn('cn.status', [0, 5]));
    this.invoiceScope(q, scope);
    if (headerBranchIds !== null) q.where((w) => w.whereIn('i.branch_id', headerBranchIds).orWhereNull('i.branch_id'));
    return (await q.orderBy('i.created_at', 'asc').orderBy('i.id', 'asc').pluck('i.id')).map(Number);
  }

  async clientAssignedTo(employeeId: number, clientId: number) {
    return Boolean(await this.db('client_employee').where({ employee_id: employeeId, client_id: clientId }).first('id'));
  }

  /** قيد السند — بفاتورته ونوع «تحصيل» ورقمه */
  async entryFor(invoiceId: number, reference: string | null) {
    const q = this.db('journal_entries').where('invoice_id', invoiceId).where('reference_type', 'REC');
    if (reference) q.where('reference_number', reference);
    const r = await q.orderBy('id', 'desc').first('id', 'reference_number', 'date');
    return r ? { id: Number(r.id), referenceNumber: str(r.reference_number), date: str(r.date) } : null;
  }
}
