import { Knex } from 'knex';
import { Paginated } from '../../domain/entities/accounting';
import { CreditNoteRow, DateRange, InvoiceRow, PaymentRow, QuoteRow, SalesListQuery, SalesOverviewFigures, SalesScope } from '../../domain/entities/sales';
import { SalesListResult, SalesCatalogRepository } from '../../domain/repositories/salesCatalog';

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function paginate<T>(rows: T[], total: number, page: number, perPage: number): Paginated<T> {
  return { items: rows, total, page, perPage };
}

/** يقيَّد استعلامٌ بنطاق المستخدمين/الموظفين معاً (`OR`) — محور الأشخاص لا يُقسَّم فرعاً/منشئاً هنا */
function applyScope(qb: Knex.QueryBuilder, scope: SalesScope, creatorColumn: string | null, employeeColumn: string | null): Knex.QueryBuilder {
  if (scope.mode === 'unrestricted') return qb;

  return qb.where((w) => {
    let any = false;
    if (creatorColumn) {
      w.whereIn(creatorColumn, scope.userIds.length ? scope.userIds : [0]);
      any = true;
    }
    if (employeeColumn) {
      const fn = any ? 'orWhereIn' : 'whereIn';
      w[fn](employeeColumn, scope.employeeIds.length ? scope.employeeIds : [0]);
    }
  });
}

function applyRange(qb: Knex.QueryBuilder, column: string, range: DateRange): Knex.QueryBuilder {
  if (range.from) qb.where(column, '>=', range.from);
  if (range.to) qb.where(column, '<=', range.to);
  return qb;
}

export class KnexSalesCatalogRepository implements SalesCatalogRepository {
  constructor(private readonly db: Knex) {}

