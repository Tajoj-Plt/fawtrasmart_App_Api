import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository } from '../../../domain/repositories/clients';
import { SalesRepository } from '../../../domain/repositories/sales';
import { StockRepository } from '../../../domain/repositories/stock';
import { couponMessage, evaluateCoupon } from '../../../domain/services/sales/PromotionRules';
import { fmtMoney } from '../../../domain/services/sales/SalesMath';
import { SALES_PERMISSIONS, SALES_PLAN, SALES_SECTIONS } from '../../../domain/services/sales/SalesConstants';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { SalesSettings, TreasuryGuard } from '../../services/sales/SalesSettings';

export interface CatalogQuery {
  warehouseId?: number;
  search?: string;
  page?: number;
  perPage?: number;
  productIds?: number[];
  /** إشعارٌ دائن يُعيد البضاعة: أصناف المستودع ولو نفد رصيدها */
  includeOutOfStock?: boolean;
}

/**
 * ما تحتاجه شاشة فاتورة البيع قبل الحفظ — `InvoicesController::create()` و`getPrice()`
 * و`checkCoupon()`: الإعدادات الحاكمة، والضرائب، وطرق الدفع، ومصادر الطلب،
 * والمستودعات والخزائن المتاحة، وكتالوج الأصناف بوحداتها وأرصدتها.
 */
