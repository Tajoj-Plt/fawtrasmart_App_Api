import { AppError } from '../../../domain/errors/AppError';
import { PriceListRepository, PriceListRow } from '../../../domain/repositories/stock';
import { STOCK_PLAN } from '../../../domain/services/stock/StockConstants';
import { UnitOfWork } from '../../ports';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { StockContext, StockContextFactory } from '../../services/stock/StockContext';

export const PRICE_LIST_PERMISSIONS = {
  view: 'stock.price_lists.view',
  show: 'stock.price_lists.show',
  create: 'stock.price_lists.create',
  edit: 'stock.price_lists.edit',
  delete: 'stock.price_lists.delete',
  manageProducts: 'stock.price_lists.manage_products',
} as const;

const PER_PAGE = 10;
const MAX_PRICE = 99_999_999.99; // decimal(10,2)

export interface PriceListQuery {
  page?: number;
  keywords?: string;
  product?: number;
  category?: number;
  brand?: number;
  status?: number;
}

/**
 * قوائم الأسعار — `PriceListController` في الويب: البحث بفلاتره، والعرض بأصنافه
 * والأصناف المتاحة للإضافة (بنطاق رؤية المستخدم)، والإنشاء بحدّ الباقة، والتعديل،
 * والحذف، وإضافة صنفٍ بسعره وإزالته. والحالة 0 «نشط» و1 «موقوف».
 */
