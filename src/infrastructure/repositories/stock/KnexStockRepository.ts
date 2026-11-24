import { Knex } from 'knex';
import { NamedOption } from '../../../domain/repositories/clients';
import {
  PermitLineMovement,
  StatementFilters,
  StatementMovementRow,
  StockProductRow,
  StockRepository,
  WarehouseListMeta,
  WarehouseRow,
} from '../../../domain/repositories/stock';
import { COST_EXCLUDED_SOURCES, PermissionSources, STOCKED_PRODUCT_TYPES } from '../../../domain/services/stock/StockConstants';
import { bool } from '../../db/knex';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `COST_LINE_VALUE_SUM` — قيمة السطر المتناقض تُقرأ من إجماليه */
const COST_LINE_VALUE_SUM =
  'SUM(CASE WHEN wpp.total > 0 AND wpp.total < wpp.quantity * wpp.unit_price THEN wpp.total ELSE wpp.quantity * wpp.unit_price END)';

const APPROVED_STATES = ['approved', 'apporod', 'delivered', 'done'];

function mapWarehouse(r: Record<string, unknown>): WarehouseRow {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    status: (r.status as string | number | null) ?? null,
    shippingAddress: str(r.shipping_address),
    branchId: num(r.branch_id),
    branchName: str(r.branch_name),
    major: bool(r.major),
    view: [num(r.view_permissions), str(r.value_of_view_permissions)],
    createInvoices: [num(r.crate_invoices_permissions), str(r.value_of_crate_invoices_permissions)],
    editStock: [num(r.edit_stock_permissions), str(r.value_of_edit_stock_permissions)],
  };
}

/** المخزون — قراءات شاشات المستودعات والكشف المخزني بجداول الويب */
export class KnexStockRepository implements StockRepository {
  constructor(private readonly db: Knex) {}

  // ═══════════════════════ النطاق ═══════════════════════

  async warehouseIdsInBranches(branchIds: number[]) {
    if (!branchIds.length) return [];
    return [...new Set((await this.db('store_houses').whereIn('branch_id', branchIds).pluck('id')).map(Number))];
  }

  async defaultWarehouseIds(employeeIds: number[]) {
    if (!employeeIds.length) return [];
    return [...new Set((await this.db('default_warehouses').whereIn('employee_id', employeeIds).pluck('storehouse_id')).map(Number))];
  }

  async anyViewRestricted() {
    const r = await this.db('store_houses')
      .whereNotNull('view_permissions')
      .where('view_permissions', '!=', 0)
      .whereNotNull('value_of_view_permissions')
      .where('value_of_view_permissions', '!=', '')
      .first('id');
    return Boolean(r);
  }

  async audienceWarehouseIds([type, value]: [string, string], a: { employeeIds: number[]; roleId: number; branchIds: number[] }) {
    const ids = await this.db('store_houses')
      .where((q) =>
        q
          .whereNull(type)
          .orWhere(type, 0)
          .orWhereNull(value)
          .orWhere(value, '')
          .orWhere((s) => s.where(type, 1).whereIn(value, a.employeeIds.length ? a.employeeIds : [0]))
          .orWhere((s) => s.where(type, 2).where(value, a.roleId))
          .orWhere((s) => s.where(type, 3).whereIn(value, a.branchIds.length ? a.branchIds : [0])),
      )
      .pluck('id');
    return ids.map(Number);
  }

  async employeeBranchId(employeeId: number) {
    const r = await this.db('employees').where('id', employeeId).first('branch_id');
    return r ? num(r.branch_id) : null;
  }

  // ═══════════════════════ المستودعات ═══════════════════════

  private warehouses() {
    return this.db('store_houses as s').leftJoin('branches as b', 'b.id', 's.branch_id').select('s.*', 'b.name as branch_name');
  }