export class SalesSetupUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly sales: SalesRepository,
    private readonly stock: StockRepository,
    private readonly settings: SalesSettings,
    private readonly treasuries: TreasuryGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly reference: ClientsReferenceRepository,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string = SALES_PERMISSIONS.invoicesCreate) {
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.invoices], permissions: [permission] });
  }

  async createData(userId: number, meta: RequestMeta) {
    const ctx = await this.load(userId, meta);
    const rules = await this.settings.rules();
    const [maxPercent, taxes, methods, sources, required, defaultSource, warehouses, treasuries, priceLists, currency, nextNumber] = await Promise.all([
      this.settings.maxDiscountPercent(rules, ctx.user.branchId),
      this.sales.taxes(),
      this.sales.paymentMethods(),
      this.sales.orderSources(),
      this.settings.orderSourceRequired(),
      this.settings.resolveOrderSource(null),
      ctx.warehouseOptions(rules.warehouseSource),
      this.treasuries.depositable(ctx),
      this.sales.priceLists(),
      this.reference.defaultCurrency(),
      this.numbers.peek(SALES_SECTIONS.invoice, ctx.now).catch(() => ''),
    ]);
    const names = await this.stock.warehouseNames(warehouses);

    return {
      nextNumber,
      currency: currency?.code ?? 'SAR',
      rules: {
        noSellBelowCost: rules.flag('no_sell_below_cost'),
        enableMaxDiscount: rules.flag('enable_max_discount'),
        maxDiscountType: rules.maxDiscountType,
        maxDiscountPercent: rules.flag('enable_max_discount') ? maxPercent : null,
        maxDiscountAmount: rules.flag('enable_max_discount') ? rules.maxDiscountAmount() : null,
        autoPayIfBalance: rules.flag('auto_pay_if_balance'),
        autoPayFromWallet: rules.flag('auto_pay_from_wallet'),
        manualInvoiceStatus: rules.flag('manual_invoice_status'),
        defaultPaidStatus: rules.flag('default_paid_status'),
        enableCoupons: rules.flag('enable_coupons'),
        selectPriceList: rules.flag('select_price_list'),
        showInvoiceProfit: rules.flag('show_invoice_profit'),
        customJournalDescription: rules.flag('custom_journal_description'),
        warehouseSource: rules.warehouseSource,
      },
      permissions: {
        bypassLocation: ctx.can(SALES_PERMISSIONS.invoicesBypassLocation),
        invoiceDebtClients: ctx.can(SALES_PERMISSIONS.debtClient),
      },
      taxes: taxes.map((t) => ({ id: t.id, name: t.name, rate: t.rate, type: t.type })),
      paymentMethods: methods,
      orderSources: { mandatory: required, defaultId: defaultSource?.id ?? null, list: sources },
      warehouses: warehouses.map((id) => ({ id, name: names.get(id) ?? '' })),
      treasuries: treasuries.map((t) => ({ accountId: t.accountId, name: t.name, type: t.type })),
      priceLists: rules.flag('select_price_list') ? priceLists : [],
    };
  }

  /** كتالوج الأصناف — أصناف مستودع البيع (والخدمي/الرقمي بحسب الإعداد) بوحداتها وأرصدتها */
  async catalog(userId: number, meta: RequestMeta, q: CatalogQuery) {
    const ctx = await this.load(userId, meta);
    const rules = await this.settings.rules();
    const warehouseId = await this.catalogWarehouse(ctx, rules.warehouseSource, q.warehouseId);

    const perPage = Math.min(Math.max(q.perPage ?? 50, 1), 200);
    const page = Math.max(q.page ?? 1, 1);
    // الموظف: مستودعه أو الأصناف بلا رصيد المسموح عرضها — وغير الموظف كل الأصناف.
    // وما لم يُسمح بالمخزون السالب لا يرى الموظف صنفاً رصيدُه في مستودعه صفر (لا يبيع ما ليس عنده).
    // جلبُ أصنافٍ بعينها (`productIds` — بنود مستندٍ قائم) لا يُقيَّد بالرصيد فلا تختفي بنوده.
    const scoped = ctx.isEmployee ? warehouseId : null;
    const inStockOnly = ctx.isEmployee && !q.productIds && !q.includeOutOfStock && !(await this.sales.negativeStockAllowed());
    const all = await this.sales.sellableProducts(scoped, ctx.isEmployee ? rules.stocklessTypes() : [], q.search, 5000, q.productIds, inStockOnly);
    const slice = all.slice((page - 1) * perPage, page * perPage);

    const [units, stock] = await Promise.all([this.sales.unitsFor(slice), this.sales.stockIn(ctx.isEmployee ? warehouseId : null, slice.map((p) => p.id))]);

    return {
      warehouseId,
      total: all.length,
      page,
      perPage,
      lastPage: Math.max(1, Math.ceil(all.length / perPage)),
      items: slice.map((p) => {
        const list = units.get(p.id) ?? [];
        return {
          id: p.id,
          name: p.name,
          barcode: p.barcode,
          serialNumber: p.serialNumber,
          type: p.type,
          salePrice: p.salePrice,
          purchasePrice: p.purchasePrice,
          minSalePrice: p.minSalePrice,
          availableQuantity: stock.get(p.id) ?? 0,
          tax1Id: p.tax1,
          tax2Id: p.tax2,
          hasUnits: list.length > 0,
          units: list,
        };
      }),
    };
  }

  private async catalogWarehouse(ctx: SalesContext, source: 'employee' | 'main', requested: number | undefined): Promise<number | null> {
    const options = await ctx.warehouseOptions(source);
    if (requested !== undefined) {
      if (ctx.isEmployee && !options.includes(requested)) throw AppError.forbidden('WAREHOUSE_FORBIDDEN', 'لا تملك صلاحية إنشاء فاتورة من هذا المستودع.');
      if (!(await this.stock.warehouse(requested))) throw AppError.notFound('WAREHOUSE_NOT_FOUND', 'المستودع غير موجود.');
      return requested;
    }
    return options[0] ?? null;
  }

  /** `getPrice()` — سعر الصنف في قائمة الأسعار */
  async price(userId: number, meta: RequestMeta, priceListId: number, productId: number) {
    await this.load(userId, meta);
    return { price: await this.sales.priceListPrice(priceListId, productId) };
  }

  /** `checkCoupon()` — معاينة الكوبون قبل الحفظ */
  async checkCoupon(userId: number, meta: RequestMeta, q: { code: string; clientId?: number; amount?: number; productIds?: number[]; shippingCost?: number }) {
    const ctx = await this.load(userId, meta);
    const rules = await this.settings.rules();
    if (!rules.flag('enable_coupons')) return { ok: false, code: null, discount: 0, freeShipping: false, message: couponMessage('disabled') };
    if (q.clientId) await ctx.assertClient(q.clientId);

    const clientId = q.clientId ?? null;
    const coupon = await this.sales.coupon(q.code.trim());
    const result = await evaluateCoupon(coupon, q.code.trim(), clientId, q.amount ?? 0, q.productIds ?? [], q.shippingCost ?? 0, {
      now: ctx.nowSql,
      usageCount: () => this.sales.couponUsageCount(coupon?.id ?? 0, null),
      clientUsageCount: () => this.sales.couponUsageCount(coupon?.id ?? 0, clientId),
      hasEarlierPurchase: () => this.sales.clientHasInvoices(clientId ?? 0),
      productsInCategories: (categories) => this.sales.productsInCategories(q.productIds ?? [], categories),
    });
    if (!result.ok) return { ok: false, code: null, discount: 0, freeShipping: false, message: result.error };
    return {
      ok: true,
      code: result.coupon.code,
      discount: result.discount,
      freeShipping: result.freeShipping,
      message: result.freeShipping ? `طُبِّق الكوبون ${result.coupon.code} — شحنٌ مجانيّ` : `طُبِّق الكوبون ${result.coupon.code} — خصمٌ ${fmtMoney(result.discount)}`,
    };
  }
}
