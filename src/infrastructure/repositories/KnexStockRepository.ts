import { Knex } from 'knex';
import { Paginated } from '../../domain/entities/accounting';
import { AdjustmentRow, PermitRow, ProductRow, StockListQuery, StockOverviewFigures, StockScope, WarehouseRow } from '../../domain/entities/stock';
import { StockListResult, StockCatalogRepository } from '../../domain/repositories/stockCatalog';

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function paginate<T>(rows: T[], total: number, page: number, perPage: number): Paginated<T> {
  return { items: rows, total, page, perPage };
}

/** يقيَّد استعلامٌ بقائمة معرّفات؛ `null` = بلا قيد، `[]` تصير `[0]` كي لا تعني «بلا قيد» خطأً */
function whereInMaybe(qb: Knex.QueryBuilder, column: string, ids: number[] | null): Knex.QueryBuilder {
  if (ids === null) return qb;
  return qb.whereIn(column, ids.length ? ids : [0]);
}

export class KnexStockCatalogRepository implements StockCatalogRepository {
  constructor(private readonly db: Knex) {}

  async warehouseIdsFor(branchIds: number[] | null, employeeIds: number[] | null): Promise<number[]> {
    const qb = this.db('store_houses').select('id');
    whereInMaybe(qb, 'store_houses.branch_id', branchIds);
    if (employeeIds !== null) {
      qb.whereExists((sub) =>
        sub.select(1).from('default_warehouses').whereRaw('default_warehouses.storehouse_id = store_houses.id').whereIn('default_warehouses.employee_id', employeeIds.length ? employeeIds : [0]),
      );
    }
    const rows = await qb;
    return rows.map((r: { id: unknown }) => num(r.id));
  }

