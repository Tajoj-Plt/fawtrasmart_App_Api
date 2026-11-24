import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository } from '../../../domain/repositories/clients';
import { PermitLineWrite, PermitRepository, PermitRow, StockRepository } from '../../../domain/repositories/stock';
import { parseLocal, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { PERMIT_STATUS, PERMIT_TYPES, permitStatusKey, STOCK_PLAN } from '../../../domain/services/stock/StockConstants';
import { ImageStore, Tx, UnitOfWork } from '../../ports';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { NotificationGate } from '../../services/clients/ClientsSupport';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput, UploadedFile } from '../../services/clients/FormInput';
import { PeriodResolver } from '../../services/PeriodResolver';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { StockContext, StockContextFactory } from '../../services/stock/StockContext';
import { StockLog } from '../../services/stock/StockLog';

export const PERMIT_PERMISSIONS = {
  view: 'stock.permits.view',
  show: 'stock.permits.show',
  edit: 'stock.permits.edit',
  delete: 'stock.permits.delete',
  approve: 'stock.permits.approve',
  reject: 'stock.permits.reject',
  cancelApproval: 'stock.permits.cancel_approval',
} as const;

const ANY_CREATE = Object.values(PERMIT_TYPES).map((t) => t.permission);
const PER_PAGE = [10, 25, 50, 100];
const ATTACHMENTS_FOLDER = 'assets/uploads/warehouse';

/** سقوف الأعمدة — جلسة Node غير صارمة فتقصّ ما يزيد بصمت، والويب يسقط بخطأ SQL */
const MAX_MONEY = 99_999_999.99; // decimal(10,2)
const MAX_QUANTITY = 99_999_999_999_999; // decimal(18,4)
const MAX_TEXT_BYTES = 65_535; // text

export interface PermitListQuery {
  page?: number;
  perPage?: number;
  status?: string;
  keywords?: string;
  permissionType?: number;
  permissionSource?: number;
  warehouse?: number;
  client?: number;
  supplier?: number;
  /** غائب = عملة النظام، و'' = كل العملات — `filterCurrency()` */
  currency?: string;
  createdBy?: number;
  product?: number;
  periodId?: string;
  fromDate?: string;
  toDate?: string;
  branch?: number;
}

/** اعتماد الإذن داخل معاملة قائمة — يرمي `AppError` برسالة الويب إن تعذّر */
export interface PermitApprover {
  approveWithin(ctx: StockContext, permitId: number, tx: Tx): Promise<unknown>;
}

interface PermitInput {
  type: number;
  date: string;
  warehouseId: number | null;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  details: string | null;
  lines: Array<{ productId: number; quantity: number; unitPrice: number; total: number }>;
}

const statusOf = (s: string | null) => permitStatusKey(s);

/**
 * الأذون المخزنية — `StorePermitsManagementController` في الويب بأنواعه الأربعة:
 * القائمة بنطاقها وفلاترها، العرض، بيانات شاشة الإنشاء، الحفظ (رقمٌ من «الترقيم
 * المتسلسل» تحت قفل، وفحص الرصيد، وحارس الفترة)، التعديل، الحذف، والرفض.
 * الكمية لا تتحرّك إلا عند الاعتماد — والرصيد الافتتاحي يُعتمد في معاملة حفظه.
 */
export class PermitUseCases {
  constructor(
    private readonly contexts: StockContextFactory,
    private readonly permits: PermitRepository,
    private readonly stock: StockRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly numbers: DocumentNumberRepository,
    private readonly periods: PeriodResolver,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly notifications: NotificationGate,
    private readonly images: ImageStore,
    private readonly log: StockLog,
    private readonly uow: UnitOfWork,
    private readonly approver: () => PermitApprover,
  ) {}

