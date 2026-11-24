import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository, OperationLogRepository } from '../../../domain/repositories/clients';
import { SalesProduct, SalesRepository, SalesUnitOption, SalesWriteRepository, StockRow } from '../../../domain/repositories/sales';
import { LedgerRepository, StockRepository } from '../../../domain/repositories/stock';
import { VisitRepository } from '../../../domain/repositories/visits';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { calculateInvoice, CalcTotals } from '../../../domain/services/sales/InvoiceCalculator';
import { bestGift, bestOfferDiscount, Coupon, couponMessage, evaluateCoupon, offerCoversClient } from '../../../domain/services/sales/PromotionRules';
import { allocateDocumentDiscount, fmtMoney, fmtQty, normalizeAmount, phpRound, round2, TaxBook, taxLine } from '../../../domain/services/sales/SalesMath';
import { PAYMENT_STATUS, SALES_LIMITS, SALES_LOG_MODULE, SALES_PERMISSIONS, SALES_PERMIT_SOURCE, SALES_PLAN, SALES_REFERENCE, SALES_SECTIONS, WAREHOUSE_ADD_SOURCE } from '../../../domain/services/sales/SalesConstants';
import { Tx, UnitOfWork } from '../../ports';
import { LedgerAccounts } from '../../services/accounting/LedgerAccounts';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { NotificationGate } from '../../services/clients/ClientsSupport';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { InvoiceRules, SalesSettings, TreasuryGuard } from '../../services/sales/SalesSettings';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { SalesProximity } from '../../services/sales/SalesProximity';
import { JournalHeader, JournalLine, JournalOwner, SalesJournal } from '../../services/sales/SalesJournal';
import { AccountBalances } from '../../services/stock/AccountBalances';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { InvoiceQueryUseCases } from './InvoiceQueryUseCases';

/** سقوف الأعمدة — جلسة Node غير صارمة فتقصّ ما يزيد بصمت */
const MAX_MONEY = 99_999_999.99; // decimal(10,2)
const MAX_QUANTITY = 99_999_999_999; // decimal(15,4)
const MAX_TEXT_BYTES = 65_535;
const MAX_ITEMS = 200;

interface ItemInput {
  productId: number;
  unitId: number | null;
  categoryUnitId: number | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  discountType: 'amount' | 'percentage';
  tax1Id: number | null;
  tax2Id: number | null;
  warehouseId: number | null;
  description: string | null;
}

interface InvoiceInput {
  clientId: number;
  invoiceDate: string;
  issueDate: string;
  terms: number;
  employeeId: number | null;
  warehouseId: number | null;
  orderSourceId: number | null;
  notes: string | null;
  journalDescription: string | null;
  referenceNumber: string | null;
  discountValue: number;
  discountType: 'amount' | 'percentage';
  couponCode: string | null;
  shippingCost: number;
  shippingTaxSelector: boolean;
  shippingTaxId: number | null;
  advancePayment: number;
  isPaid: boolean;
  paymentStatus: number | null;
  paymentMethod: number | null;
  treasuryId: number | null;
  latitude: number | null;
  longitude: number | null;
  items: ItemInput[];
}

/** بندٌ جاهزٌ للكتابة — بنود المستخدم ثم الهدايا */
interface LineDraft {
  product: SalesProduct;
  warehouseId: number | null;
  productUnitId: number | null;
  conversionFactor: number;
  unitName: string;
  quantity: number;
  baseQuantity: number;
  unitPrice: number;
  discount: number;
  discountType: 1 | 2;
  tax1: number;
  tax1Id: number | null;
  tax2: number;
  tax2Id: number | null;
  total: number;
  item: string;
  description: string | null;
  gift: boolean;
}

const fail = (message: string, field = 'invoice', code = 'VALIDATION_ERROR') => (code === 'VALIDATION_ERROR' ? AppError.validation({ [field]: [message] }, message) : new AppError(code, message, 422));

/**
 * إصدار فاتورة بيع — `InvoicesController::persistInvoice()` بترتيبه، مع إصلاح ما وُجد فيه:
 * تحقّقٌ كامل من المدخلات، ونطاق العميل، والإذن المخزني على مستودع كل بند، وقيدٌ بتاريخ
 * الفاتورة متوازن، وعملةٌ تُكتب، وضرائب `taxs_invoice` بعد الخصم، وقيد تكلفةٍ لا يُبتلع فشلُه.
 */
