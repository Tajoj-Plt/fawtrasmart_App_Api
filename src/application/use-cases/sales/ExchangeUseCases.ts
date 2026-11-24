import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository, OperationLogRepository } from '../../../domain/repositories/clients';
import { ExchangeRepository, ExchangeRow, SalesRepository, SalesWriteRepository } from '../../../domain/repositories/sales';
import { StockRepository } from '../../../domain/repositories/stock';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { fmtMoney, fmtQty, round2 } from '../../../domain/services/sales/SalesMath';
import { SALES_LIMITS, SALES_PLAN } from '../../../domain/services/sales/SalesConstants';
import { ImageStore, UnitOfWork } from '../../ports';
import { LedgerAccounts } from '../../services/accounting/LedgerAccounts';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { SalesInventory, StockMove } from '../../services/sales/SalesInventory';
import { SalesJournal } from '../../services/sales/SalesJournal';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';

/** مجلّد صورة التبديل في النظام — `processAndSaveImage()`، والعمود يحمل المسار النسبيّ كاملاً */
export const EXCHANGE_IMAGE_FOLDER = 'uploads/product_exchanges';
const EXCHANGE_SOURCE_OUT = 27;
const EXCHANGE_SOURCE_IN = 28;
const EXCHANGE_REFERENCE = 'PEX';
const LOG_MODULE = 'ProductExchanges';
const PER_PAGE = [10, 25, 50, 100];
const IMAGE_MAX = 5 * 1024 * 1024;

export const EXCHANGE_PERMISSIONS = { view: 'sales.exchanges.view', create: 'sales.exchanges.create' } as const;

interface UploadedFile {
  fieldname: string;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface ExchangeListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  code?: string;
  branch?: number;
  fromDate?: string;
  toDate?: string;
}

/**
 * تبديل البضاعة — `ProductExchangeController`: يأخذ العميل بضاعةً سليمة من
 * مستودع الصرف ويُرجع التالفة إلى مستودع الاسترجاع، بالكمية والتكلفة نفسيهما.
 * كلُّ رفضٍ يُلغي المعاملة كلَّها (الويب يردّ JSON ويترك المعاملة مفتوحة)،
 * والصورة تُحذف إن لم يُحفظ التبديل.
 */