  async invoices(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<InvoiceRow>> {
    const base = () => {
      let qb = this.db('invoices').leftJoin('clients', 'clients.id', 'invoices.client_id').where('invoices.type', '!=', 'returned');
      qb = applyScope(qb, scope, 'invoices.created_by', 'invoices.employee_id');
      qb = applyRange(qb, 'invoices.invoice_date', range);
      if (q.status) qb = qb.where('invoices.payment_status', Number(q.status));
      if (q.search) qb = qb.where((w) => w.where('invoices.code', 'like', `%${q.search}%`).orWhere('clients.trade_name', 'like', `%${q.search}%`));
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('invoices.id', 'invoices.code', 'invoices.invoice_date', 'clients.trade_name as client_name', 'invoices.grand_total', 'invoices.payment_status', 'invoices.currency')
      .orderBy('invoices.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(rows.map((r: Record<string, unknown>) => this.toInvoiceRow(r)), total, q.page, q.perPage);
  }

  async returns(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<InvoiceRow>> {
    const base = () => {
      let qb = this.db('invoices').leftJoin('clients', 'clients.id', 'invoices.client_id').where('invoices.type', 'returned');
      qb = applyScope(qb, scope, 'invoices.created_by', 'invoices.employee_id');
      qb = applyRange(qb, 'invoices.invoice_date', range);
      if (q.search) qb = qb.where((w) => w.where('invoices.code', 'like', `%${q.search}%`).orWhere('clients.trade_name', 'like', `%${q.search}%`));
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('invoices.id', 'invoices.code', 'invoices.invoice_date', 'clients.trade_name as client_name', 'invoices.grand_total', 'invoices.payment_status', 'invoices.currency')
      .orderBy('invoices.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(rows.map((r: Record<string, unknown>) => this.toInvoiceRow(r)), total, q.page, q.perPage);
  }

  private toInvoiceRow(r: Record<string, unknown>): InvoiceRow {
    return {
      id: num(r.id),
      code: str(r.code),
      date: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null,
      clientName: str(r.client_name),
      grandTotal: r.grand_total === null || r.grand_total === undefined ? null : num(r.grand_total),
      paymentStatus: r.payment_status === null || r.payment_status === undefined ? null : num(r.payment_status),
      currency: str(r.currency),
    };
  }

  async quotes(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<QuoteRow>> {
    const base = () => {
      let qb = this.db('quotes').leftJoin('clients', 'clients.id', 'quotes.client_id').where('quotes.type', '!=', 'sales_order');
      qb = applyScope(qb, scope, 'quotes.created_by', null);
      qb = applyRange(qb, 'quotes.quote_date', range);
      if (q.search) qb = qb.where((w) => w.where('quotes.quote_number', 'like', `%${q.search}%`).orWhere('clients.trade_name', 'like', `%${q.search}%`));
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('quotes.id', 'quotes.quote_number', 'quotes.quote_date', 'clients.trade_name as client_name', 'quotes.grand_total')
      .orderBy('quotes.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        number: str(r.quote_number),
        date: r.quote_date ? String(r.quote_date).slice(0, 10) : null,
        clientName: str(r.client_name),
        grandTotal: r.grand_total === null || r.grand_total === undefined ? null : num(r.grand_total),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async creditNotes(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<CreditNoteRow>> {
    const base = () => {
      let qb = this.db('credit_notifications').leftJoin('clients', 'clients.id', 'credit_notifications.client_id');
      qb = applyScope(qb, scope, 'credit_notifications.created_by', null);
      qb = applyRange(qb, 'credit_notifications.credit_date', range);
      if (q.status) qb = qb.where('credit_notifications.status', Number(q.status));
      if (q.search) qb = qb.where((w) => w.where('credit_notifications.credit_number', 'like', `%${q.search}%`).orWhere('clients.trade_name', 'like', `%${q.search}%`));
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('credit_notifications.id', 'credit_notifications.credit_number', 'credit_notifications.credit_date', 'clients.trade_name as client_name', 'credit_notifications.grand_total', 'credit_notifications.status')
      .orderBy('credit_notifications.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        number: str(r.credit_number),
        date: r.credit_date ? String(r.credit_date).slice(0, 10) : null,
        clientName: str(r.client_name),
        grandTotal: r.grand_total === null || r.grand_total === undefined ? null : num(r.grand_total),
        status: r.status === null || r.status === undefined ? null : num(r.status),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async payments(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<PaymentRow>> {
    const base = () => {
      let qb = this.db('payments_process').leftJoin('clients', 'clients.id', 'payments_process.client_id').whereNotNull('payments_process.invoice_id');
      qb = applyScope(qb, scope, null, 'payments_process.employee_id');
      qb = applyRange(qb, 'payments_process.payment_date', range);
      if (q.search) qb = qb.where('clients.trade_name', 'like', `%${q.search}%`);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('payments_process.id', 'payments_process.payment_date', 'clients.trade_name as client_name', 'payments_process.amount', 'payments_process.Payment_method')
      .orderBy('payments_process.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        date: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
        clientName: str(r.client_name),
        amount: num(r.amount),
        method: r.Payment_method === null || r.Payment_method === undefined ? null : num(r.Payment_method),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async overview(scope: SalesScope, range: DateRange, want: { invoices: boolean; quotes: boolean; payments: boolean }): Promise<SalesOverviewFigures> {
    const invoicesBase = () => applyRange(applyScope(this.db('invoices').where('invoices.type', '!=', 'returned'), scope, 'invoices.created_by', 'invoices.employee_id'), 'invoices.invoice_date', range);
    const quotesBase = () => applyRange(applyScope(this.db('quotes').where('quotes.type', '!=', 'sales_order'), scope, 'quotes.created_by', null), 'quotes.quote_date', range);
    const paymentsBase = () => applyRange(applyScope(this.db('payments_process').whereNotNull('payments_process.invoice_id'), scope, null, 'payments_process.employee_id'), 'payments_process.payment_date', range);

    const [invoicesTotals, quotesCount, paymentsTotals] = await Promise.all([
      want.invoices ? invoicesBase().select(this.db.raw('sum(grand_total) as total, count(*) as n')).first() : Promise.resolve(null),
      want.quotes ? num((await quotesBase().count({ n: '*' }).first())?.n) : Promise.resolve(null),
      want.payments ? paymentsBase().select(this.db.raw('sum(amount) as total')).first() : Promise.resolve(null),
    ]);

    return {
      invoicesTotal: invoicesTotals ? num((invoicesTotals as Record<string, unknown>).total) : null,
      invoicesCount: invoicesTotals ? num((invoicesTotals as Record<string, unknown>).n) : null,
      quotesCount,
      paymentsTotal: paymentsTotals ? num((paymentsTotals as Record<string, unknown>).total) : null,
    };
  }
}