  private load(userId: number, meta: RequestMeta, permissions: Array<string | string[]>) {
    return this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.permits], permissions });
  }

  // ═══════════════════════ القراءة ═══════════════════════

  /** `permitPayload()` — الصلاحية وحدها لا تكفي: حالة الإذن تحسم ما يجوز عليه */
  private async payload(ctx: StockContext, p: PermitRow) {
    const type = p.permissionType ?? 0;
    const status = statusOf(p.status);
    const pending = status === 'pending';
    const inScope = await ctx.canAccessCreator(p.createdBy);
    const meta = PERMIT_TYPES[type];

    return {
      id: p.id,
      number: p.number,
      type,
      typeLabel: meta?.label ?? null,
      status,
      date: p.permissionDate,
      warehouse: p.warehouseName,
      fromWarehouse: p.fromWarehouseName,
      toWarehouse: p.toWarehouseName,
      grandTotal: p.grandTotal,
      currency: p.currency,
      details: p.details,
      createdBy: p.createdByName,
      canEdit: inScope && pending && ctx.can(PERMIT_PERMISSIONS.edit) && Boolean(meta) && ctx.can(meta.permission),
      canDelete: inScope && status !== 'approved' && ctx.can(PERMIT_PERMISSIONS.delete),
      canApprove: inScope && pending && ctx.can(PERMIT_PERMISSIONS.approve),
      canReject: inScope && pending && ctx.can(PERMIT_PERMISSIONS.reject),
      canCancelApproval: inScope && status === 'approved' && ctx.can(PERMIT_PERMISSIONS.cancelApproval),
    };
  }

  async list(userId: number, meta: RequestMeta, q: PermitListQuery) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.view]);
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;

    const status = q.status === undefined ? undefined : ((PERMIT_STATUS as Record<string, string>)[q.status] ?? q.status);
    const currency = q.currency === undefined ? await this.defaultCurrency() : q.currency.trim() || null;
    const period = await this.periods.resolve(q.periodId, ctx.today);

    const { rows, total } = await this.permits.page(
      {
        creatorIds: await ctx.accessibleUserIds(),
        warehouseIds: await ctx.accessibleWarehouseIds(),
        branch: q.branch,
        keywords: q.keywords,
        permissionType: q.permissionType,
        permissionSource: q.permissionSource,
        warehouse: q.warehouse,
        client: q.client,
        supplier: q.supplier,
        status,
        currency,
        createdBy: q.createdBy,
        product: q.product,
        periodIds: period.periodIds,
        fromDate: q.fromDate,
        toDate: q.toDate,
      },
      page,
      perPage,
    );

    const items = [];
    for (const p of rows) items.push(await this.payload(ctx, p));
    return { items, total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }

  private async defaultCurrency() {
    return (await this.reference.defaultCurrency())?.code ?? 'SAR';
  }

  private async findPermit(ctx: StockContext, id: number, tx?: Tx, lock = false) {
    const p = await this.permits.find(id, tx, lock);
    if (!p) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
    await ctx.authorizeCreator(p.createdBy);
    return p;
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.show]);
    const p = await this.findPermit(ctx, id);
    const [items, logs] = await Promise.all([this.permits.items(p.id), this.permits.logs(p.id)]);
    return {
      ...(await this.payload(ctx, p)),
      items,
      attachments: p.attachments,
      rejectionReason: p.rejectionReason,
      logs,
    };
  }

  /** `create()` / `manual_disbursement()` / `manual_conversion()` / `opening_balance()` */
  async createData(userId: number, meta: RequestMeta, typeValue: number | undefined) {
    const ctx = await this.load(userId, meta, [ANY_CREATE]);
    const type = typeValue ?? 0;
    const t = PERMIT_TYPES[type];
    if (!t) throw AppError.validation({ type: ['نوع إذنٍ غير معروف.'] }, 'نوع إذنٍ غير معروف.');
    if (!ctx.can(t.permission)) throw AppError.forbidden('FORBIDDEN', 'لا تملك صلاحية إنشاء هذا النوع من الأذون المخزنية.');

    const ids = await ctx.accessibleWarehouseIds();
    // الإضافة والرصيد الافتتاحي: المستودعات النشطة؛ الصرف والتحويل: `accessibleWarehouses()` بترتيب الاسم
    const [warehouses, products, serialNumber] = await Promise.all([
      type === 1 || type === 4 ? this.stock.warehouseOptions(ids, true, 'id') : this.stock.warehouseOptions(ids, false, 'name'),
      this.permits.stockedProducts(),
      this.numbers.peek(t.numberSection, ctx.now).catch(() => ''),
    ]);

    return { type, serialNumber, warehouses, products };
  }

  /** `getProductStock()` — الجمع لا الصفّ الأول، وبحارس النطاق */
  async productStock(userId: number, meta: RequestMeta, warehouseId: number, productId: number) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.view]);
    await ctx.authorizeWarehouse(warehouseId);
    if (!(await this.permits.productsByIds([productId])).has(productId)) throw AppError.notFound('PRODUCT_NOT_FOUND', 'الصنف غير موجود.');

    const stock = await this.permits.stockOf(warehouseId, productId);
    return {
      stock,
      formatted: stock.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
  }

  // ═══════════════════════ التحقّق ═══════════════════════

  /** `WarehousePermitsRequest` — القواعد والرسائل نفسها */
  private async validate(body: Record<string, unknown>, files: UploadedFile[]): Promise<{ input: PermitInput; attachment: UploadedFile | null }> {
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);

    const type = form.integer('permissionType', { required: true, min: 1, message: 'نوع الإذن مطلوب.' });

    const dateText = form.string('permissionDate', { required: true, message: 'التاريخ مطلوب.' });
    let date: string | null = null;
    if (dateText !== null) {
      const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(dateText);
      const parsed = m ? parseLocal(dateText) : null;
      if (!m || !parsed || toSqlDate(parsed) !== m[1]) errors.add('permissionDate', 'حقل «التاريخ» يجب أن يكون تاريخاً صالحاً.');
      else date = m[2] ? `${m[1]} ${m[2]}:${m[3] ?? '00'}` : m[1];
    }

    const isTransfer = type === 3;
    const warehouseId = form.integer('warehouseId', { required: !isTransfer, min: 1, message: 'يجب اختيار المستودع.' });
    const fromWarehouseId = form.integer('fromWarehouseId', { required: isTransfer, min: 1, message: 'يجب اختيار المستودع المصدر.' });
    const toWarehouseId = form.integer('toWarehouseId', { required: isTransfer, min: 1, message: 'يجب اختيار المستودع الهدف.' });
    if (toWarehouseId !== null && fromWarehouseId !== null && toWarehouseId === fromWarehouseId) errors.add('toWarehouseId', 'لا يُحوَّل المخزون من مستودعٍ إلى نفسه.');

    const details = form.string('details');
    if (details !== null && Buffer.byteLength(details, 'utf8') > MAX_TEXT_BYTES) errors.add('details', 'حقل «التفاصيل» أطول من المسموح.');

    const grandTotal = form.number('grandTotal', { required: true, message: 'يجب إدخال المجموع الإجمالي.' });
    if (grandTotal !== null && grandTotal < 0.01) errors.add('grandTotal', 'إجمالي الإذن يجب أن يكون أكبر من صفر.');

    // `items` مصفوفة، أو نصّ JSON حين يصل الطلب متعدّد الأجزاء مع مرفق
    let rawItems = body.items;
    if (typeof rawItems === 'string') {
      try {
        rawItems = JSON.parse(rawItems);
      } catch {
        rawItems = undefined;
        errors.add('items', 'حقل «الأصناف» يجب أن يكون قائمة.');
      }
    }
    const list = new FormInput({ items: rawItems }, errors).array('items', { required: true, min: 1, message: 'أضف صنفاً واحداً على الأقل إلى الإذن.' }) ?? [];

    const lines: PermitInput['lines'] = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const productId = item.integer('productId', { required: true, min: 1, message: 'المنتج المحدد غير صالح.' });
      const quantity = item.number('quantity', { required: true, message: 'الكمية مطلوبة لكل منتج.' });
      const unitPrice = item.number('unitPrice', { required: true, min: 0, max: MAX_MONEY, message: 'سعر الوحدة مطلوب لكل منتج.' });
      const total = item.number('total', { required: true, min: 0, max: MAX_MONEY, message: 'الإجمالي مطلوب لكل منتج.' });
      if (quantity !== null && quantity < 0.01) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      else if (quantity !== null && quantity > MAX_QUANTITY) errors.add(`items.${i}.quantity`, 'الكمية أكبر من المسموح.');
      if (productId !== null && quantity !== null && unitPrice !== null && total !== null) lines.push({ productId, quantity, unitPrice, total });
    });

    // `exists:store_houses,id` و`exists:products,id`
    const warehouseRefs = [warehouseId, fromWarehouseId, toWarehouseId].filter((v): v is number => v !== null);
    const existing = await this.permits.existingWarehouseIds(warehouseRefs);
    if (warehouseId !== null && !existing.has(warehouseId)) errors.add('warehouseId', 'المستودع المحدد غير صالح.');
    if (fromWarehouseId !== null && !existing.has(fromWarehouseId)) errors.add('fromWarehouseId', 'قيمة «المستودع المصدر» غير صالحة.');
    if (toWarehouseId !== null && !existing.has(toWarehouseId)) errors.add('toWarehouseId', 'قيمة «المستودع الهدف» غير صالحة.');

    const products = await this.permits.productsByIds(lines.map((l) => l.productId));
    lines.forEach((l, i) => {
      if (!products.has(l.productId)) errors.add(`items.${i}.productId`, 'المنتج المحدد غير صالح.');
    });

    const sum = lines.reduce((s, l) => s + l.total, 0);
    if (sum > MAX_MONEY) errors.add('grandTotal', 'إجمالي الإذن أكبر من المسموح.');

    const attachment = files.find((f) => f.fieldname === 'attachments') ?? null;
    if (attachment) {
      const isPdf = attachment.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
      const isImage = /^\xff\xd8\xff/.test(attachment.buffer.subarray(0, 3).toString('latin1')) || attachment.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPdf && !isImage) errors.add('attachments', 'صيغة المرفق غير مدعومة: PDF أو صورة.');
      else if (attachment.size > 5120 * 1024) errors.add('attachments', 'حجم المرفق يتجاوز 5 ميغابايت.');
    }

    errors.throwIfAny();
    return {
      input: { type: type!, date: date!, warehouseId, fromWarehouseId, toWarehouseId, details, lines },
      attachment,
    };
  }

  /** `authorizeCreatePermissionType()` — أربعة أنواعٍ بصلاحياتٍ منفصلة */
  private authorizeType(ctx: StockContext, type: number) {
    const t = PERMIT_TYPES[type];
    if (!t) throw AppError.validation({ permissionType: ['نوع إذنٍ غير معروف.'] }, 'نوع إذنٍ غير معروف.');
    if (!ctx.can(t.permission)) throw AppError.forbidden('FORBIDDEN', 'لا تملك صلاحية إنشاء هذا النوع من الأذون المخزنية.');
    return t;
  }

  /** `assertWarehouseAccess()` — خطأ تحقّقٍ على الحقل لا 403 */
  private async assertWarehouses(ctx: StockContext, input: PermitInput) {
    for (const [field, id] of [
      ['warehouseId', input.warehouseId],
      ['fromWarehouseId', input.fromWarehouseId],
      ['toWarehouseId', input.toWarehouseId],
    ] as const) {
      if (id !== null && !(await ctx.canAccessWarehouse(id))) throw AppError.validation({ [field]: ['لا تملك صلاحية الوصول إلى هذا المستودع.'] }, 'لا تملك صلاحية الوصول إلى هذا المستودع.');
    }
  }

  /** `checkProductsStatus()` ثم `StockEligibility::firstStockless()` */
  private async assertProducts(productIds: number[]) {
    const products = await this.permits.productsByIds(productIds);
    const inactive = [...products.values()].filter((p) => p.status !== 'active');
    if (inactive.length) {
      const message = `لا يمكن إجراء العملية على المنتجات التالية لأنها غير نشطة: ${inactive.map((p) => p.name).join(', ')}`;
      throw new AppError('PRODUCTS_INACTIVE', message, 422);
    }
    for (const id of productIds) {
      const p = products.get(id);
      // `ProductType::from_value()`: نوعٌ غير معروف يُعامَل سلعةً، فالخدمي والرقمي وحدهما بلا رصيد
      if (p && (p.type === 'services' || p.type === 'digital')) {
        const label = p.type === 'services' ? 'منتج خدمي' : 'منتج رقمي';
        throw new AppError('STOCKLESS_PRODUCT', `لا يمكن إدخال «${p.name || 'هذا الصنف'}» في المخزون: نوعه ${label} ولا رصيد له في المستودعات.`, 422);
      }
    }
  }

  /** مستودع الإذن بحسب نوعه — التحويل من «من»، والصرف مستودعٌ واحد و«من» مقبول */
  private headerWarehouse(input: PermitInput) {
    if (input.type === 3) return input.fromWarehouseId;
    if (input.type === 2) return input.warehouseId ?? input.fromWarehouseId;
    return input.warehouseId;
  }

  // ═══════════════════════ الحفظ ═══════════════════════

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.load(userId, meta, [ANY_CREATE]);
    // `plan.limit:warehouse_permits` على المسار — قبل قراءة النموذج
    await this.planLimits.assert('warehouse_permits', ctx.now);

    const { input, attachment } = await this.validate(body, files);
    const t = this.authorizeType(ctx, input.type);
    await this.assertWarehouses(ctx, input);
    await this.assertProducts(input.lines.map((l) => l.productId));

    const block = await this.periodGuard.block(input.date, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);

    const storeHouseId = this.headerWarehouse(input);
    const now = ctx.nowSql;
    const periodId = (await this.stock.accountingPeriodFor(input.date.slice(0, 10)))?.id ?? null;
    const uploaded = attachment ? await this.images.saveDocument(ATTACHMENTS_FOLDER, attachment) : null;

    try {
      const permit = await this.uow.run(async (tx) => {
        // حارس النموذج (`PlanLimitObserver`) داخل المعاملة — لا يتجاوز طلبان متزامنان الحدّ
        await this.planLimits.assert('warehouse_permits', ctx.now);

        const number = await this.numbers.next(t.numberSection, ctx.now, tx);
        const id = await this.permits.insert(
          {
            permission_type: input.type,
            permission_date: input.date,
            sub_account: null,
            number,
            details: input.details,
            grand_total: round2(input.lines.reduce((s, l) => s + l.total, 0)),
            store_houses_id: storeHouseId,
            from_store_houses_id: input.type === 3 ? input.fromWarehouseId : null,
            to_store_houses_id: input.type === 3 ? input.toWarehouseId : null,
            permission_source_id: t.source,
            created_by: ctx.user.id,
            accounting_period_id: periodId,
            ...(uploaded ? { attachments: uploaded } : {}),
          },
          now,
          tx,
        );

        const lines = await this.buildLines(input, storeHouseId, tx);
        await this.permits.insertLines(id, lines, now, tx);
        await this.logCreation(ctx, id, input, tx);

        // الرصيد الافتتاحي يُعتمد في معاملة حفظه: يُحفظ معتمَداً أو لا يُحفظ
        if (input.type === 4) {
          try {
            await this.approver().approveWithin(ctx, id, tx);
          } catch (e) {
            if (e instanceof AppError) throw new AppError(e.code, `لم يُحفظ الرصيد الافتتاحي: ${e.message}`, e.status === 402 ? 402 : 422, e.details);
            throw e;
          }
        }

        return { id, number };
      });

      return {
        message: input.type === 4 ? 'تم إنشاء الرصيد الافتتاحي واعتماده وإضافة الكميات إلى المستودع' : 'تم انشاء اذن المخزن بنجاح',
        data: { id: permit.id, number: permit.number, status: input.type === 4 ? 'approved' : 'pending' },
      };
    } catch (e) {
      if (uploaded) await this.images.delete(ATTACHMENTS_FOLDER, uploaded).catch(() => undefined);
      if (e instanceof AppError) throw e;
      await this.log.failure(ctx, e, 'store');
      throw new AppError('PERMIT_STORE_FAILED', `حدث خطا ما برجاء المحاوله لاحقا: ${(e as Error).message}`, 422);
    }
  }

  /**
   * بنود الإذن ورصيد ما قبله وما بعده (`NOT NULL`). التحويل والصرف يُفحصان مبكّراً
   * — الخصم عند الاعتماد، لكنّ إذناً لا رصيد له لا يُحفظ أصلاً.
   */
  private async buildLines(input: PermitInput, storeHouseId: number | null, tx: Tx): Promise<PermitLineWrite[]> {
    const lines: PermitLineWrite[] = [];
    for (const l of input.lines) {
      const before = await this.permits.stockOf(storeHouseId, l.productId, tx);
      if ((input.type === 3 || input.type === 2) && before < l.quantity) {
        const where = input.type === 3 ? 'في المستودع المصدر' : 'في المستودع';
        throw new AppError('INSUFFICIENT_STOCK', `الكمية غير متوفّرة ${where}: المتاح ${fmt(before)} والمطلوب ${fmt(l.quantity)}.`, 422);
      }
      const direction = input.type === 2 || input.type === 3 ? -1 : 1;
      lines.push({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total, stockBefore: before, stockAfter: before + direction * l.quantity });
    }
    return lines;
  }

  /** سجلّ الإنشاء — لكل بند سطر، بالرسائل نفسها (الصرف بلا سجلّ كالويب) */
  private async logCreation(ctx: StockContext, permitId: number, input: PermitInput, tx: Tx) {
    if (input.type === 2) return;
    const names = await this.permits.productsByIds(input.lines.map((l) => l.productId));
    const warehouses = await this.stock.warehouseNames([input.warehouseId, input.fromWarehouseId, input.toWarehouseId].filter((v): v is number => v !== null));
    for (const l of input.lines) {
      const product = names.get(l.productId)?.name ?? '';
      const qty = Math.trunc(l.quantity); // `%d`
      const description =
        input.type === 3
          ? `أُنشئ إذن تحويل (بانتظار الاعتماد) كمية **${qty}** من **${warehouses.get(input.fromWarehouseId ?? 0) ?? ''}** إلى **${warehouses.get(input.toWarehouseId ?? 0) ?? ''}** من المنتج **${product}**`
          : input.type === 4
            ? `أُنشئ إذن رصيد افتتاحي (بانتظار الاعتماد) كمية **${qty}** من المنتج **${product}** إلى **${warehouses.get(input.warehouseId ?? 0) ?? ''}**`
            : `أُنشئ إذن إضافة (بانتظار الاعتماد) كمية **${qty}** من المنتج **${product}** إلى **${warehouses.get(input.warehouseId ?? 0) ?? ''}**`;
      await this.log.record(ctx, 'logged', permitId, description, tx);
    }
  }

  /** تعديل إذنٍ معلَّق — يُستبدل رأسه وبنوده، ورقمه يبقى كما صدر */
  async update(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.edit]);
    const { input, attachment } = await this.validate(body, files);

    // الويب: حالة الأصناف أولاً، ثم الإذن ونطاقه، ثم صلاحية نوعه ومستودعاته، ثم حالته
    await this.assertProducts(input.lines.map((l) => l.productId));
    const existing = await this.findPermit(ctx, id);
    const t = this.authorizeType(ctx, input.type);
    await this.assertWarehouses(ctx, input);

    if (existing.status !== PERMIT_STATUS.pending) {
      throw new AppError(
        'PERMIT_NOT_PENDING',
        existing.status === PERMIT_STATUS.approved ? 'لا يمكن تعديل إذن معتمَد — ألغِ الاعتماد أولاً.' : 'لا يمكن تعديل إذن مرفوض.',
        422,
      );
    }

    const storeHouseId = this.headerWarehouse(input);
    const now = ctx.nowSql;
    const periodId = (await this.stock.accountingPeriodFor(input.date.slice(0, 10)))?.id ?? null;
    const uploaded = attachment ? await this.images.saveDocument(ATTACHMENTS_FOLDER, attachment) : null;

    try {
      await this.uow.run(async (tx) => {
        const locked = await this.permits.find(id, tx, true);
        if (!locked || locked.status !== PERMIT_STATUS.pending) throw new AppError('PERMIT_NOT_PENDING', 'لا يمكن تعديل إذن معتمَد — ألغِ الاعتماد أولاً.', 422);

        const number = locked.number?.trim() ? locked.number : await this.numbers.next(t.numberSection, ctx.now, tx);
        await this.permits.update(
          id,
          {
            permission_type: input.type,
            permission_date: input.date,
            sub_account: null,
            number,
            details: input.details,
            grand_total: round2(input.lines.reduce((s, l) => s + l.total, 0)),
            store_houses_id: storeHouseId,
            from_store_houses_id: input.type === 3 ? input.fromWarehouseId : null,
            to_store_houses_id: input.type === 3 ? input.toWarehouseId : null,
            permission_source_id: t.source,
            // الويب يكتب المعدِّل منشئاً للإذن
            created_by: ctx.user.id,
            accounting_period_id: periodId,
            ...(uploaded ? { attachments: uploaded } : {}),
          },
          now,
          tx,
        );

        await this.permits.deleteLines(id, tx);
        const lines: PermitLineWrite[] = [];
        for (const l of input.lines) {
          const before = await this.permits.stockOf(storeHouseId, l.productId, tx);
          const direction = input.type === 1 || input.type === 4 ? 1 : -1;
          lines.push({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total, stockBefore: before, stockAfter: before + direction * l.quantity });
        }
        await this.permits.insertLines(id, lines, now, tx);
      });
    } catch (e) {
      if (uploaded) await this.images.delete(ATTACHMENTS_FOLDER, uploaded).catch(() => undefined);
      throw e;
    }

    return { message: 'تم تحديث إذن المخزن — يبقى بانتظار الاعتماد' };
  }

  /** حذف إذنٍ غير معتمد — المعتمد يُلغى اعتماده أولاً */
  async destroy(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.delete]);
    await this.findPermit(ctx, id);

    await this.uow.run(async (tx) => {
      const p = await this.permits.find(id, tx, true);
      if (!p) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
      if (p.status === PERMIT_STATUS.approved) throw new AppError('PERMIT_APPROVED', 'لا يُحذف إذنٌ معتمد — ألغِ اعتماده أولاً.', 422);
      await this.permits.deleteLines(id, tx);
      await this.permits.delete(id, tx);
    });

    return { message: 'تم حذف الإذن المخزني بنجاح' };
  }

  /** `reject()` — المعلَّق وحده، بسببٍ اختياري، وإشعارٌ لمنشئ الإذن */
  async reject(userId: number, meta: RequestMeta, id: number, reason: string | null) {
    const ctx = await this.load(userId, meta, [PERMIT_PERMISSIONS.reject]);
    await this.findPermit(ctx, id);

    try {
      const number = await this.uow.run(async (tx) => {
        const p = await this.permits.find(id, tx, true);
        if (!p) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
        if (p.status === PERMIT_STATUS.approved) throw new AppError('PERMIT_APPROVED', 'لا يمكن رفض إذن تمت الموافقة عليه بالفعل', 422);
        if (p.status !== PERMIT_STATUS.pending) {
          throw new AppError('PERMIT_NOT_PENDING', `هذا الإذن ${p.status === PERMIT_STATUS.rejected ? 'تم رفضه مسبقاً' : 'حالة غير صالحة'}`, 422);
        }

        await this.permits.setRejected(id, reason, ctx.user.id, ctx.nowSql, tx);
        await this.log.record(ctx, 'rejected', id, `تم رفض إذن المخزن رقم **${p.number ?? p.id}**`, tx);
        await this.notifications.send(
          {
            userId: p.createdBy,
            receiverId: p.createdBy,
            title: `تم رفض الإذن المخزني رقم ${p.number ?? ''}`,
            description: `تم رفض الإذن المخزني رقم ${p.number ?? ''}`,
            type: 'error',
          },
          ctx.now,
          tx,
        );
        return p.number;
      });

      return { message: `تم رفض الإذن المخزني رقم ${number ?? ''} بنجاح` };
    } catch (e) {
      if (e instanceof AppError && e.status < 500 && e.code !== 'PLAN_LIMIT_REACHED') throw e;
      await this.log.failure(ctx, e, 'reject', id);
      throw new AppError('PERMIT_REJECT_FAILED', `حدث خطأ أثناء رفض الإذن: ${(e as Error).message}`, 422);
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** الأرقام كما يطبعها PHP في الرسائل — بلا أصفار زائدة */
const fmt = (n: number) => String(Number(n.toFixed(4)));