export class ExchangeUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly exchanges: ExchangeRepository,
    private readonly sales: SalesRepository,
    private readonly writes: SalesWriteRepository,
    private readonly stock: StockRepository,
    private readonly accounts: LedgerAccounts,
    private readonly journal: SalesJournal,
    private readonly inventory: SalesInventory,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly logs: OperationLogRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly images: ImageStore,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.exchanges], permissions: [permission] });
  }

  /** مستودعات الموظف المعيَّنة له («المستودعات الافتراضية») — `null` لمن لا قيد عليه */
  private async allowedWarehouses(ctx: SalesContext): Promise<number[] | null> {
    if (!ctx.user.employeeId) return null;
    const own = await this.stock.defaultWarehouseIds([ctx.user.employeeId]);
    return own.length ? own : null;
  }

  async reasons(userId: number, meta: RequestMeta) {
    await this.load(userId, meta, EXCHANGE_PERMISSIONS.view);
    return this.exchanges.reasons();
  }

  async createData(userId: number, meta: RequestMeta) {
    const ctx = await this.load(userId, meta, EXCHANGE_PERMISSIONS.create);
    const allowed = await this.allowedWarehouses(ctx);
    const ids = allowed ?? (await this.sales.allWarehouseIds());
    const names = await this.stock.warehouseNames(ids);
    const employee = ctx.user.employeeId ? await this.exchanges.employeeLimit(ctx.user.employeeId) : null;
    const used = ctx.user.employeeId ? await this.exchanges.dayQuantity('employee_id', ctx.user.employeeId, ctx.today) : 0;
    return {
      warehouses: ids.map((id) => ({ id, name: names.get(id) ?? '' })),
      reasons: await this.exchanges.reasons(),
      employeeDailyLimit: employee?.limit ?? null,
      employeeUsedToday: used,
      periodBlock: await this.periodGuard.block(ctx.today, ctx.today, (p) => ctx.can(p)),
      nextNumber: await this.numbers.peek('product-exchange', ctx.now),
    };
  }

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.load(userId, meta, EXCHANGE_PERMISSIONS.create);
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const clientId = form.integer('clientId', { required: true, min: 1, message: 'يجب اختيار العميل' });
    const outId = form.integer('storehouseId', { required: true, min: 1, message: 'يجب اختيار مستودع التبديل' });
    const inId = form.integer('returnStorehouseId', { required: true, min: 1, message: 'يجب اختيار مستودع الاسترجاع' });
    if (outId !== null && inId !== null && outId === inId) errors.add('returnStorehouseId', 'مستودع الاسترجاع يجب أن يكون مختلفاً عن مستودع التبديل');
    const dateText = form.string('exchangeDate');
    let exchangeDate = ctx.today;
    if (dateText !== null) {
      const d = parseInputDate(dateText);
      if (!d) errors.add('exchangeDate', 'التاريخ بصيغة YYYY-MM-DD.');
      else exchangeDate = toSqlDate(d);
    }
    const requestedEmployee = form.integer('employeeId', { min: 1 });
    const notes = form.string('notes', { max: 5000 });

    const image = files.find((f) => f.fieldname === 'image') ?? null;
    if (!image) errors.add('image', 'يجب تحميل صورة للتبديل');
    else if (!/^image\/(jpeg|png|jpg|gif|webp)$/.test(image.mimetype)) errors.add('image', 'صيغة الصورة غير مدعومة (jpeg, png, jpg, gif, webp)');
    else if (image.size > IMAGE_MAX) errors.add('image', 'حجم الصورة يجب أن لا يتجاوز 5 ميجا بايت');

    // `items` مصفوفة، أو نصّ JSON حين يصل الطلب متعدّد الأجزاء مع الصورة
    let rawItems = body.items;
    if (typeof rawItems === 'string') {
      try {
        rawItems = JSON.parse(rawItems);
      } catch {
        rawItems = undefined;
      }
    }
    const list = new FormInput({ items: rawItems }, errors).array('items', { required: true, min: 1, max: 100, message: 'يجب إضافة منتج واحد على الأقل' }) ?? [];
    const reasonIds = await this.exchanges.reasonIds();
    const raw: Array<{ productId: number; unitId: number | null; quantity: number; reasonId: number; reasonNotes: string | null }> = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const productId = item.integer('productId', { required: true, min: 1, message: 'يجب اختيار المنتج' });
      const quantity = item.number('quantity', { required: true, message: 'يجب تحديد الكمية' });
      const unitId = item.integer('unitId', { min: 1 });
      const reasonId = item.integer('reasonId', { required: true, min: 1, message: 'يجب اختيار سبب التبديل' });
      const reasonNotes = item.string('reasonNotes', { max: 1000 });
      if (quantity !== null && quantity <= 0) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      if (reasonId !== null && !reasonIds.has(reasonId)) errors.add(`items.${i}.reasonId`, 'سبب التبديل غير موجود أو موقوف.');
      if (productId !== null && quantity !== null && quantity > 0 && reasonId !== null) raw.push({ productId, unitId, quantity, reasonId, reasonNotes });
    });
    errors.throwIfAny();

    const client = await this.sales.client(clientId as number);
    if (!client) throw AppError.validation({ clientId: ['العميل المحدَّد غير موجود.'] }, 'العميل المحدَّد غير موجود.');
    await ctx.assertClient(client.id);

    // المستودعان — موجودان، ومن مستودعات الموظف إن عُيِّنت له (الويب يستبدلهما بصمت)
    const out = await this.stock.warehouse(outId as number);
    const into = await this.stock.warehouse(inId as number);
    if (!out) throw AppError.validation({ storehouseId: ['مستودع التبديل غير موجود.'] }, 'مستودع التبديل غير موجود.');
    if (!into) throw AppError.validation({ returnStorehouseId: ['مستودع الاسترجاع غير موجود.'] }, 'مستودع الاسترجاع غير موجود.');
    const allowed = await this.allowedWarehouses(ctx);
    for (const [w, field] of [[out, 'storehouseId'], [into, 'returnStorehouseId']] as const) {
      if (allowed && !allowed.includes(w.id)) throw new AppError('WAREHOUSE_FORBIDDEN', `مستودع «${w.name || w.id}» ليس من مستودعاتك المعيَّنة — اختر من مستودعاتك.`, 403, { field });
    }

    // الأصناف: مخزَّنةٌ فقط، والكمية بالوحدة الأساسية عدداً صحيحاً
    const products = await this.sales.products(raw.map((r) => r.productId));
    const units = await this.sales.unitsFor([...products.values()]);
    const lines = raw.map((r, i) => {
      const p = products.get(r.productId);
      if (!p) throw AppError.validation({ [`items.${i}.productId`]: ['المنتج غير موجود.'] }, 'المنتج غير موجود.');
      if (p.type !== 'products' && !(p.type === 'compiled' && p.compileType !== 'Instant')) {
        throw AppError.validation({ [`items.${i}.productId`]: [`الصنف «${p.name}» لا رصيد له في المستودع (خدمي أو رقمي أو مجمَّع فوري) — لا يُبدَّل.`] }, `الصنف «${p.name}» لا رصيد له في المستودع — لا يُبدَّل.`);
      }
      let factor = 1;
      if (r.unitId !== null) {
        const unit = (units.get(p.id) ?? []).find((u) => u.id === r.unitId);
        if (!unit) throw AppError.validation({ [`items.${i}.unitId`]: ['الوحدة المختارة ليست من وحدات هذا الصنف.'] }, 'الوحدة المختارة ليست من وحدات هذا الصنف.');
        factor = unit.conversionFactor || 1;
      }
      const base = r.quantity * factor;
      if (Math.abs(base - Math.round(base)) > 1e-9) throw AppError.validation({ [`items.${i}.quantity`]: [`كمية «${p.name}» بالوحدة الأساسية (${fmtQty(base)}) يجب أن تكون عدداً صحيحاً.`] }, `كمية «${p.name}» بالوحدة الأساسية يجب أن تكون عدداً صحيحاً.`);
      return { product: p, base: Math.round(base), reasonId: r.reasonId, reasonNotes: r.reasonNotes };
    });
    const requestQty = lines.reduce((s, l) => s + l.base, 0);

    const employeeId = (await ctx.clampEmployee(requestedEmployee)) ?? ctx.user.employeeId ?? null;
    const assertLimits = async () => {
      if (employeeId) {
        const e = await this.exchanges.employeeLimit(employeeId);
        if (e && e.limit !== null) {
          const used = await this.exchanges.dayQuantity('employee_id', employeeId, exchangeDate);
          if (used + requestQty > e.limit) throw new AppError('EXCHANGE_LIMIT', `عذراً، الموظف (${e.name}) تجاوز الحد اليومي المسموح له في تاريخ ${exchangeDate}. الحد: ${e.limit}، المتبقي: ${Math.max(0, e.limit - used)}`, 422);
        }
      }
      const limit = (await this.exchanges.clientLimit(client.id)) ?? (await this.exchanges.globalClientLimit());
      if (limit !== null) {
        const used = await this.exchanges.dayQuantity('client_id', client.id, exchangeDate);
        if (used + requestQty > limit) throw new AppError('EXCHANGE_LIMIT', `عذراً، العميل (${client.tradeName ?? ''}) تجاوز الحد اليومي المسموح له بالتبديل في تاريخ ${exchangeDate}. الحد: ${limit}، المتبقي: ${Math.max(0, limit - used)}`, 422);
      }
    };
    await assertLimits();

    const block = await this.periodGuard.block(exchangeDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `الفترة المحاسبية لهذا التاريخ لا تقبل قيداً: ${block}`, 422);
    await this.planLimits.assert(SALES_LIMITS.exchanges, ctx.now);

    const averages = await this.stock.averageCosts(lines.map((l) => l.product.id), null);
    const priced = lines.map((l) => {
      const price = round2(averages.get(l.product.id) ?? 0);
      return { ...l, price, total: round2(price * l.base) };
    });
    const total = round2(priced.reduce((s, l) => s + l.total, 0));

    const uploaded = await this.images.saveAsIs(EXCHANGE_IMAGE_FOLDER, image as UploadedFile);
    try {
      const result = await this.uow.run(async (tx) => {
        await this.planLimits.assert(SALES_LIMITS.exchanges, ctx.now);
        await this.planLimits.assert('warehouse_permits', ctx.now, 2);
        await this.writes.lockStock(priced.flatMap((l) => [[l.product.id, out.id], [l.product.id, into.id]] as Array<[number, number]>), tx);
        await assertLimits();

        const now = ctx.nowSql;
        const currency = (await this.reference.defaultCurrency())?.code ?? 'SAR';
        const code = await this.numbers.next('product-exchange', ctx.now, tx);
        const exchangeId = await this.exchanges.insert(
          {
            code,
            client_id: client.id,
            branch_id: ctx.user.branchId ?? null,
            employee_id: employeeId,
            storehouse_id: out.id,
            return_storehouse_id: into.id,
            created_by: ctx.user.id,
            exchange_date: exchangeDate,
            notes,
            image: `${EXCHANGE_IMAGE_FOLDER}/${uploaded}`,
            total_value: total,
            status: 1,
          },
          now,
          tx,
        );

        const moves = (warehouseId: number): StockMove[] => priced.map((l) => ({ productId: l.product.id, name: l.product.name, warehouseId, baseQuantity: l.base, unitPrice: l.price, total: l.total }));
        const [outPermit] = await this.inventory.unstock(
          ctx,
          { source: EXCHANGE_SOURCE_OUT, number: `${code}-OUT`, date: exchangeDate, clientId: client.id, referenceType: 'تبديل منتج', referenceId: exchangeId, currency, permissionType: 2, details: `إذن صرف مخزني - تبديل بضاعة رقم ${code}` },
          moves(out.id),
          now,
          tx,
          (m, available) => `المتاح من «${m.name}» في مستودع الصرف هو ${fmtQty(available)} فقط.`,
        );
        const [inPermit] = await this.inventory.restock(
          ctx,
          { source: EXCHANGE_SOURCE_IN, number: `${code}-IN`, date: exchangeDate, clientId: client.id, referenceType: 'إرجاع تبديل', referenceId: exchangeId, currency, permissionType: 1, details: `إذن إضافة مخزني - تبديل بضاعة رقم ${code}` },
          moves(into.id),
          now,
          tx,
        );
        for (const l of priced) {
          await this.exchanges.insertItem({ product_exchange_id: exchangeId, product_id: l.product.id, quantity: l.base, unit_price: l.price, total: l.total, reason_id: l.reasonId, reason_notes: l.reasonNotes }, now, tx);
        }
        await this.exchanges.update(exchangeId, { outgoing_permit_id: outPermit ?? null, incoming_permit_id: inPermit ?? null }, now, tx);

        // قيدا التبديل: خروجُ السليم بتكلفته، ودخولُ المُرجَع بها — صافيهما نقلٌ بين حسابَي المستودعين
        if (total > 0) {
          const owner = await this.journal.owner(ctx);
          const cost = await this.accounts.require('cost_of_sales', null, tx);
          const outAccount = await this.accounts.warehouse(out.id, out.name ?? null, now, tx);
          const inAccount = await this.accounts.warehouse(into.id, into.name ?? null, now, tx);
          const header = { referenceType: EXCHANGE_REFERENCE, clientId: client.id, invoiceId: null, currency, date: exchangeDate };
          await this.journal.post(
            ctx,
            { ...header, reference: `${code}-OUT`, description: `قيد خروج بضاعة تبديل - رقم ${code} - من ${out.name ?? ''}` },
            [
              { accountId: cost.id, description: `تكلفة بضاعة مبدلة (خروج) - رقم ${code}`, debit: total, credit: 0 },
              { accountId: outAccount.id, description: `تخفيض مخزون مستودع ${out.name ?? ''} - تبديل رقم ${code}`, debit: 0, credit: total },
            ],
            owner,
            now,
            tx,
          );
          await this.journal.post(
            ctx,
            { ...header, reference: `${code}-IN`, description: `قيد ورود بضاعة مرجعة - رقم ${code} - إلى ${into.name ?? ''}` },
            [
              { accountId: inAccount.id, description: `إضافة مخزون (مرتجع تبديل) لمستودع ${into.name ?? ''} - رقم ${code}`, debit: total, credit: 0 },
              { accountId: cost.id, description: `عكس تكلفة بضاعة مرجعة - رقم ${code}`, debit: 0, credit: total },
            ],
            owner,
            now,
            tx,
          );
        }

        await this.logs.record(
          { action: 'created', module: LOG_MODULE, subjectId: exchangeId, description: `إنشاء تبديل ${code} للعميل ${client.tradeName ?? '—'} بقيمة ${fmtMoney(total)} ${currency}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route },
          tx,
        );
        return { id: exchangeId, code };
      });
      return { message: `سُجّلت عملية التبديل رقم ${result.code}.`, data: await this.detail(ctx, result.id) };
    } catch (e) {
      await this.images.delete(EXCHANGE_IMAGE_FOLDER, uploaded).catch(() => undefined);
      throw e;
    }
  }

  // ═══════════════════════ القراءة ═══════════════════════

  private async find(ctx: SalesContext, id: number): Promise<ExchangeRow> {
    const row = await this.exchanges.find(id);
    if (!row) throw AppError.notFound('EXCHANGE_NOT_FOUND', 'عملية التبديل غير موجودة.');
    if (!(await ctx.canAccessDocument(row.createdBy, row.employeeId, row.branchId))) throw AppError.forbidden('EXCHANGE_FORBIDDEN', 'ليس لديك صلاحية لعرض عملية التبديل هذه.');
    return row;
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, EXCHANGE_PERMISSIONS.view);
    return this.detail(ctx, id);
  }

  private async detail(ctx: SalesContext, id: number) {
    const row = await this.find(ctx, id);
    return { ...this.summary(row), notes: row.notes, items: await this.exchanges.items(row.id) };
  }

  private summary(x: ExchangeRow) {
    return {
      id: x.id,
      code: x.code,
      client: x.clientId ? { id: x.clientId, tradeName: x.clientName } : null,
      employee: x.employeeId ? { id: x.employeeId, name: x.employeeName } : null,
      createdBy: x.createdBy ? { id: x.createdBy, name: x.createdByName } : null,
      storehouse: x.storehouseId ? { id: x.storehouseId, name: x.storehouseName } : null,
      returnStorehouse: x.returnStorehouseId ? { id: x.returnStorehouseId, name: x.returnStorehouseName } : null,
      exchangeDate: x.exchangeDate,
      totalValue: x.totalValue,
      image: this.images.publicUrl(x.image),
      status: x.status,
      createdAt: x.createdAt,
    };
  }

  async list(userId: number, meta: RequestMeta, q: ExchangeListQuery) {
    const ctx = await this.load(userId, meta, EXCHANGE_PERMISSIONS.view);
    const perPage = PER_PAGE.includes(q.perPage ?? 25) ? q.perPage ?? 25 : 25;
    const page = q.page ?? 1;
    const { rows, total } = await this.exchanges.page(
      { scope: await ctx.documentScope(), headerBranchIds: await ctx.headerBranchIds(), clientId: q.clientId, code: q.code?.trim() || undefined, branch: q.branch, fromDate: q.fromDate, toDate: q.toDate },
      page,
      perPage,
    );
    return { items: rows.map((r) => this.summary(r)), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }
}