export class InvoiceCreateUseCase {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly sales: SalesRepository,
    private readonly writes: SalesWriteRepository,
    private readonly stock: StockRepository,
    private readonly ledger: LedgerRepository,
    private readonly accounts: LedgerAccounts,
    private readonly balances: AccountBalances,
    private readonly settings: SalesSettings,
    private readonly treasuries: TreasuryGuard,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly notifications: NotificationGate,
    private readonly visits: VisitRepository,
    private readonly logs: OperationLogRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly queries: InvoiceQueryUseCases,
    private readonly journal: SalesJournal,
    private readonly proximity: SalesProximity,
    private readonly uow: UnitOfWork,
  ) {}

  // ═══════════════════════ قراءة الطلب ═══════════════════════

  private parse(body: Record<string, unknown>, book: TaxBook, today: string): InvoiceInput {
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);

    const clientId = form.integer('clientId', { required: true, min: 1, message: 'اختر العميل.' });
    const dateField = (key: string, fallback: string) => {
      const text = form.string(key);
      if (text === null) return fallback;
      const d = parseInputDate(text);
      if (!d) {
        errors.add(key, 'التاريخ بصيغة YYYY-MM-DD.');
        return fallback;
      }
      return toSqlDate(d);
    };
    const invoiceDate = dateField('invoiceDate', today);
    const issueDate = dateField('issueDate', invoiceDate);
    const terms = form.integer('terms', { min: 0, max: 3650 }) ?? 0;
    const employeeId = form.integer('employeeId', { min: 1 });
    const warehouseId = form.integer('warehouseId', { min: 1 });
    const orderSourceId = form.integer('orderSourceId', { min: 1 });
    const notes = form.string('notes');
    if (notes !== null && Buffer.byteLength(notes, 'utf8') > MAX_TEXT_BYTES) errors.add('notes', 'الملاحظات أطول من المسموح.');
    const journalDescription = form.string('journalDescription', { max: 1000 });
    const referenceNumber = form.string('referenceNumber', { max: 255 });
    const discountValue = form.number('discountAmount', { min: 0, max: MAX_MONEY }) ?? 0;
    const discountType = form.oneOf('discountType', ['amount', 'percentage'] as const, { message: 'نوع الخصم amount أو percentage.' }) ?? 'amount';
    if (discountType === 'percentage' && discountValue > 100) errors.add('discountAmount', 'نسبة الخصم لا تتجاوز 100.');
    const couponCode = form.string('couponCode', { max: 64 });
    const shippingCost = form.number('shippingCost', { min: 0, max: MAX_MONEY }) ?? 0;
    const shippingTaxSelector = form.has('shippingTaxId');
    const shippingTaxId = form.integer('shippingTaxId', { min: 1 });
    if (shippingTaxId !== null && !book.has(shippingTaxId)) errors.add('shippingTaxId', 'ضريبة الشحن غير موجودة في «إعدادات الضريبة».');

    const rawAdvance = form.raw('advancePayment');
    const advancePayment = rawAdvance === null ? 0 : Math.max(0, normalizeAmount(rawAdvance));
    if (advancePayment > MAX_MONEY) errors.add('advancePayment', 'الدفعة المقدَّمة أكبر من المسموح.');
    const isPaid = form.boolean('isPaid') ?? false;
    const paymentStatus = form.integer('paymentStatus', { in: [1, 2, 3], message: 'حالة الفاتورة 1 أو 2 أو 3.' });
    const paymentMethod = form.integer('paymentMethod', { min: 1 });
    const treasuryId = form.integer('treasuryId', { min: 1 });
    const latitude = form.number('currentLatitude', { min: -90, max: 90 });
    const longitude = form.number('currentLongitude', { min: -180, max: 180 });

    const list = form.array('items', { required: true, min: 1, max: MAX_ITEMS, message: 'أضف صنفاً واحداً على الأقل إلى الفاتورة.' }) ?? [];
    const items: ItemInput[] = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const productId = item.integer('productId', { required: true, min: 1, message: 'كلّ بندٍ يحتاج منتجاً مختاراً من القائمة.' });
      const quantity = item.number('quantity', { required: true, message: 'الكمية مطلوبة لكل بند.' });
      const unitPrice = item.number('unitPrice', { required: true, min: 0, max: MAX_MONEY, message: 'السعر مطلوب لكل بند.' });
      const discount = item.number('discount', { min: 0, max: MAX_MONEY }) ?? 0;
      const type = item.oneOf('discountType', ['amount', 'percentage'] as const, { message: 'نوع الخصم amount أو percentage.' }) ?? 'amount';
      const tax1Id = item.integer('tax1Id', { min: 1 });
      const tax2Id = item.integer('tax2Id', { min: 1 });
      const unitId = item.integer('unitId', { min: 1 });
      const categoryUnitId = item.integer('categoryUnitId', { min: 1 });
      const lineWarehouse = item.integer('warehouseId', { min: 1 });
      const description = item.string('description', { max: 1000 });

      if (quantity !== null && quantity <= 0) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      else if (quantity !== null && quantity > MAX_QUANTITY) errors.add(`items.${i}.quantity`, 'الكمية أكبر من المسموح.');
      if (type === 'percentage' && discount > 100) errors.add(`items.${i}.discount`, 'نسبة الخصم لا تتجاوز 100.');
      if (type === 'amount' && quantity !== null && unitPrice !== null && discount > quantity * unitPrice + 0.001) errors.add(`items.${i}.discount`, 'خصم البند أكبر من قيمته.');
      for (const [key, id] of [['tax1Id', tax1Id], ['tax2Id', tax2Id]] as const) {
        if (id !== null && !book.has(id)) errors.add(`items.${i}.${key}`, 'الضريبة غير موجودة في «إعدادات الضريبة».');
      }
      if (unitId !== null && categoryUnitId !== null) errors.add(`items.${i}.unitId`, 'اختر وحدة المنتج أو وحدة التصنيف — لا الاثنتين.');

      if (productId !== null && quantity !== null && unitPrice !== null) {
        items.push({ productId, unitId, categoryUnitId, quantity, unitPrice, discount, discountType: type, tax1Id, tax2Id, warehouseId: lineWarehouse, description });
      }
    });

    errors.throwIfAny();
    return {
      clientId: clientId as number,
      invoiceDate,
      issueDate,
      terms,
      employeeId,
      warehouseId,
      orderSourceId,
      notes,
      journalDescription,
      referenceNumber,
      discountValue,
      discountType,
      couponCode: couponCode?.trim() || null,
      shippingCost,
      shippingTaxSelector,
      shippingTaxId,
      advancePayment,
      isPaid,
      paymentStatus,
      paymentMethod,
      treasuryId,
      latitude,
      longitude,
      items,
    };
  }

  /** `lineDiscountValue()` — المُدخَل مبلغاً، أو نسبةً من قيمة البند */
  private manualDiscount(item: ItemInput): number {
    if (item.discount <= 0) return 0;
    const lineTotal = item.quantity * item.unitPrice;
    return item.discountType === 'percentage' ? (lineTotal * item.discount) / 100 : item.discount;
  }

  /** `ProductUnits::resolve()` — والوحدة من وحدات الصنف نفسه لا من غيره */
  private resolveUnit(item: ItemInput, i: number, units: SalesUnitOption[]): { productUnitId: number | null; factor: number; name: string } {
    if (item.unitId !== null) {
      const unit = units.find((u) => u.id === item.unitId);
      if (!unit) throw fail('الوحدة المختارة ليست من وحدات هذا الصنف.', `items.${i}.unitId`);
      return { productUnitId: unit.id, factor: unit.conversionFactor || 1, name: unit.name };
    }
    if (item.categoryUnitId !== null) {
      const unit = units.find((u) => u.categoryUnitId === item.categoryUnitId);
      if (!unit) throw fail('الوحدة المختارة ليست من وحدات تصنيف هذا الصنف.', `items.${i}.categoryUnitId`);
      return { productUnitId: unit.id, factor: unit.conversionFactor || 1, name: unit.name };
    }
    return { productUnitId: null, factor: 1, name: '' };
  }

  // ═══════════════════════ الإصدار ═══════════════════════

  /**
   * `inTransaction` — لمن يُصدر الفاتورة عن مستندٍ آخر (تحويل عرض السعر): يُنفَّذ
   * داخل معاملة الفاتورة نفسها، فإن رُفض رجعت الفاتورة كلُّها.
   */
  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>, opts: { inTransaction?: (tx: Tx, invoiceId: number, code: string) => Promise<void>; permission?: string } = {}) {
    const inTransaction = opts.inTransaction;
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.invoices], permissions: [opts.permission ?? SALES_PERMISSIONS.invoicesCreate] });
    const [rules, book] = await Promise.all([this.settings.rules(), this.settings.taxBook()]);
    const input = this.parse(body, book, ctx.today);

    const client = await this.sales.client(input.clientId);
    if (!client) throw fail('العميل المحدَّد غير موجود.', 'clientId');
    await ctx.assertClient(client.id);

    await this.assertProximity(ctx, input, client.id);

    const block = await this.periodGuard.block(input.invoiceDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);

    await this.planLimits.assert(SALES_LIMITS.invoices, ctx.now);

    const orderSource = await this.settings.resolveOrderSource(input.orderSourceId);
    if (input.orderSourceId && !orderSource) throw fail('مصدر الطلب المختار غير موجود أو موقوف.', 'orderSourceId');
    if (!orderSource && (await this.settings.orderSourceRequired())) throw fail('مصدر الطلب إلزاميّ — اختر مصدراً قبل حفظ الفاتورة. (يُضبط من «إعدادات المبيعات ← مصادر الطلب»)', 'orderSourceId');

    const employeeId = await ctx.clampEmployee(input.employeeId);

    // الأصناف ووحداتها
    const products = await this.sales.products(input.items.map((i) => i.productId));
    input.items.forEach((item) => {
      if (!products.has(item.productId)) throw fail(`المنتج رقم ${item.productId} لم يعد موجوداً — احذف بنده وأعد المحاولة.`, 'items');
    });
    const units = await this.sales.unitsFor([...products.values()]);

    // المستودعات — صلاحية «إنشاء فاتورة»، ومن مستودعات الموظف نفسها
    const options = await ctx.warehouseOptions(rules.warehouseSource);
    const assertWarehouse = async (id: number, field: string) => {
      const row = await this.stock.warehouse(id);
      if (!row) throw fail('المستودع المختار غير موجود.', field);
      if (!(await ctx.canCreateInvoicesFrom(id)) || (ctx.isEmployee && !options.includes(id))) {
        throw AppError.forbidden('WAREHOUSE_FORBIDDEN', `لا تملك صلاحية إنشاء فاتورة من مستودع «${row.name || 'المحدَّد'}».`);
      }
    };
    if (input.warehouseId) await assertWarehouse(input.warehouseId, 'warehouseId');
    for (const [i, item] of input.items.entries()) if (item.warehouseId) await assertWarehouse(item.warehouseId, `items.${i}.warehouseId`);
    const defaultWarehouse = await ctx.resolveWarehouse(rules.warehouseSource, input.warehouseId);

    await this.assertDiscountRules(ctx, rules, input, products, units);

    // خصم البند: ما كتبه المستخدم، وإلا عرضُ الحسم المطابق
    const offers = (await this.sales.discountOffers(ctx.today)).filter((o) => offerCoversClient(o, client.id));
    const appliedOffers: string[] = [];
    const drafts: LineDraft[] = input.items.map((item, i) => {
      const product = products.get(item.productId) as SalesProduct;
      const unit = this.resolveUnit(item, i, units.get(product.id) ?? []);
      const lineTotal = item.quantity * item.unitPrice;
      const manual = this.manualDiscount(item);
      let discount = manual;
      if (manual <= 0 && lineTotal > 0 && offers.length) {
        const match = bestOfferDiscount(offers, product.id, product.categoryId, item.quantity, lineTotal);
        if (match) {
          discount = match.amount;
          appliedOffers.push(match.name);
        }
      }
      const warehouseId = item.warehouseId ?? defaultWarehouse;
      if (!warehouseId && this.tracksStock(product)) throw fail('لا يوجد مستودع في النظام، ولا تُصرَف بضاعةٌ بلا مستودع. أضف مستودعاً من «المخزون ← المستودعات».', `items.${i}.warehouseId`);
      return {
        product,
        warehouseId,
        productUnitId: unit.productUnitId,
        conversionFactor: unit.factor,
        unitName: unit.name,
        quantity: item.quantity,
        baseQuantity: item.quantity * unit.factor,
        unitPrice: item.unitPrice,
        discount,
        discountType: item.discountType === 'percentage' ? 2 : 1,
        tax1: item.tax1Id ? book.get(item.tax1Id)?.rate ?? 0 : 0,
        tax1Id: item.tax1Id,
        tax2: item.tax2Id ? book.get(item.tax2Id)?.rate ?? 0 : 0,
        tax2Id: item.tax2Id,
        total: lineTotal - discount,
        item: product.name,
        description: item.description,
        gift: false,
      };
    });

    // الكوبون — على وعاء ما بعد الخصوم، ورمزٌ مرفوض لا يُسقط الفاتورة
    let coupon: Coupon | null = null;
    let couponNotice: string | null = null;
    const totals = await calculateInvoice(
      book,
      {
        lines: drafts.map((d) => ({ quantity: d.quantity, unitPrice: d.unitPrice, discount: d.discount, taxIds: [d.tax1Id, d.tax2Id] })),
        discountValue: input.discountValue,
        discountType: input.discountType,
        shippingCost: input.shippingCost,
        shippingTaxSelector: input.shippingTaxSelector,
        shippingTaxId: input.shippingTaxId,
      },
      async (base) => {
        if (!input.couponCode) return { discount: 0, freeShipping: false };
        if (!rules.flag('enable_coupons')) {
          couponNotice = couponMessage('disabled');
          return { discount: 0, freeShipping: false };
        }
        const found = await this.sales.coupon(input.couponCode);
        const result = await evaluateCoupon(found, input.couponCode, client.id, base, drafts.map((d) => d.product.id), input.shippingCost, {
          now: ctx.nowSql,
          usageCount: () => this.sales.couponUsageCount(found?.id ?? 0, null),
          clientUsageCount: () => this.sales.couponUsageCount(found?.id ?? 0, client.id),
          hasEarlierPurchase: () => this.sales.clientHasInvoices(client.id),
          productsInCategories: (categories) => this.sales.productsInCategories(drafts.map((d) => d.product.id), categories),
        });
        if (!result.ok) {
          couponNotice = result.error;
          return { discount: 0, freeShipping: false };
        }
        coupon = result.coupon;
        couponNotice = result.freeShipping ? `طُبِّق الكوبون ${result.coupon.code} — شحنٌ مجانيّ` : `طُبِّق الكوبون ${result.coupon.code} — خصمٌ ${fmtMoney(result.discount)}`;
        return { discount: result.discount, freeShipping: result.freeShipping };
      },
    );

    // الهدايا — بنودٌ بسعر صفر من مستودع البند الذي استحقّها
    drafts.push(...(await this.giftLines(ctx, client.id, drafts)));

    // الدفع والحالة
    const payment = await this.resolvePayment(rules, input, totals, client.id);
    await this.assertCredit(ctx, client, payment, totals.grandTotal);

    const result = await this.persist(ctx, rules, book, input, client, employeeId, orderSource, drafts, totals, payment, coupon, inTransaction);

    const offerNotice = appliedOffers.length ? `وطُبِّقت عروض الحسم على ${appliedOffers.length} بنداً (${[...new Set(appliedOffers)].join('، ')}).` : null;
    const message =
      `تم إنشاء فاتورة المبيعات بنجاح. رقم الفاتورة: ${result.code}` +
      result.creditNote +
      (offerNotice ? ` — ${offerNotice}` : '') +
      (couponNotice ? ` — ${couponNotice}` : '');

    return { message, data: await this.queries.detail(ctx, result.id) };
  }

  /**
   * إشعارٌ لا يُسقط البيع: بلوغ حدّ «الإشعارات الداخلية» يمنع الإشعار وحده —
   * الويب يُنشئه داخل معاملة الفاتورة فيردّ الفاتورة كلّها بسببه.
   */
  private async notify(input: Parameters<NotificationGate['send']>[0], now: Date, tx?: Tx) {
    try {
      await this.notifications.send(input, now, tx);
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'PLAN_LIMIT_REACHED')) throw e;
    }
  }

  private tracksStock(product: SalesProduct) {
    return product.type === 'products' || product.type === 'compiled';
  }

  private assertProximity(ctx: SalesContext, input: InvoiceInput, clientId: number) {
    return this.proximity.assert(ctx, SALES_PERMISSIONS.invoicesBypassLocation, clientId, input.latitude, input.longitude);
  }

  /** «إعدادات الفواتير»: الحدّ الأقصى للخصم ومنع البيع تحت التكلفة — قبل أيّ كتابة */
  private async assertDiscountRules(ctx: SalesContext, rules: InvoiceRules, input: InvoiceInput, products: Map<number, SalesProduct>, units: Map<number, SalesUnitOption[]>) {
    if (!rules.flag('no_sell_below_cost') && !rules.flag('enable_max_discount')) return;
    const maxPercent = rules.flag('enable_max_discount') ? await this.settings.maxDiscountPercent(rules, ctx.user.branchId) : null;
    const maxAmount = rules.flag('enable_max_discount') ? rules.maxDiscountAmount() : null;
    const book = await this.settings.taxBook();

    let subtotal = 0;
    let lineDiscounts = 0;
    const costs = rules.flag('no_sell_below_cost') ? await this.stock.averageCosts([...products.keys()], null) : new Map<number, number>();

    for (const [i, item] of input.items.entries()) {
      const product = products.get(item.productId) as SalesProduct;
      const itemTotal = item.quantity * item.unitPrice;
      const discount = this.manualDiscount(item);
      const percent = itemTotal > 0 ? (discount / itemTotal) * 100 : discount > 0 ? 100 : 0;
      subtotal += itemTotal;
      lineDiscounts += discount;

      if (maxPercent !== null && percent > maxPercent + 0.001) {
        throw fail(`الخصم على «${product.name}» (${fmtMoney(percent)}٪) يتجاوز الحدّ الأقصى المسموح (${maxPercent}٪).`, `items.${i}.discount`);
      }

      if (rules.flag('no_sell_below_cost')) {
        const line = taxLine(book, item.quantity, item.unitPrice, discount, [item.tax1Id, item.tax2Id]);
        const avg = costs.get(product.id) ?? (product.purchasePrice > 0 ? round2(product.purchasePrice) : 0);
        if (avg > 0) {
          const factor = this.resolveUnit(item, i, units.get(product.id) ?? []).factor;
          const lineCost = avg * item.quantity * factor;
          if (line.net < lineCost - 0.001) throw fail(`صافي «${product.name}» (${fmtMoney(line.net)}) أقلّ من تكلفته (${fmtMoney(lineCost)}).`, `items.${i}.unitPrice`);
        }
      }
    }

    if (maxPercent === null && maxAmount === null) return;
    const general = input.discountValue > 0 ? (input.discountType === 'percentage' ? (subtotal * input.discountValue) / 100 : input.discountValue) : 0;
    const generalPercent = subtotal > 0 ? (general / subtotal) * 100 : general > 0 ? 100 : 0;
    if (maxPercent !== null && generalPercent > maxPercent + 0.001) throw fail(`الخصم العامّ على الفاتورة (${fmtMoney(generalPercent)}٪) يتجاوز الحدّ الأقصى المسموح (${maxPercent}٪).`, 'discountAmount');
    const totalPercent = subtotal > 0 ? ((lineDiscounts + general) / subtotal) * 100 : generalPercent;
    if (maxPercent !== null && totalPercent > maxPercent + 0.001) throw fail(`مجموع الخصم — خصم البنود مع الخصم العامّ (${fmtMoney(totalPercent)}٪) — يتجاوز الحدّ الأقصى المسموح (${maxPercent}٪).`, 'discountAmount');
    if (maxAmount !== null && lineDiscounts + general > maxAmount + 0.001) throw fail(`مجموع الخصم على الفاتورة (${fmtMoney(lineDiscounts + general)}) يتجاوز أقصى مبلغ خصم مسموح (${fmtMoney(maxAmount)}).`, 'discountAmount');
  }

  /** عروض الهدايا — أعلى هديةٍ لكل بند بحسب كميته الأساسية */
  private async giftLines(ctx: SalesContext, clientId: number, drafts: LineDraft[]): Promise<LineDraft[]> {
    const offers = await this.sales.giftOffers(clientId, ctx.user.id, ctx.today);
    if (!offers.length) return [];
    const gifts: LineDraft[] = [];
    for (const d of drafts) {
      const match = bestGift(offers, d.product.id, d.baseQuantity);
      if (!match || !match.offer.giftProductId) continue;
      const giftProduct = (await this.sales.products([match.offer.giftProductId])).get(match.offer.giftProductId);
      if (!giftProduct) continue;
      gifts.push({
        product: giftProduct,
        warehouseId: d.warehouseId,
        productUnitId: null,
        conversionFactor: 1,
        unitName: '',
        quantity: match.quantity,
        baseQuantity: match.quantity,
        unitPrice: 0,
        discount: 0,
        discountType: 1,
        tax1: 0,
        tax1Id: null,
        tax2: 0,
        tax2Id: null,
        total: 0,
        item: `${giftProduct.name} (هدية)`,
        description: `هدية عرض عند شراء ${Math.trunc(d.baseQuantity)} حبة من المنتج`,
        gift: true,
      });
    }
    return gifts;
  }

  /** الدفعة المقدّمة والرصيد الدائن والمحفظة ← حالة الفاتورة ومستحقّها */
  private async resolvePayment(rules: InvoiceRules, input: InvoiceInput, totals: CalcTotals, clientId: number) {
    const total = totals.grandTotal;
    let advance = input.advancePayment;
    if (!input.isPaid && advance > round2(total) + 0.01) {
      throw fail(`الدفعة المقدَّمة (${fmtMoney(advance)}) أكبر من قيمة الفاتورة (${fmtMoney(total)}). اكتب مبلغاً لا يتجاوزها، أو سجّل الفائض بسند قبضٍ مستقل.`, 'advancePayment');
    }

    let due = total - advance;
    let creditApplied = 0;
    if (rules.flag('auto_pay_if_balance')) {
      const account = await this.sales.clientLedgerAccount(clientId);
      const available = Math.max(0, -(account?.balance ?? 0));
      creditApplied = round2(Math.min(available, Math.max(0, total - advance)));
      if (creditApplied > 0) due = Math.max(0, due - creditApplied);
    }

    let walletApplied = 0;
    if (rules.flag('auto_pay_from_wallet')) {
      walletApplied = round2(Math.min(await this.sales.clientWalletBalance(clientId), Math.max(0, total - advance - creditApplied)));
      if (walletApplied < 0) walletApplied = 0;
    }

    let status: number = PAYMENT_STATUS.unpaid;
    let isPaid = false;
    if (advance > 0 || creditApplied > 0 || walletApplied > 0 || input.isPaid) {
      const paid = advance + creditApplied + walletApplied;
      if (input.isPaid) {
        advance = round2(Math.max(0, total - creditApplied - walletApplied));
        due = round2(walletApplied);
        status = PAYMENT_STATUS.paid;
        isPaid = true;
      } else if (paid >= total - 0.001) {
        due = round2(walletApplied);
        status = PAYMENT_STATUS.paid;
        isPaid = true;
      } else {
        status = PAYMENT_STATUS.partial;
      }
    }

    // «إعطاء الفواتير حالات يدوية» — و«مكتملة» لا تُكتب فوق مستحقٍّ قائم
    if (rules.flag('manual_invoice_status') && input.paymentStatus !== null) {
      if (input.paymentStatus === PAYMENT_STATUS.paid && status !== PAYMENT_STATUS.paid) {
        throw fail('لا تُعلَّم الفاتورة «مكتملة» ما لم يغطِّها السداد. أشِّر «مدفوعة بالكامل» أو أدخل الدفعة المقدَّمة كاملةً.', 'paymentStatus');
      }
      status = input.paymentStatus;
      isPaid = status === PAYMENT_STATUS.paid;
    }

    return { advance: round2(advance), due, status, isPaid, creditApplied, walletApplied };
  }

  /** الحدّ الائتماني — الفرع ومجموعة المنطقة والموظف المسؤول والعميل */
  private async assertCredit(ctx: SalesContext, client: { id: number; tradeName: string | null; branchId: number | null; employeeId: number | null; regionGroupId: number | null }, payment: { advance: number; status: number }, total: number) {
    if (payment.status !== PAYMENT_STATUS.partial && payment.status !== PAYMENT_STATUS.unpaid) return;
    const newDebt = total - payment.advance;
    const f = fmtMoney;

    const check = async (credit: { limit: number; debt: number }, label: string) => {
      if (credit.limit <= 0) return;
      const after = credit.debt + newDebt;
      if (after > credit.limit) {
        throw new AppError(
          'CREDIT_LIMIT_EXCEEDED',
          `⚠️ عفوا، لقد تجاوز ${label} الحد الائتماني المسموح به!\nالحد الائتماني: ${f(credit.limit)}\nالمديونية الحالية: ${f(credit.debt)}\nقيمة الفاتورة (الآجل): ${f(newDebt)}\nالإجمالي بعد الفاتورة: ${f(after)}\nالتجاوز: ${f(after - credit.limit)}\nالرجاء سداد المديونيات أولًا أو زيادة الحد الائتماني.`,
          422,
        );
      }
    };
    if (client.branchId) await check(await this.sales.branchCredit(client.branchId), 'الفرع');
    if (client.regionGroupId) await check(await this.sales.regionGroupCredit(client.regionGroupId), 'مجموعة المنطقة');
    if (client.employeeId) await check(await this.sales.employeeCredit(client.employeeId), 'عملاء الموظف');

    const account = await this.sales.clientLedgerAccount(client.id);
    const current = account?.balance ?? 0;
    const afterPayment = current + total - payment.advance;
    const limit = await this.sales.clientCreditLimit(client.id);
    if (limit > 0) {
      if (afterPayment > limit) {
        throw new AppError(
          'CREDIT_LIMIT_EXCEEDED',
          `⚠️ عفوا، لقد تجاوز العميل الحد الائتماني المسموح به!\nالحد الائتماني: ${f(limit)}\nالمديونية الحالية: ${f(current)}\nقيمة الفاتورة: ${f(total)}\nالإجمالي بعد الفاتورة: ${f(current + total)}\nالإيداع/الدفعة المقدمة: ${f(payment.advance)}\nالإجمالي بعد الإيداع: ${f(afterPayment)}\nالتجاوز: ${f(afterPayment - limit)}\nالرجاء سداد المديونية أولًا أو زيادة الحد الائتماني للعميل.`,
          422,
        );
      }
      const percent = (afterPayment / limit) * 100;
      if (percent >= 80 && percent <= 100) {
        await this.notify(
          {
            userId: ctx.user.id,
            receiverId: ctx.user.id,
            type: 'warning',
            title: 'تحذير: عميل قريب من الحد الائتماني',
            description: `العميل ${client.tradeName ?? ''} استخدم ${phpRound(percent, 1)}% من الحد الائتماني (${f(afterPayment)} / ${f(limit)}) بعد الإيداع`,
            isSent: true,
          },
          ctx.now,
        );
      }
    } else if (!ctx.can(SALES_PERMISSIONS.debtClient) && current > 0) {
      throw new AppError('CLIENT_HAS_DEBT', `⚠️ عفوا، لا يمكن إصدار فاتورة للعميل! السبب: لديه مديونية حالية: ${f(current)}. الحل: الرجاء سداد المديونية أولًا أو تعيين حد ائتماني للعميل.`, 422);
    }
  }

  /** رمز QR لهيئة الزكاة — TLV: البائع، رقمه الضريبي، الوقت، الإجمالي، الضريبة */
  private async qrcode(createdAt: string, total: number, tax: number) {
    const business = await this.sales.businessInfo();
    const tlv = (tag: number, value: string) => {
      const bytes = Buffer.from(value, 'utf8');
      return Buffer.concat([Buffer.from([tag, bytes.length & 0xff]), bytes]);
    };
    return Buffer.concat([tlv(1, business.name), tlv(2, business.taxNumber), tlv(3, createdAt), tlv(4, round2(total).toFixed(2)), tlv(5, round2(tax).toFixed(2))]).toString('base64');
  }

  // ═══════════════════════ الكتابة ═══════════════════════

  private async persist(
    ctx: SalesContext,
    rules: InvoiceRules,
    book: TaxBook,
    input: InvoiceInput,
    client: { id: number; tradeName: string | null; branchId: number | null },
    employeeId: number | null,
    orderSource: { id: number } | null,
    drafts: LineDraft[],
    totals: CalcTotals,
    payment: { advance: number; due: number; status: number; isPaid: boolean; creditApplied: number; walletApplied: number },
    coupon: Coupon | null,
    inTransaction?: (tx: Tx, invoiceId: number, code: string) => Promise<void>,
  ) {
    const now = ctx.nowSql;
    const defaultCurrency = await this.reference.defaultCurrency();
    const currency = defaultCurrency?.code ?? 'SAR';
    const currencySymbol = defaultCurrency?.symbol ?? currency;
    const ownerBranch = (ctx.user.employeeId ? await this.stock.employeeBranchId(ctx.user.employeeId) : null) || ctx.user.branchId || null;
    const periodId = (await this.stock.accountingPeriodFor(input.invoiceDate))?.id ?? null;
    const paymentMethod = input.paymentMethod ?? (await this.sales.defaultInvoicePaymentMethod());
    const permitCount = drafts.reduce((n, d) => n + this.permitsFor(d), 0);
    const compiled = await this.sales.compiledComponents(drafts.filter((d) => d.product.type === 'compiled' && d.product.compileType === 'Instant').map((d) => d.product.id));
    const instantCount = drafts.filter((d) => d.product.type === 'compiled' && d.product.compileType === 'Instant').reduce((n, d) => n + (compiled.get(d.product.id)?.length ?? 0), 0);

    const outcome = await this.uow.run(async (tx) => {
      // حرّاس `PlanLimitObserver` داخل المعاملة — طلبان متزامنان لا يتجاوزان الحدّ
      await this.planLimits.assert(SALES_LIMITS.invoices, ctx.now);
      if (permitCount + instantCount > 0) await this.planLimits.assert('warehouse_permits', ctx.now, permitCount + instantCount);
      if (payment.advance > 0) await this.planLimits.assert(SALES_LIMITS.payments, ctx.now);

      const code = await this.numbers.next(SALES_SECTIONS.invoice, ctx.now, tx);
      const creditNoteText = payment.creditApplied > 0 ? `\nسُوِّيت من رصيد العميل الدائن بمبلغ ${fmtMoney(payment.creditApplied)} — بلا قبضٍ في الخزينة` : '';

      const invoiceId = await this.writes.insertInvoice(
        {
          client_id: client.id,
          branch_id: ctx.user.branchId ?? null,
          pos_branch_id: ownerBranch,
          employee_id: employeeId ?? ctx.user.employeeId ?? null,
          due_value: round2(payment.due),
          code,
          type: 'normal',
          invoice_date: input.invoiceDate,
          issue_date: input.issueDate,
          payment_terms: input.terms > 0 ? String(input.terms) : null,
          notes: (input.notes ?? '') + creditNoteText || null,
          payment_status: payment.status,
          is_paid: payment.isPaid ? 1 : 0,
          created_by: ctx.user.id,
          discount_amount: round2(totals.totalDiscount),
          discount_type: input.discountType === 'percentage' ? 2 : 1,
          coupon_id: coupon ? (coupon as Coupon).id : null,
          coupon_code: coupon ? (coupon as Coupon).code : null,
          coupon_discount: round2(totals.couponDiscount),
          advance_payment: payment.advance,
          shipping_cost: totals.shippingCost,
          shipping_tax: totals.shippingTax,
          tax_type: 1,
          payment_method: String(paymentMethod),
          reference_number: input.referenceNumber,
          subtotal: totals.subtotal,
          tax_total: totals.taxTotal,
          grand_total: round2(totals.grandTotal),
          currency,
          accounting_period_id: periodId,
          order_source_id: orderSource?.id ?? null,
          qrcode: await this.qrcode(now, totals.grandTotal, totals.taxTotal),
        },
        now,
        tx,
      );

      // ضرائب البنود بعد الخصم — كما دخلت الإجمالي
      await this.writeTaxRows(book, invoiceId, input, drafts, totals, now, tx);

      if (!(await this.writes.permissionSourceExists(SALES_PERMIT_SOURCE, tx))) {
        throw fail('مصدر إذن «فاتورة مبيعات» غير موجود في قاعدة البيانات — شغّل «تحديث النظام ← مصادر الأذون».', 'invoice', 'PERMISSION_SOURCE_MISSING');
      }

      const itemIds = await this.writeLines(ctx, invoiceId, code, client, drafts, compiled, totals, now, tx);

      // إشعار «أضاف فاتورة لعميل» — كالويب
      await this.notify(
        {
          userId: ctx.user.id,
          receiverId: null,
          type: 'invoice',
          title: `${ctx.user.name} أضاف فاتورة لعميل`,
          description: `فاتورة للعميل ${client.tradeName ?? '—'} بقيمة ${fmtMoney(totals.grandTotal)} ${currencySymbol}`,
          isSent: true,
        },
        ctx.now,
        tx,
      );

      const clientAccount = await this.sales.clientLedgerAccount(client.id, tx);
      if (!clientAccount) throw new AppError('CLIENT_ACCOUNT_MISSING', `لا حساب محاسبيّ للعميل «${client.tradeName ?? '—'}» — يُنشأ من شاشة العميل قبل إصدار فاتورةٍ له.`, 422);

      const owner = { branchId: ownerBranch, employeeId: ctx.user.employeeId ?? null };
      await this.salesEntry(ctx, rules, input, invoiceId, code, clientAccount, totals, currency, owner, payment.creditApplied, now, tx);
      await this.costEntry(ctx, invoiceId, code, client.id, drafts, itemIds, currency, owner, input.invoiceDate, now, tx);
      if (payment.advance > 0) await this.receipt(ctx, input, invoiceId, code, client.id, clientAccount.id, payment, currency, owner, now, tx);

      await this.depositNote(ctx, invoiceId, code, client.id, input, totals.grandTotal, currency, now, tx);
      if (payment.walletApplied > 0) await this.payFromWallet(ctx, invoiceId, code, client, payment.walletApplied, owner, now, tx);
      if (coupon) await this.writes.recordCouponUsage((coupon as Coupon).id, client.id, invoiceId, totals.couponDiscount, now, tx);

      await this.logs.record(
        {
          action: 'created',
          module: SALES_LOG_MODULE,
          subjectId: invoiceId,
          description: `إنشاء فاتورة مبيعات رقم ${code} — العميل: ${client.tradeName ?? '—'} — الإجمالي: ${fmtMoney(totals.grandTotal)} ${currency}` + (payment.creditApplied > 0 ? ` — سُوِّي من رصيد العميل الدائن: ${fmtMoney(payment.creditApplied)} ${currency}` : '') + (payment.walletApplied > 0 ? ` — سُدِّد من محفظة العميل: ${fmtMoney(payment.walletApplied)} ${currency}` : ''),
          userId: ctx.user.id,
          ip: ctx.meta.ip,
          userAgent: ctx.meta.userAgent,
          route: ctx.meta.route,
        },
        tx,
      );

      if (inTransaction) await inTransaction(tx, invoiceId, code);
      return { id: invoiceId, code };
    });

    // زيارة اليوم تُكمَل بعد أن صارت الفاتورة أمراً واقعاً (لا شيء إن كانت زيارة مساحة عملٍ مفتوحة)
    await this.visits.markCompletedFor(ctx.user.id, client.id, ctx.today, now, null).catch(() => undefined);

    const creditNote = [payment.creditApplied > 0 ? ` — سُوِّي من رصيد العميل الدائن: ${fmtMoney(payment.creditApplied)}` : '', payment.walletApplied > 0 ? ` — سُدِّد من محفظة العميل: ${fmtMoney(payment.walletApplied)}` : ''].join('');
    return { ...outcome, creditNote };
  }

  /** عدد أذون الصرف للبند: السلعة والمجمَّع المُسبق إذنٌ واحد، والفوري إذنان (والمكوّنات تُعدّ وحدها) */
  private permitsFor(d: LineDraft) {
    if (d.product.type === 'products' || (d.product.type === 'compiled' && d.product.compileType !== 'Instant')) return 1;
    if (d.product.type === 'compiled' && d.product.compileType === 'Instant') return 2;
    return 0;
  }

  private async writeTaxRows(book: TaxBook, invoiceId: number, input: InvoiceInput, drafts: LineDraft[], totals: CalcTotals, now: string, tx: Tx) {
    // الوعاء بعد حصّة الخصم العامّ — الحساب نفسه الذي أنتج `tax_total`
    const own = drafts.filter((d) => !d.gift);
    const nets = own.map((d) => Math.max(0, d.quantity * d.unitPrice - d.discount));
    const general = Math.min(totals.invoiceDiscount + totals.couponDiscount, Math.max(0, round2(nets.reduce((s, n) => s + n, 0))));
    const shares = allocateDocumentDiscount(nets, general);
    const rows: Array<Record<string, unknown>> = [];
    own.forEach((d, k) => {
      const line = taxLine(book, 1, Math.max(0, nets[k] - shares[k]), 0, [d.tax1Id, d.tax2Id]);
      for (const t of line.taxes) {
        const setting = t.id ? book.get(t.id) : null;
        if (!setting) continue;
        rows.push({ name: setting.name, invoice_id: invoiceId, type: setting.type, rate: setting.rate, value: t.amount, type_invoice: 'invoice', product_id: d.product.id });
      }
    });
    void input;
    await this.writes.insertTaxRows(rows, now, tx);
  }

  /** البنود وأذون الصرف وحركة الرصيد — بقفل صفوف الرصيد حتى نهاية المعاملة */
  private async writeLines(
    ctx: SalesContext,
    invoiceId: number,
    code: string,
    client: { id: number; tradeName: string | null },
    drafts: LineDraft[],
    compiled: Map<number, Array<{ productId: number; quantity: number }>>,
    totals: CalcTotals,
    now: string,
    tx: Tx,
  ): Promise<number[]> {
    const pairs: Array<[number, number]> = [];
    for (const d of drafts) {
      if (!this.tracksStock(d.product) || !d.warehouseId) continue;
      pairs.push([d.product.id, d.warehouseId]);
      for (const c of compiled.get(d.product.id) ?? []) pairs.push([c.productId, d.warehouseId]);
    }
    const stock = await this.writes.lockStock(pairs, tx);
    const warehouseNames = await this.stock.warehouseNames(drafts.map((d) => d.warehouseId).filter((v): v is number => v !== null));
    const rowFor = async (productId: number, warehouseId: number): Promise<StockRow> => {
      const key = `${productId}_${warehouseId}`;
      let row = stock.get(key);
      if (!row) {
        row = await this.writes.createStockRow(productId, warehouseId, now, tx);
        stock.set(key, row);
      }
      return row;
    };
    const permit = async (source: number, warehouseId: number, grandTotal: number, lines: Array<Record<string, unknown>>) => {
      const id = await this.writes.insertPermit(
        {
          permission_source_id: source,
          permission_date: now,
          number: String(invoiceId),
          grand_total: grandTotal,
          store_houses_id: warehouseId,
          client_id: source === SALES_PERMIT_SOURCE ? client.id : null,
          reference_type: source === SALES_PERMIT_SOURCE ? 'Invoice' : null,
          reference_id: source === SALES_PERMIT_SOURCE ? invoiceId : null,
          created_by: ctx.user.id,
          status: 'apporod',
          permission_type: source === SALES_PERMIT_SOURCE ? 2 : 1,
          currency: (await this.reference.defaultCurrency())?.code ?? 'SAR',
          accounting_period_id: (await this.stock.accountingPeriodFor(now.slice(0, 10)))?.id ?? null,
        },
        now,
        tx,
      );
      for (const line of lines) await this.writes.insertPermitLine({ ...line, warehouse_permits_id: id }, now, tx);
    };

    const itemIds: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const alerts: Array<Record<string, unknown>> = [];

    for (const [index, d] of drafts.entries()) {
      const itemId = await this.writes.insertItem(
        {
          invoice_id: invoiceId,
          product_id: d.product.id,
          product_unit_id: d.productUnitId,
          store_house_id: d.warehouseId,
          item: d.item,
          description: d.description,
          quantity: d.quantity,
          quantity_in_base_unit: d.baseQuantity,
          conversion_factor: d.conversionFactor,
          unit_name: d.unitName || null,
          unit_price: d.unitPrice,
          discount: d.discount,
          discount_type: d.discountType,
          tax_1: d.tax1,
          tax_2: d.tax2,
          tax_1_id: d.tax1Id,
          tax_2_id: d.tax2Id,
          total: d.gift ? 0 : totals.lineTotals[index] ?? d.total,
        },
        now,
        tx,
      );
      itemIds.push(itemId);

      const unitInfo = d.unitName && d.conversionFactor !== 1 ? ` (الوحدة: ${d.unitName}، معامل التحويل: ${fmtQty(d.conversionFactor)}، الكمية الأساسية: ${fmtQty(d.baseQuantity)})` : '';
      logs.push({
        type: 'sales',
        type_id: invoiceId,
        type_log: 'log',
        icon: 'create',
        description: `تم انشاء فاتورة مبيعات رقم **${code}** للمنتج **${d.product.name}** كمية **${fmtQty(d.quantity)}**${unitInfo} بسعر **${fmtQty(d.unitPrice)}** للعميل **${client.tradeName ?? ''}**`,
        created_by: ctx.user.id,
      });

      if (!this.tracksStock(d.product) || !d.warehouseId) continue;
      const store = warehouseNames.get(d.warehouseId) ?? '—';
      const row = await rowFor(d.product.id, d.warehouseId);
      const isInstant = d.product.type === 'compiled' && d.product.compileType === 'Instant';

      if (!isInstant) {
        if (d.baseQuantity > row.quantity + 1e-9) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            d.unitName && d.conversionFactor !== 1
              ? `الكمية المطلوبة من «${d.product.name}» غير متاحة في مستودع «${store}»: ${fmtQty(d.quantity)} ${d.unitName} تساوي ${fmtQty(d.baseQuantity)} بالوحدة الأساسية، والمتاح ${fmtQty(row.quantity)} فقط.`
              : `الكمية المطلوبة من «${d.product.name}» غير متاحة في مستودع «${store}»: المطلوب ${fmtQty(d.baseQuantity)} والمتاح ${fmtQty(row.quantity)}.`,
            422,
          );
        }
        const before = row.quantity;
        const lineTotal = d.gift ? 0 : totals.lineTotals[index] ?? d.total;
        const unitPrice = d.baseQuantity > 0 && lineTotal > 0 ? phpRound(lineTotal / d.baseQuantity, 4) : d.conversionFactor > 1 ? phpRound(d.unitPrice / d.conversionFactor, 4) : phpRound(d.unitPrice, 4);
        await this.writes.addStock(row.id, -d.baseQuantity, now, tx);
        row.quantity = before - d.baseQuantity;
        await permit(SALES_PERMIT_SOURCE, d.warehouseId, round2(lineTotal), [
          { product_id: d.product.id, quantity: d.baseQuantity, unit_price: unitPrice, total: lineTotal > 0 ? round2(lineTotal) : round2(d.baseQuantity * unitPrice), stock_before: before, stock_after: row.quantity },
        ]);

        if (d.product.lowStockAlert !== null && row.quantity < d.product.lowStockAlert) {
          alerts.push({ type: 'Products', title: 'تنبيه الكمية', description: `كمية المنتج ${d.product.name} قاربت على الانتهاء.` });
        }
        if (d.product.trackInventory === 2 && d.product.expiryDate && d.product.notifyBeforeDays) {
          const expiry = new Date(`${d.product.expiryDate.slice(0, 10)}T00:00:00Z`).getTime();
          const nowMs = new Date(`${now.replace(' ', 'T')}Z`).getTime();
          if (expiry > nowMs) {
            const remaining = Math.floor((expiry - nowMs) / 86_400_000);
            if (remaining <= d.product.notifyBeforeDays) alerts.push({ type: 'Products', title: 'تاريخ الانتهاء', description: `المنتج ${d.product.name} قارب على الانتهاء في خلال ${remaining} يوم.` });
          }
        }
        continue;
      }

      // المجمَّع الفوري: يُضاف ثم يُخصم (أثره صفر)، وتخرج مكوّناته فعلاً
      const before = row.quantity;
      const lineTotal = totals.lineTotals[index] ?? d.total;
      await permit(WAREHOUSE_ADD_SOURCE, d.warehouseId, round2(lineTotal), [{ product_id: d.product.id, quantity: d.baseQuantity, unit_price: d.unitPrice, total: lineTotal, stock_before: before, stock_after: before + d.baseQuantity }]);
      await permit(SALES_PERMIT_SOURCE, d.warehouseId, round2(lineTotal), [{ product_id: d.product.id, quantity: d.baseQuantity, unit_price: d.unitPrice, total: lineTotal, stock_before: before + d.baseQuantity, stock_after: before }]);

      const components = compiled.get(d.product.id) ?? [];
      const componentNames = await this.sales.products(components.map((c) => c.productId));
      for (const c of components) {
        const crow = await rowFor(c.productId, d.warehouseId);
        const needed = c.quantity * d.baseQuantity;
        if (needed > crow.quantity + 1e-9) {
          throw new AppError('INSUFFICIENT_STOCK', `الكمية المطلوبة من «${componentNames.get(c.productId)?.name ?? `#${c.productId}`}» غير متاحة في مستودع «${store}»: المطلوب ${fmtQty(needed)} والمتاح ${fmtQty(crow.quantity)}.`, 422);
        }
        const cBefore = crow.quantity;
        await permit(SALES_PERMIT_SOURCE, d.warehouseId, round2(lineTotal), [{ product_id: c.productId, quantity: needed, unit_price: d.unitPrice, total: lineTotal, stock_before: cBefore, stock_after: cBefore - needed }]);
        await this.writes.addStock(crow.id, -needed, now, tx);
        crow.quantity = cBefore - needed;
      }
    }

    await this.writes.insertLogs(logs, now, tx);
    await this.writes.insertRawNotifications(alerts, now, tx);
    return itemIds;
  }

  private entry(ctx: SalesContext, header: JournalHeader, lines: JournalLine[], owner: JournalOwner, now: string, tx: Tx) {
    return this.journal.post(ctx, header, lines, owner, now, tx);
  }

  /** قيد المبيعات — مدين العميل بالإجمالي، دائن المبيعات والضريبة والشحن، مدين الخصم */
  private async salesEntry(
    ctx: SalesContext,
    rules: InvoiceRules,
    input: InvoiceInput,
    invoiceId: number,
    code: string,
    clientAccount: { id: number; name: string },
    totals: CalcTotals,
    currency: string,
    owner: { branchId: number | null; employeeId: number | null },
    creditApplied: number,
    now: string,
    tx: Tx,
  ) {
    const vat = await this.accounts.require('vat_payable', null, tx);
    const sales = await this.accounts.require('sales', null, tx);
    let description = `فاتورة مبيعات ${code} - ${clientAccount.name || 'العميل'}`;
    if (rules.flag('custom_journal_description') && input.journalDescription) description = input.journalDescription;

    const lines: Array<{ accountId: number; description: string; debit: number; credit: number }> = [
      { accountId: clientAccount.id, description: `مديونية العميل - فاتورة ${code}` + (creditApplied > 0 ? ` (سُدِّد من رصيده الدائن ${fmtMoney(creditApplied)})` : ''), debit: totals.grandTotal, credit: 0 },
      { accountId: sales.id, description: `إيرادات مبيعات - فاتورة ${code}`, debit: 0, credit: totals.subtotal },
    ];
    if (totals.totalDiscount > 0) lines.push({ accountId: (await this.accounts.require('allowed_discount', null, tx)).id, description: `خصم مسموح به - فاتورة ${code}`, debit: totals.totalDiscount, credit: 0 });
    const itemsTax = round2(totals.taxTotal - totals.shippingTax);
    if (itemsTax > 0) lines.push({ accountId: vat.id, description: `ضريبة القيمة المضافة على البنود - فاتورة ${code}`, debit: 0, credit: itemsTax });
    if (totals.shippingTax > 0) {
      const shippingVat = (await this.accounts.find('shipping_vat_payable', null, tx)) ?? vat;
      lines.push({ accountId: shippingVat.id, description: `ضريبة شحن مبيعات - فاتورة ${code}`, debit: 0, credit: totals.shippingTax });
    }
    if (totals.shippingCost > 0) lines.push({ accountId: (await this.accounts.require('shipping_revenue', null, tx)).id, description: `إيراد شحن - فاتورة ${code}`, debit: 0, credit: totals.shippingCost });

    await this.entry(ctx, { reference: code, referenceType: SALES_REFERENCE.invoice, description, clientId: input.clientId, invoiceId, currency, date: input.invoiceDate }, lines, owner, now, tx);
  }

  /**
   * قيد تكلفة المبيعات — المتوسّط المرجَّح مجمَّداً على البند، ودائنُ حساب مخزون
   * **مستودع كل بند** (يُنشأ تحت أبيه إن غاب). وفشلُه يُسقط الفاتورة لا يُبتلع.
   */
  private async costEntry(
    ctx: SalesContext,
    invoiceId: number,
    code: string,
    clientId: number,
    drafts: LineDraft[],
    itemIds: number[],
    currency: string,
    owner: { branchId: number | null; employeeId: number | null },
    date: string,
    now: string,
    tx: Tx,
  ) {
    const averages = await this.stock.averageCosts(drafts.map((d) => d.product.id), null);
    const byWarehouse = new Map<number, number>();
    let total = 0;
    for (const [i, d] of drafts.entries()) {
      if (!this.tracksStock(d.product) || !d.warehouseId) continue;
      const avg = averages.get(d.product.id) ?? (d.product.purchasePrice > 0 ? round2(d.product.purchasePrice) : 0);
      if (avg <= 0) continue;
      await this.writes.freezeItemCost(itemIds[i], avg, tx);
      const cost = d.baseQuantity * avg;
      byWarehouse.set(d.warehouseId, (byWarehouse.get(d.warehouseId) ?? 0) + cost);
      total += cost;
    }
    if (total <= 0) return;

    const costAccount = await this.accounts.require('cost_of_sales', null, tx);
    const names = await this.stock.warehouseNames([...byWarehouse.keys()]);
    const credits: Array<{ accountId: number; description: string; debit: number; credit: number }> = [];
    for (const [warehouseId, cost] of byWarehouse) {
      const account = await this.accounts.warehouse(warehouseId, names.get(warehouseId) ?? null, now, tx);
      credits.push({ accountId: account.id, description: `تخفيض المخزون - فاتورة ${code}`, debit: 0, credit: round2(cost) });
    }
    const debit = round2(credits.reduce((s, c) => s + c.credit, 0));
    await this.entry(
      ctx,
      { reference: code, referenceType: SALES_REFERENCE.invoice, description: `تكلفة مبيعات - فاتورة ${code}`, clientId, invoiceId, currency, date },
      [{ accountId: costAccount.id, description: `تكلفة مبيعات - فاتورة ${code}`, debit, credit: 0 }, ...credits],
      owner,
      now,
      tx,
    );
  }

  /** سند القبض للدفعة المقدّمة — خزينةٌ مختارةٌ مسموحة، أو خزينة الموظف، أو الرئيسية */
  private async receipt(
    ctx: SalesContext,
    input: InvoiceInput,
    invoiceId: number,
    code: string,
    clientId: number,
    clientAccountId: number,
    payment: { advance: number; status: number },
    currency: string,
    owner: { branchId: number | null; employeeId: number | null },
    now: string,
    tx: Tx,
  ) {
    let treasuryId: number | null = null;
    if (input.treasuryId) {
      const denied = await this.treasuries.depositBlock(ctx, input.treasuryId);
      if (denied) throw AppError.forbidden('TREASURY_FORBIDDEN', denied);
      if (!(await this.ledger.account(input.treasuryId, tx))) throw fail('الخزينة المختارة غير موجودة.', 'treasuryId');
      treasuryId = input.treasuryId;
    } else if (ctx.user.employeeId) {
      treasuryId = (await this.sales.employeeTreasuryAccountIds(ctx.user.employeeId))[0] ?? null;
      if (treasuryId && !(await this.ledger.account(treasuryId, tx))) treasuryId = null;
    }
    if (!treasuryId) {
      const main = await this.accounts.find('main_treasury', null, tx);
      if (!main) throw new AppError('TREASURY_MISSING', 'لا خزينة متاحة لقبض الدفعة. اربط خزينةً بالموظّف، أو اضبط «الخزينة الرئيسية» في «الحسابات المحاسبية».', 422);
      treasuryId = main.id;
    }

    await this.writes.insertPayment(
      {
        invoice_id: invoiceId,
        client_id: clientId,
        branch_id: ctx.user.branchId ?? null,
        treasury_id: treasuryId,
        amount: payment.advance,
        payment_date: now,
        Payment_method: input.paymentMethod ?? (await this.sales.defaultReceiptPaymentMethod()),
        reference_number: input.referenceNumber,
        notes: 'تم إنشاء الدفعة تلقائياً عند إنشاء الفاتورة',
        type: 'client payments',
        payment_status: payment.status,
        employee_id: ctx.user.id,
        accounting_period_id: (await this.stock.accountingPeriodFor(ctx.today))?.id ?? null,
      },
      now,
      tx,
    );

    await this.entry(
      ctx,
      { reference: input.referenceNumber ?? code, referenceType: SALES_REFERENCE.collection, description: `دفعة للفاتورة رقم ${code}`, clientId, invoiceId, currency, date: ctx.today },
      [
        { accountId: treasuryId, description: `دفعة للفاتورة رقم ${code}`, debit: payment.advance, credit: 0 },
        { accountId: clientAccountId, description: `دفعة عميل  للفاتورة رقم ${code}`, debit: 0, credit: payment.advance },
      ],
      owner,
      now,
      tx,
    );
  }

  /** ملاحظة العهدة التراكمية على العميل — آخر عهدة + كميات الفاتورة */
  private async depositNote(ctx: SalesContext, invoiceId: number, code: string, clientId: number, input: InvoiceInput, total: number, currency: string, now: string, tx: Tx) {
    const quantity = input.items.reduce((s, i) => s + Math.trunc(i.quantity), 0);
    const previous = await this.writes.lastDepositCount(clientId, tx);
    await this.writes.insertClientRelation(
      {
        client_id: clientId,
        employee_id: ctx.user.id,
        type: 'invoice',
        invoice_id: invoiceId,
        description: `فاتورة رقم: ${code} - الكمية: ${quantity} قطعة - قيمة الفاتورة: ${fmtMoney(total)} ${currency}`,
        deposit_count: previous + quantity,
        date: ctx.today,
        time: now.slice(11, 19),
        status: 'completed',
        process: 'فاتورة مبيعات',
      },
      now,
      tx,
    );
  }

  /** `ClientWalletService::payInvoice()` — من ح/ محفظة العميل إلى ح/ ذممه */
  private async payFromWallet(ctx: SalesContext, invoiceId: number, code: string, client: { id: number; tradeName: string | null; branchId: number | null }, amount: number, owner: { branchId: number | null; employeeId: number | null }, now: string, tx: Tx) {
    const invoice = await this.sales.invoice(invoiceId, tx);
    if (!invoice) return;
    const outstanding = round2(Math.max(0, Math.min(invoice.grandTotal - invoice.walletPaidAmount, invoice.dueValue)));
    const applied = round2(Math.min(amount, outstanding));
    if (applied <= 0) return;

    const wallet = await this.sales.clientWalletAccount(client.id, tx);
    const receivable = await this.sales.clientLedgerAccount(client.id, tx);
    if (!wallet || !receivable) throw new AppError('WALLET_MISSING', 'الحساب المقابل لهذه الحركة غير متاح.', 422);
    if (applied > wallet.balance + 0.005) throw new AppError('WALLET_INSUFFICIENT', `رصيد المحفظة غير كافٍ. الرصيد الحالي: ${fmtMoney(wallet.balance)}`, 422);

    const description = `سداد فاتورة من محفظة العميل: ${client.tradeName ?? `#${client.id}`} — فاتورة ${code} — سداد تلقائي من محفظة العميل عند إنشاء الفاتورة`;
    const entryId = await this.entry(
      ctx,
      { reference: code, referenceType: SALES_REFERENCE.collection, description, clientId: client.id, invoiceId, currency: (await this.reference.defaultCurrency())?.code ?? 'SAR', date: ctx.today },
      [
        { accountId: wallet.id, description, debit: applied, credit: 0 },
        { accountId: receivable.id, description, debit: 0, credit: applied },
      ],
      owner,
      now,
      tx,
    );
    await this.ledger.setBatchReference(entryId, `CWALLET_${entryId}`, tx);
    await this.balances.updateBalancesHierarchically(wallet.id, now, tx);
    await this.balances.updateBalancesHierarchically(receivable.id, now, tx);
    const after = await this.sales.clientWalletAccount(client.id, tx);

    await this.writes.insertWalletTransaction(
      {
        client_id: client.id,
        account_id: wallet.id,
        type: 'invoice_paid',
        amount: applied,
        balance_after: after?.balance ?? 0,
        treasury_account_id: null,
        invoice_id: invoiceId,
        journal_entry_id: entryId,
        reference: code,
        note: 'سداد تلقائي من محفظة العميل عند إنشاء الفاتورة',
        branch_id: client.branchId,
        created_by: ctx.user.id,
      },
      now,
      tx,
    );

    const due = round2(Math.max(0, invoice.dueValue - applied));
    const status = [1, 2, 3].includes(invoice.paymentStatus ?? 0) ? (due <= 0.005 ? PAYMENT_STATUS.paid : PAYMENT_STATUS.partial) : invoice.paymentStatus;
    await this.writes.updateInvoice(invoiceId, { wallet_paid_amount: round2(invoice.walletPaidAmount + applied), due_value: due, payment_status: status, is_paid: due <= 0.005 ? 1 : 0 }, now, tx);
  }
}
