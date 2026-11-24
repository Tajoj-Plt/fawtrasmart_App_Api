import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import {
  InvoiceItemRow,
  InvoiceListFilters,
  InvoiceRow,
  SalesInvoiceSettingsRow,
  SalesProduct,
  SalesRepository,
  SalesUnitOption,
  TreasuryRow,
} from '../../../domain/repositories/sales';
import { Coupon, DiscountOffer, GiftOffer } from '../../../domain/services/sales/PromotionRules';
import { TaxSetting } from '../../../domain/services/sales/SalesMath';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const WALLETS = ['client_wallet', 'supplier_wallet'];
const ledger = (q: Knex.QueryBuilder, alias = 'accounts') => q.where((w) => w.whereNull(`${alias}.type_accont`).orWhereNotIn(`${alias}.type_accont`, WALLETS));

/** قائمة JSON مخزّنة نصّاً (`applicable_products` …) ← أرقام */
const idList = (v: unknown): number[] => {
  if (v === null || v === undefined || v === '') return [];
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  } catch {
    return [];
  }
};

const SETTING_FLAGS = [
  'no_sell_below_cost',
  'enable_max_discount',
  'select_price_list',
  'show_invoice_profit',
  'preview_before_save',
  'default_paid_status',
  'auto_pay_if_balance',
  'auto_pay_from_wallet',
  'manual_invoice_status',
  'disable_delivery_options',
  'show_service_products',
  'show_digital_products',
  'disable_quotes',
  'manual_quote_status',
  'enable_sales_orders',
  'manual_sales_order_status',
  'apply_offers_to_quotes',
  'enable_coupons',
  'copy_notes_on_conversion',
  'custom_journal_description',
  'send_on_social',
];

/** قيمُ `$attributes` في الموديل حين لا صفّ — `SalesInvoiceSetting::current()` */
const SETTING_DEFAULTS: Record<string, boolean> = { show_service_products: true, show_digital_products: true };

function mapProduct(r: Record<string, unknown>): SalesProduct {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    barcode: str(r.barcode),
    serialNumber: str(r.serial_number),
    type: String(r.type ?? 'products'),
    compileType: str(r.compile_type),
    status: str(r.status),
    categoryId: num(r.category_id),
    salePrice: Number(r.sale_price ?? 0),
    purchasePrice: Number(r.purchase_price ?? 0),
    minSalePrice: num(r.min_sale_price),
    tax1: num(r.tax1),
    tax2: num(r.tax2),
    lowStockAlert: num(r.low_stock_alert),
    trackInventory: num(r.track_inventory),
    expiryDate: str(r.expiry_date),
    notifyBeforeDays: num(r.notify_before_days),
  };
}

const PRODUCT_COLUMNS = [
  'p.id',
  'p.name',
  'p.barcode',
  'p.serial_number',
  'p.type',
  'p.compile_type',
  'p.status',
  'p.category_id',
  'p.sale_price',
  'p.purchase_price',
  'p.min_sale_price',
  'p.tax1',
  'p.tax2',
  'p.low_stock_alert',
  'p.track_inventory',
  'p.expiry_date',
  'p.notify_before_days',
];

const INVOICE_COLUMNS = [
  'i.id',
  'i.code',
  'i.type',
  'i.client_id',
  'c.trade_name as client_name',
  'c.code as client_code',
  'i.branch_id',
  'b.name as branch_name',
  'i.employee_id',
  'e.first_name as employee_first',
  'e.middle_name as employee_middle',
  'i.created_by',
  'u.name as created_by_name',
  'i.invoice_date',
  'i.issue_date',
  'i.payment_terms',
  'i.payment_status',
  'i.is_paid',
  'i.currency',
  'i.subtotal',
  'i.discount_amount',
  'i.coupon_code',
  'i.coupon_discount',
  'i.shipping_cost',
  'i.shipping_tax',
  'i.tax_total',
  'i.grand_total',
  'i.advance_payment',
  'i.due_value',
  'i.returned_payment',
  'i.wallet_paid_amount',
  'i.notes',
  'i.qrcode',
  'i.order_source_id',
  'i.voided_at',
  'i.created_at',
  'i.reference_number',
];

