import { AppError } from '../../../domain/errors/AppError';
import { DocumentNumberRepository, OperationLogRepository, ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { InvoiceItemRow, QuoteRepository, QuoteRow, SalesProduct, SalesRepository } from '../../../domain/repositories/sales';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { calculateInvoice } from '../../../domain/services/sales/InvoiceCalculator';
import { bestGift, bestOfferDiscount, offerCoversClient } from '../../../domain/services/sales/PromotionRules';
import { allocateDocumentDiscount, round2, TaxBook, taxLine } from '../../../domain/services/sales/SalesMath';
import { SALES_LIMITS, SALES_PLAN } from '../../../domain/services/sales/SalesConstants';
import { Tx, UnitOfWork } from '../../ports';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { InvoiceRules, SalesSettings } from '../../services/sales/SalesSettings';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { InvoiceCreateUseCase } from './InvoiceCreateUseCase';

export type QuoteKind = 'quote' | 'sales_order';

interface KindConfig {
  type: QuoteKind;
  section: string;
  log: string;
  perm: string;
  label: string;
  manualStatusFlag: string;
  enabled: (rules: InvoiceRules) => boolean;
  disabledMessage: string;
}

const KINDS: Record<QuoteKind, KindConfig> = {
  quote: {
    type: 'quote',
    section: 'quotation',
    log: 'quote',
    perm: 'sales.quotes',
    label: 'عرض السعر',
    manualStatusFlag: 'manual_quote_status',
    enabled: (r) => !r.flag('disable_quotes'),
    disabledMessage: 'عروض الأسعار موقوفة من «إعدادات الفواتير».',
  },
  sales_order: {
    type: 'sales_order',
    section: 'sales-order',
    log: 'sales_order',
    perm: 'sales.sales_orders',
    label: 'أمر البيع',
    manualStatusFlag: 'manual_sales_order_status',
    enabled: (r) => r.flag('enable_sales_orders'),
    disabledMessage: 'أوامر البيع غير مفعَّلة في «إعدادات الفواتير».',
  },
};

const STATUS_LABELS: Record<string, string> = { Draft: 'مسودة', Pending: 'قيد الانتظار', Approved: 'معتمد', Converted_to_Invoice: 'محوَّل إلى فاتورة', Cancelled: 'ملغى', Expired: 'منتهي الصلاحية' };
const MANUAL_STATUSES = ['Draft', 'Pending', 'Approved', 'Cancelled'] as const;
const PER_PAGE = [10, 25, 50, 100];
const MAX_MONEY = 99_999_999.99;

export interface QuoteListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  number?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
}

interface QuoteInput {
  clientId: number;
  quoteDate: string;
  expiryDate: string | null;
  employeeId: number | null;
  terms: number;
  notes: string | null;
  discountValue: number;
  discountType: 'amount' | 'percentage';
  shippingCost: number;
  shippingTaxSelector: boolean;
  shippingTaxId: number | null;
  taxType: 1 | 2 | 3;
  status: string | null;
  items: Array<{ productId: number; unitId: number | null; quantity: number; unitPrice: number; discount: number; discountType: 'amount' | 'percentage'; tax1Id: number | null; tax2Id: number | null; description: string | null }>;
}

/**
 * عروض الأسعار وأوامر البيع — `QuoteController` و`SalesOrderController` (الوارث) معاً
 * بنوع المستند. والتحويل إلى فاتورة **بمحرّك الفاتورة نفسه** (`InvoiceCreateUseCase`)
 * لا بنسخةٍ ثانية منه كما في الويب: فتسري حدود الباقة والمستودعات والائتمان
 * والضرائب والقيود كلّها، ويُعلَّم المستند «محوَّلاً» في معاملة الفاتورة.
 */
