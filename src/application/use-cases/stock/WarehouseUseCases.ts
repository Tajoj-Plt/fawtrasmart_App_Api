import { AppError } from '../../../domain/errors/AppError';
import { StatementMovementRow, StockRepository, WarehouseRow } from '../../../domain/repositories/stock';
import { round } from '../../../domain/services/clients/Geo';
import { PermissionSources, sourceName, STOCK_PLAN } from '../../../domain/services/stock/StockConstants';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { PeriodResolver } from '../../services/PeriodResolver';
import { StockContext, StockContextFactory } from '../../services/stock/StockContext';

export const WAREHOUSE_PERMISSIONS = {
  view: 'stock.warehouses.view',
  show: 'stock.warehouses.show',
  movements: 'stock.reports.summary_movement',
  statement: 'stock.reports.employee_statement',
} as const;

const PER_PAGE = [10, 25, 50, 100];
const PERIOD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

const INCOMING_SOURCES: number[] = [
  PermissionSources.SALES_RETURN,
  PermissionSources.SALES_CREDIT_NOTE,
  PermissionSources.WAREHOUSE_ADD,
  PermissionSources.PURCHASE_INVOICE,
  PermissionSources.INVENTORY_RECEIVED,
  PermissionSources.WAREHOUSE_OPENING_BALANCE,
  PermissionSources.MANUFACTURING_MAIN_PRODUCT,
  PermissionSources.MANUFACTURING_RETURNS,
  PermissionSources.POS_SHIFT_INBOUND,
  PermissionSources.PRODUCT_EXCHANGE_RETURN,
];
const DAMAGED_SOURCES: number[] = [
  PermissionSources.PRODUCT_EXCHANGE_RETURN,
  PermissionSources.INVENTORY_DAMAGE,
  PermissionSources.MANUFACTURING_DAMAGED_MATERIALS,
  PermissionSources.MANUFACTURING_RETURNS,
];

interface OverviewItem {
  id: number;
  name: string;
  barcode: string | null;
  currentQuantity: number;
  incomingManual: number;
  incomingOpening: number;
  incomingTransfer: number;
  incomingTotal: number;
  outgoingManual: number;
  outgoingTransfer: number;
  sold: number;
  salesReturns: number;
  withdrawnTotal: number;
  unitCost: number;
  stockValue: number;
}

export interface MovementFilters {
  keywords?: string;
  category?: number;
  operationType?: 'incoming' | 'outgoing' | 'transfer';
}

export interface StatementQuery {
  warehouse?: number;
  startDate?: string;
  endDate?: string;
  periodId?: string;
  product?: number;
  category?: number;
  brand?: number;
  permissionSource?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * المستودعات والكشف المخزني — `StorehouseController` و`WarehouseStatementController`
 * في الويب: القائمة بإحصاءاتها، التفاصيل بكميات كل صنف وقيمته مقابل رصيد حسابه،
 * حركات المستودع، والكشف المخزني برصيده المتتابع (السليم والتالف).
 */
export class WarehouseUseCases {
  constructor(
    private readonly contexts: StockContextFactory,
    private readonly stock: StockRepository,
    private readonly periods: PeriodResolver,
  ) {}

  // ═══════════════════════ المستودعات ═══════════════════════

  private async payload(ctx: StockContext, w: WarehouseRow, meta: { productsCount?: number; totalQuantity?: number; stockValue?: number; responsibleEmployees?: string[] } | undefined, defaults: number[]) {
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      shippingAddress: w.shippingAddress,
      branch: w.branchName,
      isDefault: defaults.includes(w.id),
      productsCount: meta?.productsCount ?? null,
      totalQuantity: meta?.totalQuantity ?? null,
      stockValue: meta?.stockValue ?? null,
      responsibleEmployees: meta?.responsibleEmployees ?? [],
      canView: await ctx.warehouseAllows('view', w),
      canCreateInvoices: await ctx.warehouseAllows('create_invoices', w),
      canEditStock: await ctx.warehouseAllows('edit_stock', w),
      canViewDetails: ctx.can(WAREHOUSE_PERMISSIONS.show),
      canViewMovements: ctx.can(WAREHOUSE_PERMISSIONS.movements),
      canViewStatement: ctx.can(WAREHOUSE_PERMISSIONS.statement),
    };
  }