function mapInvoice(r: Record<string, unknown>): InvoiceRow {
  const employeeName = `${r.employee_first ?? ''} ${r.employee_middle ?? ''}`.trim();
  return {
    id: Number(r.id),
    code: str(r.code),
    type: str(r.type),
    clientId: num(r.client_id),
    clientName: str(r.client_name),
    clientCode: str(r.client_code),
    branchId: num(r.branch_id),
    branchName: str(r.branch_name),
    employeeId: num(r.employee_id),
    employeeName: employeeName || null,
    createdBy: num(r.created_by),
    createdByName: str(r.created_by_name),
    invoiceDate: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null,
    issueDate: r.issue_date ? String(r.issue_date).slice(0, 10) : null,
    paymentTerms: str(r.payment_terms),
    paymentStatus: num(r.payment_status),
    isPaid: bool(r.is_paid),
    currency: str(r.currency),
    subtotal: Number(r.subtotal ?? 0),
    discountAmount: Number(r.discount_amount ?? 0),
    couponCode: str(r.coupon_code),
    couponDiscount: Number(r.coupon_discount ?? 0),
    shippingCost: Number(r.shipping_cost ?? 0),
    shippingTax: Number(r.shipping_tax ?? 0),
    taxTotal: Number(r.tax_total ?? 0),
    grandTotal: Number(r.grand_total ?? 0),
    advancePayment: Number(r.advance_payment ?? 0),
    dueValue: Number(r.due_value ?? 0),
    returnedPayment: Number(r.returned_payment ?? 0),
    walletPaidAmount: Number(r.wallet_paid_amount ?? 0),
    notes: str(r.notes),
    qrcode: str(r.qrcode),
    orderSourceId: num(r.order_source_id),
    voidedAt: str(r.voided_at),
    createdAt: str(r.created_at),
    referenceNumber: str(r.reference_number),
  };
}

/** قراءات المبيعات على جداول الويب */
export class KnexSalesRepository implements SalesRepository {
  constructor(
    private readonly db: Knex,
    private readonly appName: string,
  ) {}

  // ═══════════════════════ الإعدادات ═══════════════════════

  async settings(): Promise<SalesInvoiceSettingsRow> {
    const r = await this.db('sales_invoice_settings').orderBy('id').first().catch(() => null);
    const flags: Record<string, boolean> = {};
    for (const f of SETTING_FLAGS) flags[f] = r ? bool(r[f]) : SETTING_DEFAULTS[f] ?? false;
    return {
      maxDiscountPercent: r ? num(r.max_discount_percent) : 10,
      maxDiscountType: r ? str(r.max_discount_type) : null,
      maxDiscountAmount: r ? num(r.max_discount_amount) : null,
      warehouseSource: r ? str(r.warehouse_source) : 'employee',
      flags,
    };
  }

  async branchOwnMaxDiscount(branchId: number) {
    const r = await this.db('branch_setting_branch as bsb')
      .join('branch_settings as bs', 'bs.id', 'bsb.branch_setting_id')
      .where('bsb.branch_id', branchId)
      .where('bs.key', 'max_discount_percent')
      .first('bsb.value')
      .catch(() => undefined);
    if (!r) return null;
    const v = r.value;
    return v === null || v === undefined || v === '' ? null : Number(v);
  }