export class QuoteUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly quotes: QuoteRepository,
    private readonly sales: SalesRepository,
    private readonly settings: SalesSettings,
    private readonly planLimits: PlanLimitGuard,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly logs: OperationLogRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly invoices: InvoiceCreateUseCase,
    private readonly uow: UnitOfWork,
  ) {}

  private async load(kind: QuoteKind, userId: number, meta: RequestMeta, action: string) {
    const cfg = KINDS[kind];
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.quotes], permissions: [`${cfg.perm}.${action}`] });
    const rules = await this.settings.rules();
    if (!cfg.enabled(rules)) throw AppError.forbidden('DOCUMENT_DISABLED', cfg.disabledMessage);
    return { ctx, cfg, rules };
  }

  private async find(ctx: SalesContext, cfg: KindConfig, id: number, tx?: Tx): Promise<QuoteRow> {
    const row = await this.quotes.find(id, cfg.type, tx);
    if (!row) throw AppError.notFound('QUOTE_NOT_FOUND', `${cfg.label} غير موجود.`);
    if (!(await ctx.canAccessDocument(row.createdBy, row.employeeId, row.branchId))) throw AppError.forbidden('QUOTE_FORBIDDEN', 'ليس لديك صلاحية لهذا المستند.');
    return row;
  }

  private locked(row: QuoteRow) {
    return row.status === 'Converted_to_Invoice' || row.status === 'Cancelled';
  }

  // ═══════════════════════ المدخلات والمجاميع ═══════════════════════

  private parse(cfg: KindConfig, body: Record<string, unknown>, book: TaxBook, today: string, manualStatus: boolean): QuoteInput {
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const clientId = form.integer('clientId', { required: true, min: 1, message: 'اختر العميل.' });
    const date = (key: string, fallback: string | null) => {
      const text = form.string(key);
      if (text === null) return fallback;
      const d = parseInputDate(text);
      if (!d) {
        errors.add(key, 'التاريخ بصيغة YYYY-MM-DD.');
        return fallback;
      }
      return toSqlDate(d);
    };
    const quoteDate = date('quoteDate', today) as string;
    const expiryDate = cfg.type === 'sales_order' ? null : date('expiryDate', null);
    if (expiryDate && expiryDate < quoteDate) errors.add('expiryDate', 'تاريخ الانتهاء لا يسبق تاريخ المستند.');
    const discountValue = form.number('discountAmount', { min: 0, max: MAX_MONEY }) ?? 0;
    const discountType = form.oneOf('discountType', ['amount', 'percentage'] as const, { message: 'نوع الخصم amount أو percentage.' }) ?? 'amount';
    if (discountType === 'percentage' && discountValue > 100) errors.add('discountAmount', 'نسبة الخصم لا تتجاوز 100.');
    const shippingTaxId = form.integer('shippingTaxId', { min: 1 });
    if (shippingTaxId !== null && !book.has(shippingTaxId)) errors.add('shippingTaxId', 'ضريبة الشحن غير موجودة في «إعدادات الضريبة».');
    const taxType = (form.integer('taxType', { in: [1, 2, 3], message: 'نوع الضريبة 1 (خاضع) أو 2 (صفري) أو 3 (معفى).' }) ?? 1) as 1 | 2 | 3;
    let status: string | null = null;
    if (manualStatus) status = form.oneOf('status', MANUAL_STATUSES, { message: `الحالة إحدى: ${MANUAL_STATUSES.join('، ')}.` });

    const list = form.array('items', { required: true, min: 1, max: 200, message: 'أضف صنفاً واحداً على الأقل.' }) ?? [];
    const items: QuoteInput['items'] = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const productId = item.integer('productId', { required: true, min: 1, message: 'اختر المنتج.' });
      const quantity = item.number('quantity', { required: true, message: 'الكمية مطلوبة.' });
      const unitPrice = item.number('unitPrice', { required: true, min: 0, max: MAX_MONEY, message: 'السعر مطلوب.' });
      const discount = item.number('discount', { min: 0, max: MAX_MONEY }) ?? 0;
      const type = item.oneOf('discountType', ['amount', 'percentage'] as const) ?? 'amount';
      const tax1Id = item.integer('tax1Id', { min: 1 });
      const tax2Id = item.integer('tax2Id', { min: 1 });
      if (quantity !== null && quantity <= 0) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      if (type === 'percentage' && discount > 100) errors.add(`items.${i}.discount`, 'نسبة الخصم لا تتجاوز 100.');
      for (const [k, id] of [['tax1Id', tax1Id], ['tax2Id', tax2Id]] as const) if (id !== null && !book.has(id)) errors.add(`items.${i}.${k}`, 'الضريبة غير موجودة في «إعدادات الضريبة».');
      if (productId !== null && quantity !== null && quantity > 0 && unitPrice !== null) {
        items.push({ productId, unitId: item.integer('unitId', { min: 1 }), quantity, unitPrice, discount, discountType: type, tax1Id, tax2Id, description: item.string('description', { max: 1000 }) });
      }
    });
    const notes = form.string('notes', { max: 5000 });
    const terms = form.integer('terms', { min: 0, max: 3650 }) ?? 0;
    const employeeId = form.integer('employeeId', { min: 1 });
    errors.throwIfAny();
    return { clientId: clientId as number, quoteDate, expiryDate, employeeId, terms, notes, discountValue, discountType, shippingCost: form.number('shippingCost', { min: 0, max: MAX_MONEY }) ?? 0, shippingTaxSelector: form.has('shippingTaxId'), shippingTaxId, taxType, status, items };
  }

  /** `calculateTotals()` — محرّك الفاتورة نفسه، والعروض والهدايا بمفتاح «تطبيق العروض على عروض الأسعار» */
  private async build(ctx: SalesContext, rules: InvoiceRules, book: TaxBook, input: QuoteInput) {
    const products = await this.sales.products(input.items.map((i) => i.productId));
    const units = await this.sales.unitsFor([...products.values()]);
    const offersApply = rules.flag('apply_offers_to_quotes');
    const offers = offersApply ? (await this.sales.discountOffers(ctx.today)).filter((o) => offerCoversClient(o, input.clientId)) : [];
    const taxable = input.taxType === 1;

    const lines = input.items.map((item, i) => {
      const product = products.get(item.productId) as SalesProduct | undefined;
      if (!product) throw AppError.validation({ [`items.${i}.productId`]: ['المنتج غير موجود.'] }, 'المنتج غير موجود.');
      let unit = null as null | { id: number; name: string; factor: number };
      if (item.unitId !== null) {
        const u = (units.get(product.id) ?? []).find((x) => x.id === item.unitId);
        if (!u) throw AppError.validation({ [`items.${i}.unitId`]: ['الوحدة المختارة ليست من وحدات هذا الصنف.'] }, 'الوحدة المختارة ليست من وحدات هذا الصنف.');
        unit = { id: u.id as number, name: u.name, factor: u.conversionFactor || 1 };
      }
      const base = item.quantity * item.unitPrice;
      const manual = item.discount > 0 ? (item.discountType === 'percentage' ? (base * item.discount) / 100 : item.discount) : 0;
      let discount = manual;
      let offerFilled = false;
      if (manual <= 0 && base > 0 && offers.length) {
        const match = bestOfferDiscount(offers, product.id, product.categoryId, item.quantity, base);
        if (match) {
          discount = match.amount;
          offerFilled = true;
        }
      }
      discount = Math.min(discount, base);
      return { item, product, unit, base, discount, offerFilled };
    });

    const gifts: typeof lines = [];
    if (offersApply) {
      const giftOffers = await this.sales.giftOffers(input.clientId, ctx.user.id, ctx.today);
      for (const l of lines) {
        const match = bestGift(giftOffers, l.product.id, l.item.quantity * (l.unit?.factor ?? 1));
        if (!match?.offer.giftProductId) continue;
        const gp = (await this.sales.products([match.offer.giftProductId])).get(match.offer.giftProductId);
        if (gp) gifts.push({ item: { productId: gp.id, unitId: null, quantity: match.quantity, unitPrice: 0, discount: 0, discountType: 'amount', tax1Id: null, tax2Id: null, description: 'هدية عرض' }, product: { ...gp, name: `${gp.name} (هدية)` }, unit: null, base: 0, discount: 0, offerFilled: false });
      }
    }

    const all = [...lines, ...gifts];
    const taxIds = (l: (typeof all)[number]): [number | null, number | null] => (taxable ? [l.item.tax1Id, l.item.tax2Id] : [null, null]);
    const totals = await calculateInvoice(
      book,
      {
        lines: all.map((l) => ({ quantity: l.item.quantity, unitPrice: l.item.unitPrice, discount: l.discount, taxIds: taxIds(l) })),
        discountValue: input.discountValue,
        discountType: input.discountType,
        shippingCost: input.shippingCost,
        shippingTaxSelector: taxable ? input.shippingTaxSelector : true,
        shippingTaxId: taxable ? input.shippingTaxId : null,
      },
      async () => ({ discount: 0, freeShipping: false }),
    );

    // ضرائب البنود بعد حصّتها من الخصم العامّ — كما دخلت `tax_total`
    const nets = all.map((l) => Math.max(0, l.base - l.discount));
    const shares = allocateDocumentDiscount(nets, Math.min(totals.invoiceDiscount, Math.max(0, nets.reduce((s, n) => s + n, 0))));
    const taxRows: Array<Record<string, unknown>> = [];
    if (taxable) {
      all.forEach((l, i) => {
        for (const t of taxLine(book, 1, Math.max(0, nets[i] - (shares[i] ?? 0)), 0, taxIds(l)).taxes) {
          const s = t.id ? book.get(t.id) : null;
          if (s) taxRows.push({ name: s.name, type: s.type, rate: s.rate, value: t.amount, product_id: l.product.id });
        }
      });
    }

    const items = all.map((l, i) => ({
      product_id: l.product.id,
      item: l.product.name,
      description: l.item.description,
      quantity: l.item.quantity,
      product_unit_id: l.unit?.id ?? null,
      unit_name: l.unit?.name ?? null,
      conversion_factor: l.unit?.factor ?? 1,
      quantity_in_base_unit: Math.round(l.item.quantity * (l.unit?.factor ?? 1) * 10000) / 10000,
      unit_price: l.item.unitPrice,
      // ما كتبه المستخدم ونوعُه — أو خصمُ العرض مبلغاً (يُقرأ كذلك عند التحويل)
      discount: l.offerFilled ? round2(l.discount) : l.item.discount,
      discount_type: l.offerFilled ? 1 : l.item.discountType === 'percentage' ? 2 : 1,
      tax_1: taxable && l.item.tax1Id ? book.get(l.item.tax1Id)?.rate ?? 0 : 0,
      tax_1_id: l.item.tax1Id,
      tax_2: taxable && l.item.tax2Id ? book.get(l.item.tax2Id)?.rate ?? 0 : 0,
      tax_2_id: l.item.tax2Id,
      total: round2(totals.lineTotals[i] ?? 0),
    }));

    return {
      header: {
        discount_type: input.discountType,
        discount_amount: input.discountValue,
        shipping_cost: totals.shippingCost,
        shipping_tax: totals.shippingTax,
        tax_type: String(input.taxType),
        subtotal: totals.subtotal,
        total_discount: round2(totals.totalDiscount),
        total_tax: totals.taxTotal,
        grand_total: round2(totals.grandTotal),
      },
      items,
      taxRows,
    };
  }

  // ═══════════════════════ الكتابة ═══════════════════════

  async store(kind: QuoteKind, userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const { ctx, cfg, rules } = await this.load(kind, userId, meta, 'create');
    const book = await this.settings.taxBook();
    const input = this.parse(cfg, body, book, ctx.today, rules.flag(cfg.manualStatusFlag));
    const client = await this.sales.client(input.clientId);
    if (!client) throw AppError.validation({ clientId: ['العميل المحدَّد غير موجود.'] }, 'العميل المحدَّد غير موجود.');
    await ctx.assertClient(client.id);
    await this.planLimits.assert(SALES_LIMITS.quotes, ctx.now);
    const block = await this.periodGuard.block(input.quoteDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `الفترة المحاسبية لهذا التاريخ مقفلة: ${block}`, 422);

    const built = await this.build(ctx, rules, book, input);
    const employeeId = await ctx.clampEmployee(input.employeeId);
    const id = await this.uow.run(async (tx) => {
      await this.planLimits.assert(SALES_LIMITS.quotes, ctx.now);
      const now = ctx.nowSql;
      const number = await this.numbers.next(cfg.section, ctx.now, tx);
      const quoteId = await this.quotes.insert(
        {
          type: cfg.type,
          client_id: client.id,
          branch_id: ctx.user.branchId ?? null,
          created_by: ctx.user.id,
          quote_date: input.quoteDate,
          expiry_date: input.expiryDate,
          employee_id: employeeId,
          payment_terms: input.terms > 0 ? String(input.terms) : null,
          quote_number: number,
          notes: input.notes,
          currency: (await this.reference.defaultCurrency())?.code ?? 'SAR',
          status: input.status ?? 'Approved',
          ...built.header,
        },
        now,
        tx,
      );
      await this.quotes.replaceItems(quoteId, cfg.type, built.items, built.taxRows, now, tx);
      await this.logs.record({ action: 'created', module: cfg.log, subjectId: quoteId, description: `إنشاء ${cfg.label} رقم ${number} للعميل ${client.tradeName ?? ''}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route, newValues: { grand_total: built.header.grand_total } }, tx);
      return quoteId;
    });
    const row = await this.find(ctx, cfg, id);
    return { message: `تم إنشاء ${cfg.label} رقم ${row.number} بنجاح.`, data: await this.detailOf(cfg, row) };
  }

  async update(kind: QuoteKind, userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const { ctx, cfg, rules } = await this.load(kind, userId, meta, 'edit');
    const current = await this.find(ctx, cfg, id);
    if (this.locked(current)) throw new AppError('QUOTE_LOCKED', `${cfg.label} ${current.status === 'Cancelled' ? 'ملغى' : 'محوَّل إلى فاتورة'} — لا يُعدَّل.`, 422);
    const book = await this.settings.taxBook();
    const input = this.parse(cfg, body, book, current.quoteDate ?? ctx.today, rules.flag(cfg.manualStatusFlag));
    const client = await this.sales.client(input.clientId);
    if (!client) throw AppError.validation({ clientId: ['العميل المحدَّد غير موجود.'] }, 'العميل المحدَّد غير موجود.');
    await ctx.assertClient(client.id);
    const block = await this.periodGuard.block(input.quoteDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `الفترة المحاسبية لهذا التاريخ مقفلة: ${block}`, 422);
    const built = await this.build(ctx, rules, book, input);
    const employeeId = await ctx.clampEmployee(input.employeeId);

    await this.uow.run(async (tx) => {
      await this.quotes.lock(id, tx);
      const fresh = await this.quotes.find(id, cfg.type, tx);
      if (!fresh || this.locked(fresh)) throw new AppError('QUOTE_LOCKED', `${cfg.label} لم يعد قابلاً للتعديل.`, 422);
      await this.quotes.update(
        id,
        { client_id: client.id, quote_date: input.quoteDate, expiry_date: input.expiryDate, employee_id: employeeId, payment_terms: input.terms > 0 ? String(input.terms) : null, notes: input.notes, ...(input.status ? { status: input.status } : {}), ...built.header },
        tx,
      );
      await this.quotes.replaceItems(id, cfg.type, built.items, built.taxRows, ctx.nowSql, tx);
      await this.logs.record({ action: 'updated', module: cfg.log, subjectId: id, description: `تعديل ${cfg.label} رقم ${current.number}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route, oldValues: { grand_total: current.grandTotal }, newValues: { grand_total: built.header.grand_total } }, tx);
    });
    return { message: `تم تعديل ${cfg.label} رقم ${current.number} بنجاح.`, data: await this.detailOf(cfg, await this.find(ctx, cfg, id)) };
  }

  async destroy(kind: QuoteKind, userId: number, meta: RequestMeta, id: number) {
    const { ctx, cfg } = await this.load(kind, userId, meta, 'delete');
    const current = await this.find(ctx, cfg, id);
    if (current.status === 'Converted_to_Invoice') throw new AppError('QUOTE_LOCKED', `${cfg.label} محوَّل إلى فاتورة — لا يُحذف.`, 422);
    const block = await this.periodGuard.block(current.quoteDate ?? ctx.today, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `الفترة المحاسبية لهذا التاريخ مقفلة: ${block}`, 422);
    await this.uow.run(async (tx) => {
      await this.quotes.lock(id, tx);
      const fresh = await this.quotes.find(id, cfg.type, tx);
      if (!fresh || fresh.status === 'Converted_to_Invoice') throw new AppError('QUOTE_LOCKED', `${cfg.label} محوَّل إلى فاتورة — لا يُحذف.`, 422);
      await this.quotes.delete(id, cfg.type, tx);
      await this.logs.record({ action: 'deleted', module: cfg.log, subjectId: null, description: `حذف ${cfg.label} رقم ${current.number}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route }, tx);
    });
    return { message: `تم حذف ${cfg.label} رقم ${current.number}.` };
  }

  /**
   * `convertToInvoice()` — بنود المستند وخصومه وشحنه تصير طلبَ فاتورةٍ يمرّ بمحرّكها
   * كاملاً، والمستند يُعلَّم «محوَّلاً» ويُربط بالفاتورة داخل معاملتها بعد قفله:
   * تحويلان متزامنان لا يُصدران فاتورتين.
   */
  async convert(kind: QuoteKind, userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const { ctx, cfg, rules } = await this.load(kind, userId, meta, 'convert');
    const quote = await this.find(ctx, cfg, id);
    this.assertConvertible(cfg, quote, ctx.today);
    void rules;

    const items = (await this.sales.quoteItems(quote.id)).filter((i: InvoiceItemRow) => i.productId && !(i.unitPrice === 0 && i.item.endsWith('(هدية)')));
    if (!items.length) throw new AppError('QUOTE_EMPTY', `${cfg.label} بلا بنود — لا يُحوَّل.`, 422);
    const taxable = (quote.taxType ?? '1') === '1';
    const shippingTaxId = quote.shippingCost > 0 && quote.shippingTax > 0 ? this.matchByRate(await this.settings.taxBook(), round2((quote.shippingTax / quote.shippingCost) * 100)) : null;
    const pass = (key: string) => (body[key] === undefined ? {} : { [key]: body[key] });

    const invoiceBody: Record<string, unknown> = {
      clientId: quote.clientId,
      employeeId: quote.employeeId,
      terms: quote.paymentTerms ? Number(quote.paymentTerms) || 0 : 0,
      notes: [quote.notes, `${cfg.label} رقم: ${quote.number ?? quote.id}`].filter(Boolean).join('\n'),
      discountAmount: quote.discountAmount,
      discountType: quote.discountType === 'percentage' ? 'percentage' : 'amount',
      shippingCost: quote.shippingCost,
      ...(quote.shippingCost > 0 ? { shippingTaxId } : {}),
      items: items.map((i) => ({
        productId: i.productId,
        ...(i.productUnitId ? { unitId: i.productUnitId } : {}),
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        // الخصم مبلغاً — `convertedLineDiscount()`
        discount: i.discountType === 2 ? round2((i.quantity * i.unitPrice * i.discount) / 100) : i.discount,
        discountType: 'amount',
        tax1Id: taxable ? i.tax1Id : null,
        tax2Id: taxable ? i.tax2Id : null,
        description: i.description,
      })),
      ...pass('warehouseId'),
      ...pass('isPaid'),
      ...pass('advancePayment'),
      ...pass('paymentMethod'),
      ...pass('treasuryId'),
      ...pass('orderSourceId'),
      ...pass('currentLatitude'),
      ...pass('currentLongitude'),
    };

    const result = await this.invoices.store(userId, meta, invoiceBody, { permission: `${cfg.perm}.convert`, inTransaction: async (tx, invoiceId, code) => {
      await this.quotes.lock(quote.id, tx);
      const fresh = await this.quotes.find(quote.id, cfg.type, tx);
      if (!fresh) throw AppError.notFound('QUOTE_NOT_FOUND', `${cfg.label} غير موجود.`);
      this.assertConvertible(cfg, fresh, ctx.today);
      await this.quotes.update(quote.id, { status: 'Converted_to_Invoice', invoice_id: invoiceId }, tx);
      await this.logs.record({ action: 'converted', module: cfg.log, subjectId: quote.id, description: `تحويل ${cfg.label} رقم ${quote.number} إلى الفاتورة ${code}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route }, tx);
    } });
    return { message: `${result.message} — عن ${cfg.label} رقم ${quote.number}`, data: { invoice: result.data, [cfg.type === 'quote' ? 'quote' : 'salesOrder']: await this.detailOf(cfg, await this.find(ctx, cfg, quote.id)) } };
  }

  /** `blocksConversion()` — المحوَّل والملغى والمنتهي، ومعه ما مضى تاريخُ انتهائه ولو لم تعلّمه المهمّة المجدولة */
  private assertConvertible(cfg: KindConfig, q: QuoteRow, today: string) {
    if (q.status === 'Converted_to_Invoice') throw new AppError('QUOTE_CONVERTED', `${cfg.label} محوَّلٌ إلى فاتورة سابقاً${q.invoiceCode ? ` (${q.invoiceCode})` : ''}.`, 422);
    if (q.status === 'Cancelled') throw new AppError('QUOTE_CANCELLED', `${cfg.label} ملغى — لا يُحوَّل.`, 422);
    if (q.status === 'Expired' || (q.expiryDate && q.expiryDate.slice(0, 10) < today)) throw new AppError('QUOTE_EXPIRED', `${cfg.label} منتهي الصلاحية — مُدَّ تاريخه ثمّ حوِّله.`, 422);
  }

  private matchByRate(book: TaxBook, rate: number): number | null {
    for (const t of book.values()) if (Math.abs(t.rate - rate) < 0.01) return t.id;
    return null;
  }

  // ═══════════════════════ القراءة ═══════════════════════

  private summary(q: QuoteRow) {
    return {
      id: q.id,
      type: q.type,
      number: q.number,
      client: q.clientId ? { id: q.clientId, tradeName: q.clientName } : null,
      employee: q.employeeId ? { id: q.employeeId, name: q.employeeName } : null,
      createdBy: q.createdBy ? { id: q.createdBy, name: q.createdByName } : null,
      invoice: q.invoiceId ? { id: q.invoiceId, code: q.invoiceCode } : null,
      date: q.quoteDate,
      expiryDate: q.expiryDate,
      paymentTerms: q.paymentTerms ? Number(q.paymentTerms) : null,
      currency: q.currency,
      discountType: q.discountType,
      discountAmount: q.discountAmount,
      shippingCost: q.shippingCost,
      shippingTax: q.shippingTax,
      taxType: q.taxType ? Number(q.taxType) : 1,
      subtotal: q.subtotal,
      totalDiscount: q.totalDiscount,
      totalTax: q.totalTax,
      grandTotal: q.grandTotal,
      status: q.status,
      statusLabel: STATUS_LABELS[q.status] ?? q.status,
      createdAt: q.createdAt,
    };
  }

  private async detailOf(cfg: KindConfig, q: QuoteRow) {
    void cfg;
    const items = await this.sales.quoteItems(q.id);
    return {
      ...this.summary(q),
      notes: q.notes,
      items: items.map((i) => ({ id: i.id, productId: i.productId, item: i.item, description: i.description, unitName: i.unitName, productUnitId: i.productUnitId, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount, discountType: i.discountType === 2 ? 'percentage' : 'amount', tax1Id: i.tax1Id, tax2Id: i.tax2Id, total: i.total })),
    };
  }

  async show(kind: QuoteKind, userId: number, meta: RequestMeta, id: number) {
    const { ctx, cfg } = await this.load(kind, userId, meta, 'view');
    return this.detailOf(cfg, await this.find(ctx, cfg, id));
  }

  async list(kind: QuoteKind, userId: number, meta: RequestMeta, q: QuoteListQuery) {
    const { ctx, cfg } = await this.load(kind, userId, meta, 'view');
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;
    const { rows, total } = await this.quotes.page(
      { type: cfg.type, scope: await ctx.documentScope(), headerBranchIds: await ctx.headerBranchIds(), clientId: q.clientId, number: q.number?.trim() || undefined, status: q.status, fromDate: q.fromDate, toDate: q.toDate },
      page,
      perPage,
    );
    return { items: rows.map((r) => this.summary(r)), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }
}