export class PriceListUseCases {
  constructor(
    private readonly contexts: StockContextFactory,
    private readonly lists: PriceListRepository,
    private readonly planLimits: PlanLimitGuard,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.priceLists], permissions: [permission] });
  }

  private payload(ctx: StockContext, l: PriceListRow) {
    return {
      id: l.id,
      name: l.name,
      status: l.status,
      createdAt: l.createdAt,
      canEdit: ctx.can(PRICE_LIST_PERMISSIONS.edit),
      canDelete: ctx.can(PRICE_LIST_PERMISSIONS.delete),
      canManageProducts: ctx.can(PRICE_LIST_PERMISSIONS.manageProducts),
    };
  }

  private async find(id: number) {
    const list = await this.lists.find(id);
    if (!list) throw AppError.notFound('PRICE_LIST_NOT_FOUND', 'قائمة الأسعار غير موجودة.');
    return list;
  }

  /** `scopeToProductVisibility()` — الموظف لا يُسعّر صنفاً لا يراه في مستودعاته */
  private async visibility(ctx: StockContext) {
    const warehouseIds = await ctx.accessibleWarehouseIds();
    return { warehouseIds, creatorIds: warehouseIds !== null && warehouseIds.length === 0 ? await ctx.accessibleUserIds() : null };
  }

  async list(userId: number, meta: RequestMeta, q: PriceListQuery) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.view);
    const page = q.page ?? 1;
    const { rows, total } = await this.lists.page(q, page, PER_PAGE);
    return { items: rows.map((l) => this.payload(ctx, l)), total, page, perPage: PER_PAGE, lastPage: Math.max(1, Math.ceil(total / PER_PAGE)) };
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.show);
    const list = await this.find(id);
    const [items, available] = await Promise.all([
      this.lists.items(list.id),
      ctx.can(PRICE_LIST_PERMISSIONS.manageProducts) ? this.visibility(ctx).then((scope) => this.lists.visibleProducts(scope)) : Promise.resolve([]),
    ]);
    return { ...this.payload(ctx, list), items, availableProducts: available };
  }

  /** `name` مطلوب (255 حرفاً)، والحالة 0 أو 1 — غيابها يُبقي الافتراضي أو القائم */
  private validate(body: Record<string, unknown>) {
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const name = form.string('name', { required: true, max: 255, message: 'اسم قائمة الأسعار مطلوب.' });
    const status = form.integer('status', { in: [0, 1], message: 'الحالة 0 (نشط) أو 1 (موقوف).' });
    errors.throwIfAny();
    return { name: name!, status };
  }

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.create);
    // `plan.limit:price_lists` — سقفٌ متزامن: كل القوائم القائمة
    await this.planLimits.assert('price_lists', ctx.now);
    const input = this.validate(body);

    const id = await this.uow.run(async (tx) => {
      await this.planLimits.assert('price_lists', ctx.now);
      const newId = await this.lists.insert({ name: input.name, status: input.status ?? 0 }, ctx.nowSql, tx);
      await this.lists.log('price_list', newId, `تم  اضافة قائمة اسعار :  **${input.name}**`, ctx.user.id, ctx.nowSql, tx);
      return newId;
    });

    return { message: 'تم اضافه قائمه الاسعار بنجاج !!', data: this.payload(ctx, (await this.lists.find(id))!) };
  }

  async update(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.edit);
    const input = this.validate(body);
    const list = await this.find(id);

    await this.uow.run(async (tx) => {
      await this.lists.update(list.id, { name: input.name, status: input.status ?? list.status }, ctx.nowSql, tx);
      await this.lists.log('price_list', list.id, `تم تعديل قائمة الأسعار من **${list.name}** إلى **${input.name}**`, ctx.user.id, ctx.nowSql, tx);
    });

    return { message: 'تم تعديل قائمة الأسعار بنجاح' };
  }

  async destroy(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.delete);
    const list = await this.find(id);

    await this.uow.run(async (tx) => {
      // نوع السجلّ `product_log` كما يكتبه الويب
      await this.lists.log('product_log', list.id, `تم  حذف قائمة اسعار :  **${list.name}**`, ctx.user.id, ctx.nowSql, tx);
      await this.lists.delete(list.id, tx);
    });

    return { message: 'تم حذف قائمة الأسعار بنجاح' };
  }

  /**
   * إضافة صنفٍ بسعره — الويب يكتب السعر على `products.sale_price` نفسه، فالسعر
   * مطلوب (غيابه كان يمحو سعر الصنف)، والصنف من نطاق رؤية المستخدم.
   */
  async addProduct(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, PRICE_LIST_PERMISSIONS.manageProducts);
    const list = await this.find(id);

    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const productId = form.integer('productId', { required: true, min: 1, message: 'اختر الصنف.' });
    const salePrice = form.number('salePrice', { required: true, message: 'سعر البيع مطلوب.' });
    if (salePrice !== null && salePrice < 0) errors.add('salePrice', 'سعر البيع لا يكون سالباً.');
    else if (salePrice !== null && salePrice > MAX_PRICE) errors.add('salePrice', 'سعر البيع أكبر من المسموح.');
    if (productId !== null && !(await this.lists.productExists(productId))) errors.add('productId', 'الصنف المختار غير موجود.');
    errors.throwIfAny();

    const visible = await this.lists.visibleProducts(await this.visibility(ctx), productId!);
    if (!visible.length) throw AppError.forbidden('PRODUCT_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا الصنف.');

    const itemId = await this.uow.run(async (tx) => {
      const newId = await this.lists.addItem(list.id, productId!, ctx.nowSql, tx);
      await this.lists.setProductSalePrice(productId!, salePrice!, ctx.nowSql, tx);
      return newId;
    });

    return { message: 'تم اضافه المنتج الي قائمه الاسعار بنجاج !!', data: { itemId, productId: productId!, salePrice: salePrice! } };
  }

  /** `itemId` سطر الربط من تفاصيل القائمة — لا الصنف */
  async removeProduct(userId: number, meta: RequestMeta, itemId: number) {
    await this.load(userId, meta, PRICE_LIST_PERMISSIONS.manageProducts);
    if (!(await this.lists.itemExists(itemId))) throw AppError.notFound('PRICE_LIST_ITEM_NOT_FOUND', 'لم يُعثر على السلعة في هذه القائمة.');
    await this.uow.run((tx) => this.lists.deleteItem(itemId, tx));
    return { message: 'حُذفت السلعة من قائمة الأسعار.' };
  }
}