  async taxes(): Promise<TaxSetting[]> {
    const rows = await this.db('tax_sittings').orderBy('id').select('id', 'name', 'tax', 'type');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), rate: Number(r.tax ?? 0), type: r.type === 'included' ? 'included' : 'excluded' }));
  }

  async paymentMethods() {
    const rows = await this.db('payment_methods').whereNull('deleted_at').where('status', 'active').orderBy('is_default', 'desc').orderBy('sort_order').select('id', 'name', 'code', 'is_default');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), code: str(r.code), isDefault: bool(r.is_default) }));
  }

  async defaultInvoicePaymentMethod() {
    const byDefault = await this.db('payment_methods').whereNull('deleted_at').where('is_default', 1).where('is_active', 1).orderBy('id').first('id');
    if (byDefault) return Number(byDefault.id);
    const first = await this.db('payment_methods').whereNull('deleted_at').where('is_active', 1).orderBy('sort_order').orderBy('id').first('id');
    return first ? Number(first.id) : 1;
  }

  async defaultReceiptPaymentMethod() {
    const r = await this.db('payment_methods').whereNull('deleted_at').where('status', 'active').orderBy('is_default', 'desc').orderBy('sort_order').first('id');
    return r ? Number(r.id) : null;
  }

  async orderSources() {
    const rows = await this.db('order_sources').where('active', 1).orderBy('sort_order').orderBy('name').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async orderSourceSetting(key: string) {
    const r = await this.db('settings_order_sources').where('setting_key', key).first('value').catch(() => null);
    return r ? str(r.value) : null;
  }

  async orderSource(id: number) {
    const r = await this.db('order_sources').where('id', id).where('active', 1).first('id', 'name');
    return r ? { id: Number(r.id), name: String(r.name ?? '') } : null;
  }

  private mapTreasury(r: Record<string, unknown>): TreasuryRow {
    return {
      id: Number(r.id),
      accountId: num(r.account_id),
      name: String(r.name ?? ''),
      type: num(r.type),
      depositPermissions: num(r.deposit_permissions),
      valueOfDepositPermissions: str(r.value_of_deposit_permissions),
      withdrawPermissions: num(r.withdraw_permissions),
      valueOfWithdrawPermissions: str(r.value_of_withdraw_permissions),
    };
  }

  async treasuries() {
    const rows = await this.db('treasuries').whereNotNull('account_id').orderBy('name').select('*');
    return rows.map((r: Record<string, unknown>) => this.mapTreasury(r));
  }

  async treasuryByAccount(accountId: number) {
    const r = await this.db('treasuries').where('account_id', accountId).orderBy('id').first();
    return r ? this.mapTreasury(r) : null;
  }

  async employeeTreasuryAccountIds(employeeId: number) {
    return (await this.db('treasury_employees').where('employee_id', employeeId).orderBy('id').pluck('treasury_id')).map(Number).filter(Boolean);
  }

  async roleName(roleId: number) {
    const r = await this.db('roles').where('id', roleId).first('name').catch(() => null);
    return r ? str(r.name) : null;
  }

  async priceLists() {
    const rows = await this.db('price_lists').orderBy('id', 'desc').select('id', 'name');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async priceListPrice(priceListId: number, productId: number) {
    const r = await this.db('price_list_items').where('price_list_id', priceListId).where('product_id', productId).orderBy('id').first('sale_price');
    return r ? num(r.sale_price) : null;
  }

  // ═══════════════════════ الكتالوج ═══════════════════════

  async sellableProducts(warehouseId: number | null, stocklessTypes: string[], search?: string, limit = 500, productIds?: number[], inStockOnly = false) {
    const q = this.db('products as p').select(PRODUCT_COLUMNS).orderBy('p.name').limit(limit);
    if (productIds) q.whereIn('p.id', productIds.length ? productIds : [0]);
    if (warehouseId !== null) {
      q.where((w) => {
        w.whereExists((s) => {
          s.select(this.db.raw(1)).from('product_details as d').whereRaw('d.product_id = p.id').where('d.store_house_id', warehouseId);
          if (inStockOnly) s.where('d.quantity', '>', 0);
        });
        if (stocklessTypes.length) w.orWhereIn('p.type', stocklessTypes);
      });
    }
    if (search) {
      const term = likeTerm(search);
      q.where((w) => w.where('p.name', 'like', term).orWhere('p.barcode', 'like', term).orWhere('p.serial_number', 'like', term));
    }
    return (await q).map(mapProduct);
  }

  async negativeStockAllowed() {
    const r = await this.db('general_settings').orderBy('id').first('enable_negative_stock').catch(() => null);
    return Boolean(r && bool(r.enable_negative_stock));
  }

  async products(ids: number[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map<number, SalesProduct>();
    if (!unique.length) return out;
    for (const r of (await this.db('products as p').whereIn('p.id', unique).select(PRODUCT_COLUMNS)) as Record<string, unknown>[]) out.set(Number(r.id), mapProduct(r));
    return out;
  }

  /** `ProductUnits::forProduct()` — وحدات المنتج النشطة، وإلا وحدات تصنيفه النشطة */
  async unitsFor(products: SalesProduct[]) {
    const out = new Map<number, SalesUnitOption[]>();
    if (!products.length) return out;
    const ids = products.map((p) => p.id);

    const own = await this.db('product_units as pu')
      .join('category_unit as cu', 'cu.id', 'pu.category_unit_id')
      .join('units as un', 'un.id', 'cu.unit_id')
      .whereIn('pu.product_id', ids)
      .where('pu.is_active', 1)
      .orderBy('pu.id')
      .select('pu.id', 'pu.product_id', 'pu.category_unit_id', 'un.name', 'cu.conversion_factor', 'cu.is_base_unit', 'pu.is_default', 'pu.sale_price', 'pu.purchase_price', 'pu.barcode');
    for (const r of own as Record<string, unknown>[]) {
      const list = out.get(Number(r.product_id)) ?? [];
      list.push({
        id: Number(r.id),
        categoryUnitId: num(r.category_unit_id),
        name: String(r.name ?? ''),
        conversionFactor: Number(r.conversion_factor ?? 1),
        isBaseUnit: bool(r.is_base_unit),
        isDefault: bool(r.is_default),
        salePrice: Number(r.sale_price ?? 0),
        purchasePrice: Number(r.purchase_price ?? 0),
        barcode: str(r.barcode),
      });
      out.set(Number(r.product_id), list);
    }

    const withoutOwn = products.filter((p) => !out.has(p.id) && p.categoryId);
    const categoryIds = [...new Set(withoutOwn.map((p) => p.categoryId as number))];
    if (categoryIds.length) {
      const rows = await this.db('category_unit as cu')
        .join('units as un', 'un.id', 'cu.unit_id')
        .whereIn('cu.category_id', categoryIds)
        .where('cu.is_active', 1)
        .orderBy('cu.id')
        .select('cu.id', 'cu.category_id', 'un.name', 'cu.conversion_factor', 'cu.is_base_unit');
      for (const p of withoutOwn) {
        const units = (rows as Record<string, unknown>[])
          .filter((r) => Number(r.category_id) === p.categoryId)
          .map((r) => ({
            id: null,
            categoryUnitId: Number(r.id),
            name: String(r.name ?? ''),
            conversionFactor: Number(r.conversion_factor ?? 1),
            isBaseUnit: bool(r.is_base_unit),
            isDefault: bool(r.is_base_unit),
            salePrice: p.salePrice,
            purchasePrice: p.purchasePrice,
            barcode: null,
          }));
        if (units.length) out.set(p.id, units);
      }
    }
    return out;
  }

  async stockIn(warehouseId: number | null, productIds: number[]) {
    const out = new Map<number, number>();
    if (!productIds.length) return out;
    const q = this.db('product_details').whereIn('product_id', productIds).groupBy('product_id').select('product_id', this.db.raw('SUM(quantity) as q'));
    if (warehouseId !== null) q.where('store_house_id', warehouseId);
    for (const r of (await q) as Record<string, unknown>[]) out.set(Number(r.product_id), Number(r.q ?? 0));
    return out;
  }

  async compiledComponents(productIds: number[]) {
    const out = new Map<number, Array<{ productId: number; quantity: number }>>();
    if (!productIds.length) return out;
    const rows = await this.db('compiled_products').whereIn('compile_id', productIds).orderBy('id').select('compile_id', 'product_id', 'qyt');
    for (const r of rows as Record<string, unknown>[]) {
      const list = out.get(Number(r.compile_id)) ?? [];
      list.push({ productId: Number(r.product_id), quantity: Number(r.qyt ?? 0) });
      out.set(Number(r.compile_id), list);
    }
    return out;
  }

  // ═══════════════════════ العروض والكوبونات ═══════════════════════

  async discountOffers(date: string): Promise<DiscountOffer[]> {
    const rows = await this.db('offers')
      .whereNull('deleted_at')
      .where('is_active', 1)
      .where((q) => q.whereNull('valid_from').orWhereRaw('DATE(valid_from) <= ?', [date]))
      .where((q) => q.whereNull('valid_to').orWhereRaw('DATE(valid_to) >= ?', [date]))
      .orderBy('id')
      .select('*');
    if (!rows.length) return [];
    const ids = rows.map((r: Record<string, unknown>) => Number(r.id));
    const pivot = async (table: string, column: string) => {
      const m = new Map<number, number[]>();
      for (const r of (await this.db(table).whereIn('offer_id', ids).select('offer_id', column)) as Record<string, unknown>[]) {
        m.set(Number(r.offer_id), [...(m.get(Number(r.offer_id)) ?? []), Number(r[column])]);
      }
      return m;
    };
    const [clients, products, categories] = await Promise.all([pivot('offer_clients', 'client_id'), pivot('offer_products', 'product_id'), pivot('offer_categories', 'category_id')]);
    return rows.map((r: Record<string, unknown>) => {
      const id = Number(r.id);
      const withLegacy = (list: number[], legacy: unknown) => (legacy ? [...list, Number(legacy)] : list);
      return {
        id,
        name: str(r.name),
        type: Number(r.type ?? 1),
        quantity: num(r.quantity),
        discountType: Number(r.discount_type ?? 1),
        discountValue: Number(r.discount_value ?? 0),
        unitType: Number(r.unit_type ?? 1),
        productIds: withLegacy(products.get(id) ?? [], r.product_id),
        categoryIds: withLegacy(categories.get(id) ?? [], r.category_id),
        clientIds: withLegacy(clients.get(id) ?? [], r.client_id),
      };
    });
  }

  async giftOffers(clientId: number, userId: number, today: string): Promise<GiftOffer[]> {
    const rows = await this.db('gift_offers as g')
      .where('g.is_active', 1)
      .where((q) => q.where('g.is_for_all_clients', 1).orWhereExists((s) => s.select(this.db.raw(1)).from('client_gift_offer as cg').whereRaw('cg.gift_offer_id = g.id').where('cg.client_id', clientId)))
      .where((q) => q.where('g.is_for_all_employees', 1).orWhereExists((s) => s.select(this.db.raw(1)).from('employee_gift_offer as eg').whereRaw('eg.gift_id = g.id').where('eg.user_id', userId)))
      .whereNotExists((s) => s.select(this.db.raw(1)).from('excluded_client_gift_offers as x').whereRaw('x.gift_offer_id = g.id').where('x.client_id', clientId))
      .where((q) => q.whereNull('g.start_date').orWhereRaw('DATE(g.start_date) <= ?', [today]))
      .where((q) => q.whereNull('g.end_date').orWhereRaw('DATE(g.end_date) >= ?', [today]))
      .orderBy('g.id')
      .select('g.id', 'g.target_product_id', 'g.min_quantity', 'g.gift_product_id', 'g.gift_quantity');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      targetProductId: num(r.target_product_id),
      minQuantity: Number(r.min_quantity ?? 1),
      giftProductId: num(r.gift_product_id),
      giftQuantity: Number(r.gift_quantity ?? 1),
    }));
  }

  async coupon(code: string): Promise<Coupon | null> {
    const r = await this.db('store_coupons').whereRaw('LOWER(code) = ?', [code.toLowerCase()]).orderBy('id').first();
    if (!r) return null;
    return {
      id: Number(r.id),
      code: String(r.code),
      type: r.type === 'fixed' || r.type === 'free_shipping' ? r.type : 'percentage',
      value: Number(r.value ?? 0),
      minOrderAmount: num(r.min_order_amount),
      maxDiscount: num(r.max_discount),
      usageLimit: num(r.usage_limit),
      usageLimitPerUser: num(r.usage_limit_per_user),
      applicableProducts: idList(r.applicable_products),
      applicableCategories: idList(r.applicable_categories),
      excludedProducts: idList(r.excluded_products),
      applicableClients: idList(r.applicable_clients),
      firstOrderOnly: bool(r.is_first_order_only),
      startDate: str(r.start_date),
      endDate: str(r.end_date),
      isActive: bool(r.is_active),
    };
  }

  async couponUsageCount(couponId: number, clientId: number | null) {
    const q = this.db('store_coupon_usages').where('coupon_id', couponId);
    if (clientId) q.where('client_id', clientId);
    const [{ c }] = await q.count<{ c: number }[]>({ c: '*' });
    return Number(c);
  }

  async clientHasInvoices(clientId: number) {
    return Boolean(await this.db('invoices').where('client_id', clientId).whereNull('voided_at').first('id'));
  }

  async productsInCategories(productIds: number[], categoryIds: number[]) {
    if (!productIds.length || !categoryIds.length) return false;
    return Boolean(await this.db('products').whereIn('id', productIds).whereIn('category_id', categoryIds).first('id'));
  }

  // ═══════════════════════ العميل ═══════════════════════

  async client(id: number) {
    const r = await this.db('clients as c').leftJoin('neighborhoods as n', 'n.client_id', 'c.id').where('c.id', id).first('c.id', 'c.trade_name', 'c.code', 'c.branch_id', 'c.employee_id', 'n.region_id');
    return r ? { id: Number(r.id), tradeName: str(r.trade_name), code: str(r.code), branchId: num(r.branch_id), employeeId: num(r.employee_id), regionGroupId: num(r.region_id) } : null;
  }

  async clientLedgerAccount(clientId: number, tx?: Tx) {
    const r = await ledger(conn(this.db, tx)('accounts').where('client_id', clientId)).orderBy('id').first('id', 'name', 'balance');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), balance: Number(r.balance ?? 0) } : null;
  }

  async clientCreditLimit(clientId: number) {
    const r = await this.db('credit_limit').where('client_id', clientId).orderBy('id').first('value');
    return r ? Number(r.value ?? 0) : 0;
  }

  /** مديونيّات الذمم وحدها (لا المحافظ) — الويب يجمع المحفظة معها */
  private async debtOf(clientQuery: (q: Knex.QueryBuilder) => void) {
    const q = ledger(this.db('accounts')).whereIn('client_id', (s) => {
      s.select('c.id').from('clients as c');
      clientQuery(s);
    });
    const r = await q.sum<{ s: number | null }[]>({ s: 'balance' }).first();
    return Number((r as { s?: number | null } | undefined)?.s ?? 0);
  }

  async branchCredit(branchId: number) {
    const b = await this.db('branches').where('id', branchId).first('credit_limit');
    const limit = Number(b?.credit_limit ?? 0);
    return { limit, debt: limit > 0 ? await this.debtOf((s) => s.where('c.branch_id', branchId)) : 0 };
  }

  async regionGroupCredit(groupId: number) {
    const b = await this.db('branches').where('id', groupId).first('credit_limit');
    const limit = Number(b?.credit_limit ?? 0);
    return { limit, debt: limit > 0 ? await this.debtOf((s) => s.join('neighborhoods as n', 'n.client_id', 'c.id').where('n.region_id', groupId)) : 0 };
  }

  async employeeCredit(employeeId: number) {
    const e = await this.db('employees').where('id', employeeId).first('credit_limit');
    const limit = Number(e?.credit_limit ?? 0);
    return { limit, debt: limit > 0 ? await this.debtOf((s) => s.where('c.employee_id', employeeId)) : 0 };
  }

  async clientWalletBalance(clientId: number) {
    const r = await this.db('accounts').where('client_id', clientId).where('type_accont', 'client_wallet').orderBy('id').first('balance');
    return r ? Number(r.balance ?? 0) : 0;
  }

  async clientWalletAccount(clientId: number, tx?: Tx) {
    const q = conn(this.db, tx)('accounts').where('client_id', clientId).where('type_accont', 'client_wallet').orderBy('id');
    const r = await (tx ? q.forUpdate() : q).first('id', 'balance');
    return r ? { id: Number(r.id), balance: Number(r.balance ?? 0) } : null;
  }

  // ═══════════════════════ الفواتير ═══════════════════════

  private base(db: Knex) {
    return db('invoices as i')
      .leftJoin('clients as c', 'c.id', 'i.client_id')
      .leftJoin('branches as b', 'b.id', 'i.branch_id')
      .leftJoin('employees as e', 'e.id', 'i.employee_id')
      .leftJoin('users as u', 'u.id', 'i.created_by');
  }

  async invoicePage(f: InvoiceListFilters, page: number, perPage: number) {
    const q = this.db('invoices as i').whereIn('i.type', f.types ?? ['normal', 'pos', 'online']);

    // `scopeSalesDocuments()` — الفرع إن وُجد، وإلا المنشئ أو الموظف
    const { branchIds, userIds, employeeIds } = f.scope;
    if (branchIds !== null) q.whereIn('i.branch_id', branchIds.length ? branchIds : [0]);
    else if (userIds !== null) {
      q.where((w) => w.whereIn('i.created_by', userIds.length ? userIds : [0]).orWhereIn('i.employee_id', employeeIds && employeeIds.length ? employeeIds : [0]));
    }
    if (f.headerBranchIds !== null) q.where((w) => w.whereIn('i.branch_id', f.headerBranchIds as number[]).orWhereNull('i.branch_id'));

    if (f.clientId !== undefined) q.where('i.client_id', f.clientId);
    if (f.invoiceNumber) {
      const term = f.invoiceNumber;
      q.where((w) => {
        w.where('i.code', 'like', likeTerm(term));
        if (/^\d+$/.test(term)) w.orWhere('i.id', Number(term));
      });
    }
    if (f.currency !== null) {
      if (f.currency !== f.defaultCurrency) q.where('i.currency', f.currency);
      else q.where((w) => w.where('i.currency', f.currency as string).orWhereNull('i.currency').orWhere('i.currency', ''));
    }
    if (f.branchIds) q.where((w) => w.whereIn('i.branch_id', f.branchIds as number[]).orWhereNull('i.branch_id'));
    if (f.paymentStatus !== undefined) q.where('i.payment_status', f.paymentStatus);
    if (f.item) q.whereExists((s) => s.select(this.db.raw(1)).from('invoice_items as it').whereRaw('it.invoice_id = i.id').where('it.item', 'like', likeTerm(f.item as string)));
    if (f.totalFrom !== undefined) q.where('i.grand_total', '>=', f.totalFrom);
    if (f.totalTo !== undefined) q.where('i.grand_total', '<=', f.totalTo);
    q.whereBetween('i.invoice_date', [f.start, f.end]);
    for (const [from, to] of f.closedRanges) {
      const after = new Date(`${to}T00:00:00Z`);
      after.setUTCDate(after.getUTCDate() + 1);
      const afterDay = after.toISOString().slice(0, 10);
      q.where((w) => w.where('i.invoice_date', '<', from).orWhere('i.invoice_date', '>=', afterDay));
    }
    if (f.createdBy !== undefined) q.where('i.created_by', f.createdBy);
    if (f.employeeId !== undefined) q.where('i.employee_id', f.employeeId);
    if (f.dueState) {
      q.whereNotNull('i.payment_terms').where('i.payment_terms', '>', 0).whereNotNull('i.issue_date').whereNull('i.voided_at');
      if (f.dueState !== 'has_terms') {
        q.whereRaw('(COALESCE(i.due_value, 0) - COALESCE(i.returned_payment, 0)) >= 0.005');
        const expr = 'DATE_ADD(i.issue_date, INTERVAL CAST(i.payment_terms AS UNSIGNED) DAY)';
        if (f.dueState === 'overdue') q.whereRaw(`${expr} < CURDATE()`);
        else q.whereRaw(`${expr} >= CURDATE()`).whereRaw(`${expr} <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
      }
    }

    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'i.id' });
    const ids = (await q.clone().orderBy('i.created_at', 'desc').orderBy('i.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('i.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c) };
    const rows = await this.base(this.db).whereIn('i.id', ids).orderBy('i.created_at', 'desc').orderBy('i.id', 'desc').select(INVOICE_COLUMNS);
    return { rows: rows.map(mapInvoice), total: Number(c) };
  }

  async invoice(id: number, tx?: Tx) {
    const r = await this.base(conn(this.db, tx)).where('i.id', id).first(INVOICE_COLUMNS);
    return r ? mapInvoice(r) : null;
  }

  async invoiceItems(invoiceId: number): Promise<InvoiceItemRow[]> {
    return this.documentItems('invoice_id', invoiceId);
  }

  async creditNoteItems(creditNoteId: number): Promise<InvoiceItemRow[]> {
    return this.documentItems('credit_note_id', creditNoteId);
  }

  async quoteItems(quoteId: number): Promise<InvoiceItemRow[]> {
    return this.documentItems('quotation_id', quoteId);
  }

  private async documentItems(column: 'invoice_id' | 'credit_note_id' | 'quotation_id', id: number): Promise<InvoiceItemRow[]> {
    const rows = await this.db('invoice_items as it').leftJoin('store_houses as sh', 'sh.id', 'it.store_house_id').where(`it.${column}`, id).orderBy('it.id').select('it.*', 'sh.name as store_house_name');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      productId: num(r.product_id),
      item: String(r.item ?? ''),
      description: str(r.description),
      unitName: str(r.unit_name),
      productUnitId: num(r.product_unit_id),
      storeHouseId: num(r.store_house_id),
      storeHouseName: str(r.store_house_name),
      quantity: Number(r.quantity ?? 0),
      quantityInBaseUnit: num(r.quantity_in_base_unit),
      conversionFactor: Number(r.conversion_factor ?? 1),
      unitPrice: Number(r.unit_price ?? 0),
      discount: Number(r.discount ?? 0),
      discountType: Number(r.discount_type ?? 1),
      tax1: Number(r.tax_1 ?? 0),
      tax1Id: num(r.tax_1_id),
      tax2: Number(r.tax_2 ?? 0),
      tax2Id: num(r.tax_2_id),
      total: Number(r.total ?? 0),
      unitCostAtSale: num(r.unit_cost_at_sale),
    }));
  }

  async invoicePayments(invoiceId: number) {
    const rows = await this.db('payments_process').where('invoice_id', invoiceId).where('type', 'client payments').orderBy('id').select('id', 'amount', 'payment_date', 'reference_number', 'Payment_method as method', 'created_at');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), amount: Number(r.amount ?? 0), paymentDate: str(r.payment_date), reference: str(r.reference_number), method: num(r.method), createdAt: str(r.created_at) }));
  }

  async returnedInvoiceIds(invoiceIds: number[]) {
    if (!invoiceIds.length) return new Set<number>();
    const rows = await this.db('invoices').where('type', 'returned').whereIn('reference_number', invoiceIds.map(String)).pluck('reference_number');
    return new Set(rows.map(Number));
  }

  async activeCreditNoteInvoiceIds(invoiceIds: number[]) {
    if (!invoiceIds.length) return new Set<number>();
    const rows = await this.db('credit_notifications').whereIn('invoice_id', invoiceIds).whereNotIn('status', [0, 5]).pluck('invoice_id');
    return new Set(rows.map(Number));
  }

  async closedRanges(): Promise<Array<[string, string]>> {
    const settings = await this.db('accounting_period_settings').first('enforce_lock').catch(() => null);
    if (!settings || !bool(settings.enforce_lock)) return [];
    const day = (v: unknown) => String(v).slice(0, 10);
    const periods = await this.db('accounting_periods').whereIn('status', ['closed', 'locked']).select('start_date', 'end_date');
    const years = await this.db('fiscal_years').where('status', 'closed').select('start_date', 'end_date');
    const ranges: Array<[string, string]> = [...periods, ...years].map((r: Record<string, unknown>) => [day(r.start_date), day(r.end_date)]);
    if (!ranges.length) return [];

    // `coalesce()` — دمج المتداخل والمتلاصق
    ranges.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    const merged: Array<[string, string]> = [ranges.shift() as [string, string]];
    for (const [from, to] of ranges) {
      const last = merged[merged.length - 1];
      const next = new Date(`${last[1]}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (from <= next.toISOString().slice(0, 10)) {
        if (to > last[1]) last[1] = to;
        continue;
      }
      merged.push([from, to]);
    }
    return merged;
  }

  async fiscalYearFor(date: string) {
    const y = await this.db('fiscal_years').whereRaw('DATE(start_date) <= ?', [date]).whereRaw('DATE(end_date) >= ?', [date]).first('start_date', 'end_date');
    if (y) return { start: String(y.start_date).slice(0, 10), end: String(y.end_date).slice(0, 10) };
    const p = await this.db('accounting_periods').whereRaw('DATE(start_date) <= ?', [date]).whereRaw('DATE(end_date) >= ?', [date]).first('start_date', 'end_date');
    return p ? { start: String(p.start_date).slice(0, 10), end: String(p.end_date).slice(0, 10) } : null;
  }

  /** `BusinessInfo` — بيانات المنشأة ثم مرآة «معلومات الحساب» في العملاء ثم اسم التطبيق */
  async businessInfo() {
    const data = await this.db('business_data').orderBy('id').first('business_name', 'tax_number').catch(() => null);
    const setting = await this.db('account_settings').orderBy('id').first('user_id').catch(() => null);
    const mirror = setting?.user_id ? await this.db('clients').where('user_id', setting.user_id).orderBy('id').first('trade_name', 'first_name', 'last_name', 'tax_number') : null;
    const pick = (...values: unknown[]) => {
      for (const v of values) if (v !== null && v !== undefined && String(v).trim() !== '') return String(v);
      return '';
    };
    return {
      name: pick(data?.business_name, mirror?.trade_name, `${mirror?.first_name ?? ''} ${mirror?.last_name ?? ''}`.trim(), this.appName),
      taxNumber: pick(data?.tax_number, mirror?.tax_number),
    };
  }

  async openWorkspaceClientIds(userId: number, today: string) {
    const rows = await this.db('visits')
      .where('employee_id', userId)
      .whereRaw('DATE(visit_date) = ?', [today])
      .whereNull('departure_time')
      .where((q) => q.where('recording_method', 'manual').orWhereNotNull('started_at'))
      .pluck('client_id');
    return [...new Set(rows.map(Number).filter(Boolean))];
  }

  async allWarehouseIds() {
    return (await this.db('store_houses').orderBy('id').pluck('id')).map(Number);
  }
}