  async warehousePage(ids: number[] | null, f: { keywords?: string; status?: string }, page: number, perPage: number) {
    const where = (q: Knex.QueryBuilder) => {
      if (ids !== null) q.whereIn('s.id', ids.length ? ids : [0]);
      if (f.keywords) q.where((w) => w.where('s.name', 'like', likeTerm(f.keywords!)).orWhere('s.shipping_address', 'like', likeTerm(f.keywords!)));
      if (f.status !== undefined && f.status !== '') q.where('s.status', f.status);
      return q;
    };
    const countRow = await where(this.db('store_houses as s')).count<{ c: number }[]>({ c: 's.id' }).first();
    const total = Number((countRow as { c?: number } | undefined)?.c ?? 0);
    const rows = total ? await where(this.warehouses()).orderBy('s.id', 'desc').limit(perPage).offset((page - 1) * perPage) : [];
    return { rows: rows.map(mapWarehouse), total };
  }

  async warehouse(id: number) {
    const r = await this.warehouses().where('s.id', id).first();
    return r ? mapWarehouse(r) : null;
  }

  async warehouseOptions(ids: number[] | null, activeOnly = false, order: 'name' | 'id' = 'name'): Promise<NamedOption[]> {
    const q = this.db('store_houses').select('id', 'name').orderBy(order);
    if (ids !== null) q.whereIn('id', ids.length ? ids : [0]);
    if (activeOnly) q.where('status', 'active');
    return (await q).map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async warehouseNames(ids: number[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<number, string>();
    const rows = await this.db('store_houses').whereIn('id', unique).select('id', 'name');
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name ?? '')]));
  }

  async majorWarehouseIds() {
    return (await this.db('store_houses').where('major', 1).pluck('id')).map(Number);
  }

  /** `buildStorehouseListMeta()` — استعلاماتٌ مجمَّعة لا لكل مستودع */
  async listMeta(ids: number[]) {
    const out = new Map<number, WarehouseListMeta>();
    if (!ids.length) return out;

    const [stats, values, responsible] = await Promise.all([
      this.db('product_details')
        .whereIn('store_house_id', ids)
        .groupBy('store_house_id')
        .select('store_house_id', this.db.raw('COUNT(DISTINCT product_id) as products_count'), this.db.raw('SUM(quantity) as total_quantity')),
      this.db('product_details as pd')
        .join('products as p', 'p.id', 'pd.product_id')
        .whereIn('pd.store_house_id', ids)
        .groupBy('pd.store_house_id')
        .select('pd.store_house_id', this.db.raw('SUM(pd.quantity * p.purchase_price) as stock_value')),
      this.db('default_warehouses as d')
        .join('employees as e', 'e.id', 'd.employee_id')
        .whereIn('d.storehouse_id', ids)
        .whereNull('e.deleted_at')
        .orderBy('d.id')
        .select('d.storehouse_id', 'e.first_name', 'e.middle_name'),
    ]);

    const statMap = new Map((stats as Record<string, unknown>[]).map((s) => [Number(s.store_house_id), s]));
    const valueMap = new Map((values as Record<string, unknown>[]).map((v) => [Number(v.store_house_id), Number(v.stock_value ?? 0)]));
    const people = new Map<number, string[]>();
    for (const r of responsible as Record<string, unknown>[]) {
      const list = people.get(Number(r.storehouse_id)) ?? [];
      list.push(`${r.first_name ?? ''} ${r.middle_name ?? ''}`.trim());
      people.set(Number(r.storehouse_id), list);
    }

    for (const id of ids) {
      const s = statMap.get(id);
      out.set(id, {
        productsCount: Number(s?.products_count ?? 0),
        totalQuantity: Number(s?.total_quantity ?? 0),
        stockValue: valueMap.get(id) ?? 0,
        responsibleEmployees: people.get(id) ?? [],
      });
    }
    return out;
  }

  async storehouseLogs(id: number) {
    const rows = await this.db('logs as l')
      .leftJoin('users as u', 'u.id', 'l.created_by')
      .where('l.type', 'storehouse_log')
      .where('l.type_id', id)
      .orderBy('l.created_at', 'desc')
      .select('l.created_at', 'l.description', 'u.name as user_name');
    return rows.map((r: Record<string, unknown>) => ({ date: str(r.created_at), description: str(r.description), user: str(r.user_name) }));
  }

  async warehouseAccount(id: number) {
    const r = await this.db('accounts').where('storehouse_id', id).orderBy('id').first('id', 'balance');
    return r ? { id: Number(r.id), balance: Number(r.balance ?? 0) } : null;
  }

  // ═══════════════════════ الكميات والحركات ═══════════════════════

  async currentQuantities(warehouseId: number, productId?: number) {
    const q = this.db('product_details').where('store_house_id', warehouseId).groupBy('product_id').select('product_id', this.db.raw('SUM(quantity) as quantity'));
    if (productId) q.where('product_id', productId);
    const rows = await q;
    return new Map(rows.map((r: Record<string, unknown>) => [Number(r.product_id), Number(r.quantity ?? 0)]));
  }

  async approvedPermitMovements(warehouseId: number): Promise<PermitLineMovement[]> {
    const rows = await this.db('warehouse_permits as w')
      .join('warehouse_permits_products as wpp', 'wpp.warehouse_permits_id', 'w.id')
      .where('w.status', 'apporod')
      .where((q) => q.where('w.store_houses_id', warehouseId).orWhere('w.from_store_houses_id', warehouseId).orWhere('w.to_store_houses_id', warehouseId))
      .orderBy('w.id')
      .orderBy('wpp.id')
      .select('w.id as permit_id', 'w.permission_type', 'w.from_store_houses_id', 'w.to_store_houses_id', 'wpp.product_id', 'wpp.quantity');
    return rows.map((r: Record<string, unknown>) => ({
      permitId: Number(r.permit_id),
      permissionType: Number(r.permission_type ?? 0),
      fromWarehouseId: num(r.from_store_houses_id),
      toWarehouseId: num(r.to_store_houses_id),
      productId: Number(r.product_id),
      quantity: Number(r.quantity ?? 0),
    }));
  }

  async invoiceQuantities(warehouseId: number, createdBy: number | null) {
    const q = this.db('invoice_items as ii')
      .join('invoices as i', 'i.id', 'ii.invoice_id')
      .where('ii.store_house_id', warehouseId)
      .groupBy('i.type', 'ii.product_id')
      .select('i.type', 'ii.product_id', this.db.raw('SUM(ii.quantity) as quantity'));
    if (createdBy !== null) q.where('i.created_by', createdBy);
    const rows = await q;
    return rows.map((r: Record<string, unknown>) => ({ invoiceType: str(r.type), productId: Number(r.product_id), quantity: Number(r.quantity ?? 0) }));
  }

  async products(ids: number[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<number, StockProductRow>();
    const rows = await this.db('products').whereIn('id', unique).select('id', 'name', 'barcode', 'serial_number', 'category_id', 'purchase_price', 'sale_price', 'status', 'type');
    return new Map(
      rows.map((r: Record<string, unknown>) => [
        Number(r.id),
        {
          id: Number(r.id),
          name: String(r.name ?? ''),
          barcode: str(r.barcode),
          serialNumber: str(r.serial_number),
          categoryId: num(r.category_id),
          purchasePrice: num(r.purchase_price),
          salePrice: num(r.sale_price),
          status: str(r.status),
          type: str(r.type),
        },
      ]),
    );
  }

  async averageCosts(productIds: number[], warehouseId: number | null) {
    const unique = [...new Set(productIds)];
    if (!unique.length) return new Map<number, number>();
    const q = this.db('warehouse_permits_products as wpp')
      .join('warehouse_permits as w', 'wpp.warehouse_permits_id', 'w.id')
      .whereIn('wpp.product_id', unique)
      .whereNotIn('w.permission_source_id', COST_EXCLUDED_SOURCES)
      .where('wpp.quantity', '>', 0)
      .where('wpp.unit_price', '>', 0)
      .groupBy('wpp.product_id')
      .select('wpp.product_id', this.db.raw(`${COST_LINE_VALUE_SUM} as total_value`), this.db.raw('SUM(wpp.quantity) as total_quantity'));
    if (warehouseId !== null) q.where('w.store_houses_id', warehouseId);
    const rows = await q;
    const out = new Map<number, number>();
    for (const r of rows as Record<string, unknown>[]) {
      const qty = Number(r.total_quantity ?? 0);
      if (qty > 0) out.set(Number(r.product_id), Math.round((Number(r.total_value ?? 0) / qty) * 100) / 100);
    }
    return out;
  }

  async categories(): Promise<NamedOption[]> {
    return (await this.db('categories').orderBy('name').select('id', 'name')).map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  // ═══════════════════════ الكشف المخزني ═══════════════════════

  /** `generateStatement()` / `calculateOpeningBalance()` — `before` للرصيد الافتتاحي */
  async exchangeReasons(pairs: Array<[number, number]>) {
    const out = new Map<string, string>();
    if (!pairs.length) return out;
    const legacy: Record<string, string> = { damaged: 'تالفة', missing_perfume: 'العطر ناقص', defective: 'معيبة', other: 'أخرى' };
    const rows = await this.db('product_exchange_items as it')
      .leftJoin('exchange_reasons as r', 'r.id', 'it.reason_id')
      .whereIn('it.product_exchange_id', [...new Set(pairs.map((p) => p[0]))])
      .orderBy('it.id')
      .select('it.product_exchange_id', 'it.product_id', 'it.reason_id', 'it.reason', 'r.name as reason_name');
    for (const r of rows as Record<string, unknown>[]) {
      const key = `${r.product_exchange_id}_${r.product_id}`;
      if (out.has(key)) continue;
      // الاسم من `reason_id`، وإلا النصّ القديم (enum)، وإلا «غير محدد»
      const text = r.reason_id && r.reason_name ? String(r.reason_name) : r.reason ? legacy[String(r.reason)] ?? String(r.reason) : 'غير محدد';
      out.set(key, text);
    }
    return out;
  }

  async statementMovements(f: StatementFilters, before?: string): Promise<StatementMovementRow[]> {
    const q = this.db('warehouse_permits_products as wpp')
      .join('warehouse_permits as w', 'wpp.warehouse_permits_id', 'w.id')
      .join('products as p', 'wpp.product_id', 'p.id')
      .whereNotNull('wpp.quantity')
      .where('wpp.quantity', '!=', 0)
      .whereIn('w.status', APPROVED_STATES)
      .where((outer) =>
        outer
          .where((s) => s.where('w.store_houses_id', f.warehouseId).whereNull('w.from_store_houses_id').whereNull('w.to_store_houses_id'))
          .orWhere((s) => s.where('w.from_store_houses_id', f.warehouseId).where('wpp.quantity', '<', 0))
          .orWhere((s) => s.where('w.to_store_houses_id', f.warehouseId).where('wpp.quantity', '>', 0)),
      );

    if (f.productId) q.where('wpp.product_id', f.productId);
    if (f.categoryId) q.where('p.category_id', f.categoryId);
    if (f.brandId) q.where('p.brand_id', f.brandId);
    if (f.permissionSourceId) q.where('w.permission_source_id', f.permissionSourceId);

    if (before !== undefined) {
      q.where('w.permission_date', '<', `${before} 00:00:00`);
    } else {
      q.leftJoin('users as u', 'w.created_by', 'u.id').leftJoin('clients as c', 'w.client_id', 'c.id');
      if (f.startDate && f.endDate) q.whereBetween('w.permission_date', [`${f.startDate} 00:00:00`, `${f.endDate} 23:59:59`]);
      else if (f.startDate) q.where('w.permission_date', '>=', `${f.startDate} 00:00:00`);
      else if (f.endDate) q.where('w.permission_date', '<=', `${f.endDate} 23:59:59`);
      q.orderByRaw(`CASE WHEN w.permission_source_id = ${PermissionSources.WAREHOUSE_OPENING_BALANCE} THEN 0 ELSE 1 END ASC`)
        .orderByRaw('DATE(w.permission_date) ASC')
        .orderBy('w.created_at', 'asc')
        .orderBy('w.id', 'asc')
        // بنود الإذن الواحد بترتيب إدخالها — ترتيبٌ ثابت لا تغيّره خطّة الاستعلام
        .orderBy('wpp.id', 'asc');
    }

    const detail = before === undefined;
    const rows = await q.select(
      'w.id as permit_id',
      'w.number as permit_number',
      'w.permission_date',
      'w.permission_source_id',
      'w.permission_type',
      'w.reference_id',
      'w.reference_type',
      'w.store_houses_id',
      'w.from_store_houses_id',
      'w.to_store_houses_id',
      'w.details as permit_details',
      'wpp.product_id',
      'wpp.quantity',
      'p.name as product_name',
      'p.serial_number as product_code',
      ...(detail ? ['u.name as user_name', 'c.trade_name as client_trade_name', 'c.code as client_code'] : []),
    );

    return rows.map((r: Record<string, unknown>) => ({
      permitId: Number(r.permit_id),
      permitNumber: str(r.permit_number),
      permissionDate: str(r.permission_date),
      permissionSourceId: num(r.permission_source_id),
      permissionType: num(r.permission_type),
      referenceId: num(r.reference_id),
      referenceType: str(r.reference_type),
      storeHousesId: num(r.store_houses_id),
      fromWarehouseId: num(r.from_store_houses_id),
      toWarehouseId: num(r.to_store_houses_id),
      details: str(r.permit_details),
      productId: Number(r.product_id),
      quantity: Number(r.quantity ?? 0),
      productName: str(r.product_name),
      productCode: str(r.product_code),
      userName: str(r.user_name),
      clientTradeName: str(r.client_trade_name),
      clientCode: str(r.client_code),
    }));
  }

  async stockedProductsInWarehouse(warehouseId: number) {
    const rows = await this.db('products as p')
      .whereIn('p.type', STOCKED_PRODUCT_TYPES)
      .whereExists(this.db('product_details as pd').select(this.db.raw('1')).whereRaw('pd.product_id = p.id').where('pd.store_house_id', warehouseId))
      .orderBy('p.name')
      .select('p.id', 'p.name', 'p.serial_number');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), serialNumber: str(r.serial_number) }));
  }

  async referenceClient(type: 'invoice' | 'credit_note', id: number) {
    const table = type === 'invoice' ? 'invoices' : 'credit_notifications';
    const r = await this.db(`${table} as d`).join('clients as c', 'c.id', 'd.client_id').where('d.id', id).first('c.trade_name', 'c.code');
    return r ? { tradeName: str(r.trade_name), code: str(r.code) } : null;
  }

  /** `Invoice::where('type', 'sales')->whereHas(items: product)->where('invoice_date', '<=', date)->latest('invoice_date')` */
  async lastSalesInvoiceClient(productId: number, beforeDate: string | null) {
    const q = this.db('invoices as i')
      .join('clients as c', 'c.id', 'i.client_id')
      .where('i.type', 'sales')
      .whereExists(this.db('invoice_items as ii').select(this.db.raw('1')).whereRaw('ii.invoice_id = i.id').where('ii.product_id', productId))
      .orderBy('i.invoice_date', 'desc');
    if (beforeDate !== null) q.where('i.invoice_date', '<=', beforeDate);
    else q.whereRaw('1 = 0');
    const r = await q.first('c.trade_name', 'c.code');
    return r ? { tradeName: str(r.trade_name), code: str(r.code) } : null;
  }

  // ═══════════════════════ الفترات ═══════════════════════

  async accountingPeriodFor(date: string) {
    const r = await this.db('accounting_periods').whereRaw('DATE(start_date) <= ?', [date]).whereRaw('DATE(end_date) >= ?', [date]).orderBy('id').first('id', 'name', 'start_date', 'end_date');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), startDate: String(r.start_date).slice(0, 10), endDate: String(r.end_date).slice(0, 10) } : null;
  }

  async defaultPeriodType() {
    const r = await this.db('accounting_period_settings').orderBy('id').first('default_period_type').catch(() => null);
    return (r?.default_period_type as string | undefined) || 'monthly';
  }
}