  private defaults(ctx: StockContext) {
    return ctx.user.employeeId ? this.stock.defaultWarehouseIds([ctx.user.employeeId]) : Promise.resolve([] as number[]);
  }

  async list(userId: number, meta: RequestMeta, q: { page?: number; perPage?: number; keywords?: string; status?: string }) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.storehouses], permissions: [WAREHOUSE_PERMISSIONS.view] });
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;

    const { rows, total } = await this.stock.warehousePage(await ctx.accessibleWarehouseIds(), { keywords: q.keywords, status: q.status }, page, perPage);
    const [meta2, defaults] = await Promise.all([this.stock.listMeta(rows.map((r) => r.id)), this.defaults(ctx)]);

    const items = [];
    for (const w of rows) items.push(await this.payload(ctx, w, meta2.get(w.id), defaults));
    return { items, total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }

  private async findWarehouse(ctx: StockContext, id: number) {
    const w = await this.stock.warehouse(id);
    if (!w) throw AppError.notFound('WAREHOUSE_NOT_FOUND', 'المستودع غير موجود.');
    await ctx.authorizeWarehouse(w.id);
    return w;
  }

  /** `buildAccountingOverview()` — كميات كل صنف ووارده ومنصرفه وقيمته */
  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.storehouses], permissions: [WAREHOUSE_PERMISSIONS.view, WAREHOUSE_PERMISSIONS.show] });
    const w = await this.findWarehouse(ctx, id);

    const [account, current, movements, invoiceLines, logs, listMeta, defaults] = await Promise.all([
      this.stock.warehouseAccount(w.id),
      this.stock.currentQuantities(w.id),
      this.stock.approvedPermitMovements(w.id),
      this.stock.invoiceQuantities(w.id, ctx.user.employeeId ? ctx.user.id : null),
      this.stock.storehouseLogs(w.id),
      this.stock.listMeta([w.id]),
      this.defaults(ctx),
    ]);

    const sold = new Map<number, number>();
    const returns = new Map<number, number>();
    for (const l of invoiceLines) {
      if (l.invoiceType === 'normal' || l.invoiceType === 'pos') sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.quantity);
      if (l.invoiceType === 'returned') returns.set(l.productId, (returns.get(l.productId) ?? 0) + l.quantity);
    }

    type Row = { incomingManual: number; incomingOpening: number; incomingTransfer: number; outgoingManual: number; outgoingTransfer: number };
    const blank = (): Row => ({ incomingManual: 0, incomingOpening: 0, incomingTransfer: 0, outgoingManual: 0, outgoingTransfer: 0 });
    const rows = new Map<number, Row>();
    for (const m of movements) {
      const r = rows.get(m.productId) ?? blank();
      if (m.permissionType === 1) r.incomingManual += m.quantity;
      else if (m.permissionType === 2) r.outgoingManual += m.quantity;
      else if (m.permissionType === 3) {
        if (m.toWarehouseId === w.id) r.incomingTransfer += m.quantity;
        if (m.fromWarehouseId === w.id) r.outgoingTransfer += m.quantity;
      } else if (m.permissionType === 4) r.incomingOpening += m.quantity;
      rows.set(m.productId, r);
    }
    for (const productId of current.keys()) if (!rows.has(productId)) rows.set(productId, blank());

    const ids = [...rows.keys()];
    const [products, storeAvg, generalAvg] = await Promise.all([this.stock.products(ids), this.stock.averageCosts(ids, w.id), this.stock.averageCosts(ids, null)]);

    const items: OverviewItem[] = [];
    let totalStockValue = 0;
    for (const [productId, m] of rows) {
      const product = products.get(productId);
      if (!product) continue;
      const currentQuantity = current.get(productId) ?? 0;
      const soldQty = sold.get(productId) ?? 0;
      const incomingTotal = m.incomingManual + m.incomingOpening + m.incomingTransfer;
      const outgoingTotal = m.outgoingManual + m.outgoingTransfer;
      // `averageCostForStorehouse() ?? averageCost() ?? purchase_price ?? 0` — والعامّ يرجع لسعر الشراء بنفسه
      const unitCost = storeAvg.get(productId) ?? generalAvg.get(productId) ?? product.purchasePrice ?? 0;
      const stockValue = currentQuantity * unitCost;
      totalStockValue += stockValue;
      items.push({
        id: product.id,
        name: product.name,
        barcode: product.barcode,
        currentQuantity,
        incomingManual: m.incomingManual,
        incomingOpening: m.incomingOpening,
        incomingTransfer: m.incomingTransfer,
        incomingTotal,
        outgoingManual: m.outgoingManual,
        outgoingTransfer: m.outgoingTransfer,
        sold: soldQty,
        salesReturns: returns.get(productId) ?? 0,
        withdrawnTotal: outgoingTotal + soldQty,
        unitCost,
        stockValue,
      });
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const columns = ['currentQuantity', 'incomingManual', 'incomingOpening', 'incomingTransfer', 'incomingTotal', 'outgoingManual', 'outgoingTransfer', 'sold', 'salesReturns', 'withdrawnTotal'] as const;
    const totals = Object.fromEntries(columns.map((c) => [c, items.reduce((sum, item) => sum + item[c], 0)]));
    const accountBalance = account ? account.balance : null;

    return {
      warehouse: await this.payload(ctx, w, listMeta.get(w.id), defaults),
      items,
      totals,
      totalStockValue,
      accountBalance,
      valueDifference: accountBalance !== null ? round(totalStockValue - accountBalance, 2) : null,
      logs,
    };
  }

  /** `searchSummaryInventoryOperations()` — ملخّص حركة كل صنف في المستودع */
  async movements(userId: number, meta: RequestMeta, id: number, f: MovementFilters) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.storehouses], permissions: [WAREHOUSE_PERMISSIONS.movements] });
    await ctx.authorizeWarehouse(id);
    const w = await this.stock.warehouse(id);
    if (!w) throw AppError.notFound('WAREHOUSE_NOT_FOUND', 'المستودع غير موجود.');

    const [movements, invoiceLines, categories] = await Promise.all([
      this.stock.approvedPermitMovements(w.id),
      this.stock.invoiceQuantities(w.id, ctx.user.employeeId ? ctx.user.id : null),
      this.stock.categories(),
    ]);
    const products = await this.stock.products(movements.map((m) => m.productId));

    const sold = new Map<number, number>();
    const returns = new Map<number, number>();
    for (const l of invoiceLines) {
      if (l.invoiceType === 'normal' || l.invoiceType === 'pos') sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.quantity);
      if (l.invoiceType === 'returned') returns.set(l.productId, (returns.get(l.productId) ?? 0) + l.quantity);
    }

    const data = new Map<number, Record<string, number | string> & { name: string; categoryId: number | null }>();
    for (const m of movements) {
      const product = products.get(m.productId);
      if (!product) continue;
      let row = data.get(m.productId);
      if (!row) {
        row = {
          name: product.name,
          id: m.productId,
          categoryId: product.categoryId,
          incomingManual: 0,
          incomingOpening: 0,
          incomingTransfer: 0,
          outgoingManual: 0,
          outgoingTransfer: 0,
          incomingTotal: 0,
          outgoingTotal: 0,
          movementTotal: 0,
          soldQuantity: sold.get(m.productId) ?? 0,
          salesReturnQuantity: returns.get(m.productId) ?? 0,
        } as Record<string, number | string> & { name: string; categoryId: number | null };
        data.set(m.productId, row);
      }
      const add = (key: string) => (row![key] = (row![key] as number) + m.quantity);
      if (m.permissionType === 1) add('incomingManual');
      else if (m.permissionType === 2) add('outgoingManual');
      else if (m.permissionType === 3) {
        if (m.toWarehouseId === w.id) add('incomingTransfer');
        if (m.fromWarehouseId === w.id) add('outgoingTransfer');
      } else if (m.permissionType === 4) add('incomingOpening');
      row.incomingTotal = (row.incomingManual as number) + (row.incomingOpening as number) + (row.incomingTransfer as number);
      row.outgoingTotal = (row.outgoingManual as number) + (row.outgoingTransfer as number);
      row.movementTotal = (row.incomingTotal as number) - (row.outgoingTotal as number);
    }

    let list = [...data.values()];
    if (f.keywords) {
      const k = f.keywords.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(k));
    }
    if (f.category) list = list.filter((p) => p.categoryId === f.category);
    if (f.operationType === 'incoming') list = list.filter((p) => (p.incomingTotal as number) > 0);
    else if (f.operationType === 'outgoing') list = list.filter((p) => (p.outgoingTotal as number) > 0);
    else if (f.operationType === 'transfer') list = list.filter((p) => (p.incomingTransfer as number) > 0 || (p.outgoingTransfer as number) > 0);

    return {
      items: list.map(({ categoryId: _c, ...rest }) => rest),
      storehouse: { id: w.id, name: w.name, status: w.status, shippingAddress: w.shippingAddress, branchId: w.branchId },
      categories,
    };
  }

  // ═══════════════════════ الكشف المخزني ═══════════════════════

  async statementWarehouses(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.storehouses], permissions: [WAREHOUSE_PERMISSIONS.statement] });
    return this.stock.warehouseOptions(await ctx.accessibleWarehouseIds());
  }

  /** `reportDateRange()` — التاريخان المرسَلان، أو الفترة المختارة، أو الفترة المحاسبية الجارية */
  private async reportRange(ctx: StockContext, q: StatementQuery): Promise<{ start: string; end: string }> {
    let start: string | null = null;
    let end: string | null = null;

    if (q.startDate || q.endDate) {
      start = q.startDate ?? q.endDate!;
      end = q.endDate ?? q.startDate!;
      if (start > end) [start, end] = [end, start];
    } else {
      const period = await this.periods.resolve(q.periodId, ctx.today);
      const noCalendar = period.key === null && period.unconfigured && period.periodIds === null;
      if (period.key !== 'all' && !noCalendar) {
        start = period.from;
        end = period.to;
      }
    }

    if (start && end) return { start, end };
    const fallback = await this.defaultRange(ctx);
    return { start: start || fallback.start, end: end || fallback.end };
  }

  /** `defaultReportRange()` — فترة اليوم المحاسبية، وإلا نوع الفترات الافتراضي */
  private async defaultRange(ctx: StockContext) {
    const period = await this.stock.accountingPeriodFor(ctx.today);
    if (period) return { start: period.startDate, end: period.endDate };

    const months = PERIOD_MONTHS[await this.stock.defaultPeriodType()] ?? 1;
    const y = ctx.now.getUTCFullYear();
    if (months >= 12) return { start: ymd(y, 1, 1), end: ymd(y, 12, 31) };
    const index = Math.floor(ctx.now.getUTCMonth() / months);
    const startMonth = index * months + 1;
    const last = new Date(Date.UTC(y, startMonth - 1 + months, 0));
    return { start: ymd(y, startMonth, 1), end: ymd(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()) };
  }

  private isIncoming(m: StatementMovementRow, warehouseId: number) {
    if (m.permissionType !== null) {
      if (m.permissionType === 1) return true;
      if (m.permissionType === 2) return false;
    }
    if (m.toWarehouseId === warehouseId) return true;
    if (m.fromWarehouseId === warehouseId) return false;
    return m.permissionSourceId !== null && INCOMING_SOURCES.includes(m.permissionSourceId);
  }

  private isDamaged(m: StatementMovementRow, mainIds: number[]) {
    if (m.referenceType === 'ارجاع تبديل تالف') return true;
    if (m.referenceType === 'تبديل تالف') return false;
    if (m.permissionSourceId !== null && DAMAGED_SOURCES.includes(m.permissionSourceId)) return true;
    return m.permissionSourceId === PermissionSources.MANUAL_TRANSFER && m.toWarehouseId !== null && mainIds.includes(m.toWarehouseId);
  }

  private movementType(m: StatementMovementRow) {
    const name = sourceName(m.permissionSourceId);
    const exchange = m.permissionSourceId === PermissionSources.PRODUCT_EXCHANGE || m.permissionSourceId === PermissionSources.PRODUCT_EXCHANGE_RETURN;
    return exchange || (m.referenceType ?? '').includes('تبديل') ? `إذن ${name}` : name;
  }

  /** `applyPrioritizedDeduction()` — التالف أولاً حين تكون الحركة تالفة */
  private deduct(quantity: number, good: number, damaged: number, damagedFirst: boolean) {
    if (!damagedFirst) return { good: good - quantity, damaged, fromDamaged: 0 };
    if (damaged >= quantity) return { good, damaged: damaged - quantity, fromDamaged: quantity };
    return { good: good - (quantity - damaged), damaged: 0, fromDamaged: damaged };
  }

  async statement(userId: number, meta: RequestMeta, q: StatementQuery) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.storehouses], permissions: [WAREHOUSE_PERMISSIONS.statement] });
    const allowed = await ctx.accessibleWarehouseIds();
    const warehouses = await this.stock.warehouseOptions(allowed);

    if (!warehouses.length) {
      throw AppError.notFound('NO_WAREHOUSES', allowed === null ? 'لا توجد مستودعات مسجَّلة في النظام بعد.' : 'لا توجد مستودعات ضمن نطاقك حالياً.');
    }

    // مستودعٌ خارج النطاق يعود إلى أوّل مستودعٍ متاح
    let warehouseId = q.warehouse || warehouses[0].id;
    if (allowed !== null && !allowed.includes(warehouseId)) warehouseId = warehouses[0].id;
    const warehouse = await this.stock.warehouse(warehouseId);

    const { start, end } = await this.reportRange(ctx, q);
    const filters = { warehouseId, productId: q.product, categoryId: q.category, brandId: q.brand, permissionSourceId: q.permissionSource, startDate: start, endDate: end };

    const [movements, openingRows, mainIds, current, products] = await Promise.all([
      this.stock.statementMovements(filters),
      start ? this.stock.statementMovements(filters, start) : Promise.resolve([]),
      this.stock.majorWarehouseIds(),
      this.stock.currentQuantities(warehouseId, q.product),
      this.stock.stockedProductsInWarehouse(warehouseId),
    ]);

    // الرصيد الافتتاحي (قبل الفترة)
    let opening = { total: 0, good: 0, damaged: 0 };
    for (const m of openingRows) {
      const quantity = Math.abs(m.quantity);
      if (this.isIncoming(m, warehouseId)) {
        opening.total += quantity;
        if (this.isDamaged(m, mainIds)) opening.damaged += quantity;
        else opening.good += quantity;
      } else {
        const d = this.deduct(quantity, opening.good, opening.damaged, this.isDamaged(m, mainIds));
        opening = { total: opening.total - quantity, good: d.good, damaged: d.damaged };
      }
    }

    const names = await this.stock.warehouseNames(movements.flatMap((m) => [m.fromWarehouseId ?? 0, m.toWarehouseId ?? 0]));
    const clientMemo = new Map<string, Promise<{ tradeName: string | null; code: string | null } | null>>();
    const lookup = (key: string, producer: () => Promise<{ tradeName: string | null; code: string | null } | null>) => {
      if (!clientMemo.has(key)) clientMemo.set(key, producer());
      return clientMemo.get(key)!;
    };

    const exchangeReasons = await this.stock.exchangeReasons(movements.filter((m) => (m.permissionSourceId === 27 || m.permissionSourceId === 28) && m.referenceId).map((m) => [m.referenceId as number, m.productId] as [number, number]));

    let running = opening.total;
    let good = opening.good;
    let damaged = opening.damaged;
    let totalIncoming = 0;
    let totalOutgoing = 0;
    const out = [];

    for (const m of movements) {
      const before = running;
      const incoming = this.isIncoming(m, warehouseId);
      const quantity = Math.abs(m.quantity);
      const isDamaged = this.isDamaged(m, mainIds);

      let clientTradeName = m.clientTradeName;
      let clientCode = m.clientCode;
      if (!clientTradeName && !clientCode && m.referenceId && m.referenceType) {
        const found =
          m.referenceType === 'Invoice' || m.referenceType === 'SalesReturn'
            ? await lookup(`i:${m.referenceId}`, () => this.stock.referenceClient('invoice', m.referenceId!))
            : m.referenceType === 'CreditNote'
              ? await lookup(`c:${m.referenceId}`, () => this.stock.referenceClient('credit_note', m.referenceId!))
              : null;
        if (found) [clientTradeName, clientCode] = [found.tradeName, found.code];
      }
      if (!clientTradeName && !clientCode) {
        const found = await lookup(`s:${m.productId}:${m.permissionDate}`, () => this.stock.lastSalesInvoiceClient(m.productId, m.permissionDate));
        if (found) [clientTradeName, clientCode] = [found.tradeName, found.code];
      }

      if (incoming) {
        running += quantity;
        totalIncoming += quantity;
        if (isDamaged) damaged += quantity;
        else good += quantity;
      } else {
        running -= quantity;
        totalOutgoing += quantity;
        const d = this.deduct(quantity, good, damaged, isDamaged);
        good = d.good;
        damaged = d.damaged;
      }

      const transfer = m.permissionSourceId === PermissionSources.MANUAL_TRANSFER;
      out.push({
        id: m.permitId,
        date: m.permissionDate,
        type: this.movementType(m),
        reference: `#${m.permitNumber ?? ''}`,
        productName: m.productName,
        productCode: m.productCode,
        quantity,
        incoming: incoming ? quantity : 0,
        outgoing: incoming ? 0 : quantity,
        balanceBefore: before,
        balanceAfter: running,
        balance: running,
        goodBalance: good,
        damagedBalance: damaged,
        isDamaged,
        // `ProductExchangeItem::reason_text` — لإذنَي التبديل (27/28) المربوطين بعمليته
        exchangeReason: (m.permissionSourceId === 27 || m.permissionSourceId === 28) && m.referenceId ? exchangeReasons.get(`${m.referenceId}_${m.productId}`) ?? null : null,
        userName: m.userName,
        notes: m.details,
        clientTradeName,
        clientCode,
        transferInfo: transfer ? { from: names.get(m.fromWarehouseId ?? 0) ?? '-', to: names.get(m.toWarehouseId ?? 0) ?? '-' } : null,
      });
    }

    const currentStock = [...current.values()].reduce((a, b) => a + b, 0);

    return {
      warehouse: warehouse ? { id: warehouse.id, name: warehouse.name } : null,
      startDate: start,
      endDate: end,
      statement: {
        openingBalance: opening.total,
        totalIncoming,
        totalOutgoing,
        closingBalance: running,
        goodStock: good,
        damagedStock: damaged,
        currentStock,
        movements: out,
        startDate: start,
        endDate: end,
      },
      products,
    };
  }
}
