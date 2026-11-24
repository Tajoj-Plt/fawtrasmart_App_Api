import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { InvoiceRow, SalesRepository } from '../../../domain/repositories/sales';
import { PAYMENT_STATUS_LABELS, SALE_TYPES, SALES_PERMISSIONS, SALES_PLAN } from '../../../domain/services/sales/SalesConstants';
import { ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientVisibility } from '../../services/clients/ClientVisibility';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';

const PER_PAGE = [10, 25, 50, 100];

export interface InvoiceListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  invoiceNumber?: string;
  /** غائبة = كل العملات (كشاشة الويب) */
  currency?: string;
  branch?: number;
  paymentStatus?: number;
  item?: string;
  totalFrom?: number;
  totalTo?: number;
  fromDate?: string;
  toDate?: string;
  createdBy?: number;
  employeeId?: number;
  dueState?: 'all' | 'has_terms' | 'overdue' | 'due_soon';
}

/** قراءة فواتير البيع — `InvoicesController::index()` و`show()` بنطاق الرؤية وفرع الشريط */
export class InvoiceQueryUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly sales: SalesRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly clientContexts: ClientsContextFactory,
    private readonly visibility: ClientVisibility,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string = SALES_PERMISSIONS.invoicesView) {
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.invoices], permissions: [permission] });
  }

  /** `defaultReportRange()` — السنة المالية لليوم، وإلا فترته، وإلا من أوّل مستند إلى آخر السنة */
  async range(ctx: SalesContext, from?: string, to?: string) {
    let start = from;
    let end = to;
    if (!start || !end) {
      const def = (await this.sales.fiscalYearFor(ctx.today)) ?? { start: `${ctx.today.slice(0, 4)}-01-01`, end: `${ctx.today.slice(0, 4)}-12-31` };
      start = start ?? def.start;
      end = end ?? def.end;
    }
    return start > end ? { start: end, end: start } : { start, end };
  }

  private summary(row: InvoiceRow, flags: { returned: boolean; creditNote: boolean }) {
    const blockReturn = row.type === 'returned' ? 'هذا المستند مرتجعٌ لا فاتورة بيع — لا يُعمل له مرتجع.' : flags.returned ? 'لهذه الفاتورة مرتجعٌ سابق، ولا يُعمل لها مرتجعٌ آخر.' : flags.creditNote ? 'صدر لهذه الفاتورة إشعارٌ دائن — يُعدّ مرتجعاً، فلا يُعمل لها مرتجعٌ آخر.' : null;
    return {
      id: row.id,
      code: row.code,
      type: row.type,
      client: row.clientId ? { id: row.clientId, tradeName: row.clientName, code: row.clientCode } : null,
      branch: row.branchId ? { id: row.branchId, name: row.branchName } : null,
      employee: row.employeeId ? { id: row.employeeId, name: row.employeeName } : null,
      createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName } : null,
      invoiceDate: row.invoiceDate,
      issueDate: row.issueDate,
      paymentTerms: row.paymentTerms ? Number(row.paymentTerms) : null,
      currency: row.currency,
      subtotal: row.subtotal,
      discountAmount: row.discountAmount,
      couponCode: row.couponCode,
      couponDiscount: row.couponDiscount,
      shippingCost: row.shippingCost,
      shippingTax: row.shippingTax,
      taxTotal: row.taxTotal,
      grandTotal: row.grandTotal,
      advancePayment: row.advancePayment,
      dueValue: row.dueValue,
      returnedPayment: row.returnedPayment,
      walletPaidAmount: row.walletPaidAmount,
      paymentStatus: row.paymentStatus,
      paymentStatusLabel: row.paymentStatus ? PAYMENT_STATUS_LABELS[row.paymentStatus] ?? null : null,
      isPaid: row.isPaid,
      voided: row.voidedAt !== null,
      hasReturn: flags.returned,
      canReturn: blockReturn === null,
      returnBlockedReason: blockReturn,
      canCreditNote: blockReturn === null,
      createdAt: row.createdAt,
    };
  }

  async list(userId: number, meta: RequestMeta, q: InvoiceListQuery) {
    const ctx = await this.load(userId, meta);
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;
    const { start, end } = await this.range(ctx, q.fromDate, q.toDate);
    const defaultCurrency = (await this.reference.defaultCurrency())?.code ?? 'SAR';

    const { rows, total } = await this.sales.invoicePage(
      {
        scope: await ctx.documentScope(),
        headerBranchIds: await ctx.headerBranchIds(),
        clientId: q.clientId,
        invoiceNumber: q.invoiceNumber?.trim() || undefined,
        currency: q.currency?.trim() ? q.currency.trim() : null,
        defaultCurrency,
        branchIds: q.branch ? (ctx.tree.find(q.branch) ? ctx.tree.subtree(q.branch) : [q.branch]) : undefined,
        paymentStatus: q.paymentStatus,
        item: q.item?.trim() || undefined,
        totalFrom: q.totalFrom,
        totalTo: q.totalTo,
        start,
        end,
        closedRanges: await this.sales.closedRanges(),
        createdBy: q.createdBy,
        employeeId: q.employeeId,
        dueState: q.dueState && q.dueState !== 'all' ? q.dueState : undefined,
      },
      page,
      perPage,
    );

    const ids = rows.map((r) => r.id);
    const [returned, credited] = await Promise.all([this.sales.returnedInvoiceIds(ids), this.sales.activeCreditNoteInvoiceIds(ids)]);
    return {
      items: rows.map((r) => this.summary(r, { returned: returned.has(r.id), creditNote: credited.has(r.id) })),
      total,
      page,
      perPage,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      range: { from: start, to: end },
    };
  }

  /** `show()` — نطاق المستند، أو «عملائي المُسنَدون» مع الوصول إلى العميل */
  async find(ctx: SalesContext, id: number): Promise<InvoiceRow> {
    const row = await this.sales.invoice(id);
    if (!row || !(SALE_TYPES as readonly string[]).includes(row.type ?? '')) throw AppError.notFound('INVOICE_NOT_FOUND', 'الفاتورة غير موجودة.');
    if (await ctx.canAccessDocument(row.createdBy, row.employeeId, row.branchId)) return row;
    if (ctx.can(SALES_PERMISSIONS.invoicesViewAssignedClients) && row.clientId) {
      const cctx = await this.clientContexts.load(ctx.user.id, ctx.meta, undefined, { module: false });
      if (await this.visibility.canAccess(cctx, row.clientId)) return row;
    }
    throw AppError.forbidden('DOCUMENT_FORBIDDEN', 'غير مصرح لك بعرض هذه الفاتورة');
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta);
    return this.detail(ctx, id);
  }

  async detail(ctx: SalesContext, id: number) {
    const row = await this.find(ctx, id);
    const [items, payments, returned, credited] = await Promise.all([
      this.sales.invoiceItems(row.id),
      this.sales.invoicePayments(row.id),
      this.sales.returnedInvoiceIds([row.id]),
      this.sales.activeCreditNoteInvoiceIds([row.id]),
    ]);
    return {
      ...this.summary(row, { returned: returned.has(row.id), creditNote: credited.has(row.id) }),
      notes: row.notes,
      qrcode: row.qrcode,
      items: items.map((i) => ({
        id: i.id,
        productId: i.productId,
        item: i.item,
        description: i.description,
        unitName: i.unitName,
        productUnitId: i.productUnitId,
        warehouse: i.storeHouseId ? { id: i.storeHouseId, name: i.storeHouseName } : null,
        quantity: i.quantity,
        quantityInBaseUnit: i.quantityInBaseUnit,
        conversionFactor: i.conversionFactor,
        unitPrice: i.unitPrice,
        discount: i.discount,
        discountType: i.discountType === 2 ? 'percentage' : 'amount',
        tax1: i.tax1,
        tax1Id: i.tax1Id,
        tax2: i.tax2,
        tax2Id: i.tax2Id,
        total: i.total,
        isGift: i.unitPrice === 0 && i.item.endsWith('(هدية)'),
      })),
      payments,
    };
  }

  /**
   * بيانات المنشأة لترويسة المستندات المطبوعة (فاتورة، إشعار دائن، سند قبض) — اسمٌ ورقمٌ ضريبي.
   * يكفي الدخول إلى وحدة المبيعات: صلاحية طباعة كل مستندٍ تُفحص في التطبيق عند زرّه، والبيانات
   * نفسها تظهر على كل مستندٍ يراه المستخدم.
   */
  async business(userId: number, meta: RequestMeta) {
    await this.contexts.load(userId, meta);
    return this.sales.businessInfo();
  }

  /** بيانات الطباعة — المنشأة ورقمها الضريبي ورمز QR */
  async print(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.invoicesPrint);
    const [invoice, business] = await Promise.all([this.detail(ctx, id), this.sales.businessInfo()]);
    return { business, invoice };
  }
}