  async products(warehouseIds: number[] | null, q: StockListQuery): Promise<StockListResult<ProductRow>> {
    const quantitySub = this.db('product_details').sum({ total: 'quantity' }).whereRaw('product_details.product_id = products.id');
    if (warehouseIds !== null) quantitySub.whereIn('product_details.store_house_id', warehouseIds.length ? warehouseIds : [0]);

    const base = () => {
      const qb = this.db('products').leftJoin('categories', 'categories.id', 'products.category_id');
      if (q.search) qb.where((w) => w.where('products.name', 'like', `%${q.search}%`).orWhere('products.barcode', 'like', `%${q.search}%`));
      if (q.status) qb.where('products.status', q.status);
      return qb;
    };

    const total = num((await base().count({ n: 'products.id' }).first())?.n);
    const rows = await base()
      .select('products.id', 'products.name', 'products.barcode', 'categories.name as category_name', 'products.status', 'products.type', 'products.sale_price', 'products.low_stock_thershold', quantitySub.as('quantity'))
      .orderBy('products.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        name: String(r.name ?? ''),
        barcode: str(r.barcode),
        categoryName: str(r.category_name),
        status: String(r.status ?? 'active'),
        type: String(r.type ?? 'products'),
        salePrice: r.sale_price === null || r.sale_price === undefined ? null : num(r.sale_price),
        lowStockThreshold: num(r.low_stock_thershold),
        quantity: r.type === 'services' ? null : r.quantity === null || r.quantity === undefined ? 0 : num(r.quantity),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async warehouses(warehouseIds: number[] | null, q: StockListQuery): Promise<StockListResult<WarehouseRow>> {
    const base = () => {
      const qb = whereInMaybe(this.db('store_houses'), 'store_houses.id', warehouseIds);
      if (q.search) qb.where('store_houses.name', 'like', `%${q.search}%`);
      if (q.status) qb.where('store_houses.status', q.status);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select('id', 'name', 'status', 'major', 'branch_id')
      .orderBy('major', 'desc')
      .orderBy('name', 'asc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({ id: num(r.id), name: String(r.name ?? ''), status: String(r.status ?? 'active'), isMain: num(r.major) === 1, branchId: r.branch_id === null || r.branch_id === undefined ? null : num(r.branch_id) })),
      total,
      q.page,
      q.perPage,
    );
  }

  /** أذون الصرف والإضافة: منشئٌ ∩ (فرعٌ يطابق المستودع أو المصدر أو الوجهة) */
  private permitsBase(scope: StockScope): Knex.QueryBuilder {
    let qb = this.db('warehouse_permits');
    qb = whereInMaybe(qb, 'warehouse_permits.created_by', scope.creatorIds);
    if (scope.warehouseIds !== null) {
      const ids = scope.warehouseIds.length ? scope.warehouseIds : [0];
      qb = qb.where((w) => w.whereIn('warehouse_permits.store_houses_id', ids).orWhereIn('warehouse_permits.from_store_houses_id', ids).orWhereIn('warehouse_permits.to_store_houses_id', ids));
    }
    return qb;
  }

  async permits(scope: StockScope, q: StockListQuery): Promise<StockListResult<PermitRow>> {
    const base = () => {
      let qb = this.permitsBase(scope);
      if (q.status) qb = qb.where('warehouse_permits.status', q.status);
      if (q.search) qb = qb.where('warehouse_permits.number', 'like', `%${q.search}%`);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .leftJoin('store_houses as sh', 'sh.id', 'warehouse_permits.store_houses_id')
      .leftJoin('store_houses as fsh', 'fsh.id', 'warehouse_permits.from_store_houses_id')
      .leftJoin('store_houses as tsh', 'tsh.id', 'warehouse_permits.to_store_houses_id')
      .select(
        'warehouse_permits.id',
        'warehouse_permits.number',
        'warehouse_permits.permission_type',
        'warehouse_permits.permission_date',
        'warehouse_permits.status',
        'warehouse_permits.grand_total',
        'sh.name as store_house_name',
        'fsh.name as from_store_house_name',
        'tsh.name as to_store_house_name',
      )
      .orderBy('warehouse_permits.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        number: str(r.number),
        permissionType: r.permission_type === null || r.permission_type === undefined ? null : num(r.permission_type),
        permissionDate: r.permission_date ? String(r.permission_date).slice(0, 10) : null,
        status: String(r.status ?? 'pending'),
        storeHouseName: str(r.store_house_name),
        fromStoreHouseName: str(r.from_store_house_name),
        toStoreHouseName: str(r.to_store_house_name),
        grandTotal: r.grand_total === null || r.grand_total === undefined ? null : num(r.grand_total),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async adjustments(scope: StockScope, q: StockListQuery): Promise<StockListResult<AdjustmentRow>> {
    const base = () => {
      let qb = this.db('inventory_adjustments');
      qb = whereInMaybe(qb, 'inventory_adjustments.created_by', scope.creatorIds);
      qb = whereInMaybe(qb, 'inventory_adjustments.stock_id', scope.warehouseIds);
      if (q.status) qb = qb.where('inventory_adjustments.status', q.status);
      if (q.search) qb = qb.where('inventory_adjustments.reference_number', 'like', `%${q.search}%`);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .leftJoin('store_houses', 'store_houses.id', 'inventory_adjustments.stock_id')
      .select('inventory_adjustments.id', 'inventory_adjustments.reference_number', 'inventory_adjustments.inventory_time', 'inventory_adjustments.status', 'inventory_adjustments.type', 'inventory_adjustments.note', 'store_houses.name as store_house_name')
      .orderBy('inventory_adjustments.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        referenceNumber: str(r.reference_number),
        inventoryTime: r.inventory_time ? String(r.inventory_time).slice(0, 10) : null,
        status: String(r.status ?? 'draft'),
        type: String(r.type ?? 'full'),
        storeHouseName: str(r.store_house_name),
        note: str(r.note),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async overview(scope: StockScope, want: { products: boolean; warehouses: boolean; permits: boolean; adjustments: boolean }): Promise<StockOverviewFigures> {
    const [productsTotal, warehousesTotal, permitsPending, adjustmentsOpen] = await Promise.all([
      want.products ? num((await this.db('products').count({ n: '*' }).first())?.n) : Promise.resolve(null),
      want.warehouses ? num((await whereInMaybe(this.db('store_houses'), 'id', scope.warehouseIds).count({ n: '*' }).first())?.n) : Promise.resolve(null),
      want.permits ? num((await this.permitsBase(scope).where('warehouse_permits.status', 'pending').count({ n: '*' }).first())?.n) : Promise.resolve(null),
      want.adjustments
        ? num(
            (
              await whereInMaybe(whereInMaybe(this.db('inventory_adjustments'), 'created_by', scope.creatorIds), 'stock_id', scope.warehouseIds)
                .whereIn('status', ['draft', 'in_progress'])
                .count({ n: '*' })
                .first()
            )?.n,
          )
        : Promise.resolve(null),
    ]);

    return { productsTotal, warehousesTotal, permitsPending, adjustmentsOpen };
  }
}
