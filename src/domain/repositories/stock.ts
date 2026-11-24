import { Tx } from '../../application/ports';
import { NamedOption } from './clients';

/**
 * عقود وحدة المخزون — جداول الويب نفسها: `store_houses`، `product_details`
 * (رصيد الصنف في المستودع)، `default_warehouses`، `warehouse_permits(_products)`،
 * `price_lists`، `price_list_items`.
 */

export interface WarehouseRow {
  id: number;
  name: string;
  status: string | number | null;
  shippingAddress: string | null;
  branchId: number | null;
  branchName: string | null;
  major: boolean;
  /** أعمدة الصلاحيات الثلاث: [النوع, القيمة] */
  view: [number | null, string | null];
  createInvoices: [number | null, string | null];
  editStock: [number | null, string | null];
}

export interface WarehouseListMeta {
  productsCount: number;
  totalQuantity: number;
  stockValue: number;
  responsibleEmployees: string[];
}

export interface PermitLineMovement {
  permitId: number;
  permissionType: number;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  productId: number;
  quantity: number;
}

export interface StockProductRow {
  id: number;
  name: string;
  barcode: string | null;
  serialNumber: string | null;
  categoryId: number | null;
  purchasePrice: number | null;
  salePrice: number | null;
  status: string | null;
  type: string | null;
}

export interface StatementMovementRow {
  permitId: number;
  permitNumber: string | null;
  permissionDate: string | null;
  permissionSourceId: number | null;
  permissionType: number | null;
  referenceId: number | null;
  referenceType: string | null;
  storeHousesId: number | null;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  details: string | null;
  productId: number;
  quantity: number;
  productName: string | null;
  productCode: string | null;
  userName: string | null;
  clientTradeName: string | null;
  clientCode: string | null;
}

export interface StatementFilters {
  warehouseId: number;
  productId?: number;
  categoryId?: number;
  brandId?: number;
  permissionSourceId?: number;
  startDate?: string | null;
  endDate?: string | null;
}

export interface StockRepository {
  // نطاق المستودعات
  warehouseIdsInBranches(branchIds: number[]): Promise<number[]>;
  defaultWarehouseIds(employeeIds: number[]): Promise<number[]>;
  anyViewRestricted(): Promise<boolean>;
  /** `StorehouseAccess::scopeFor()` — المستودعات التي يسمح جمهورُها لهذا المستخدم */
  audienceWarehouseIds(columns: [string, string], audience: { employeeIds: number[]; roleId: number; branchIds: number[] }): Promise<number[]>;
  employeeBranchId(employeeId: number): Promise<number | null>;

  // المستودعات
  warehousePage(ids: number[] | null, filters: { keywords?: string; status?: string }, page: number, perPage: number): Promise<{ rows: WarehouseRow[]; total: number }>;
  warehouse(id: number): Promise<WarehouseRow | null>;
  /** `order`: الاسم (`accessibleWarehouses()`) أو المعرّف (استعلامٌ بلا ترتيب) */
  warehouseOptions(ids: number[] | null, activeOnly?: boolean, order?: 'name' | 'id'): Promise<NamedOption[]>;
  warehouseNames(ids: number[]): Promise<Map<number, string>>;
  majorWarehouseIds(): Promise<number[]>;
  listMeta(ids: number[]): Promise<Map<number, WarehouseListMeta>>;
  storehouseLogs(id: number): Promise<Array<{ date: string | null; description: string | null; user: string | null }>>;
  warehouseAccount(id: number): Promise<{ id: number; balance: number } | null>;

  // الكميات والحركات
  currentQuantities(warehouseId: number, productId?: number): Promise<Map<number, number>>;
  approvedPermitMovements(warehouseId: number): Promise<PermitLineMovement[]>;
  /** بنود الفواتير من هذا المستودع — مجموعةً بنوع الفاتورة والصنف */
  invoiceQuantities(warehouseId: number, createdBy: number | null): Promise<Array<{ invoiceType: string | null; productId: number; quantity: number }>>;
  products(ids: number[]): Promise<Map<number, StockProductRow>>;
  /** متوسط التكلفة المرجَّح — للمستودع (`averageCostForStorehouse`) أو عامّاً (`averageCost`) */
  averageCosts(productIds: number[], warehouseId: number | null): Promise<Map<number, number>>;
  categories(): Promise<NamedOption[]>;

  // الكشف المخزني
  statementMovements(f: StatementFilters, before?: string): Promise<StatementMovementRow[]>;
  /** `ProductExchangeItem::reason_text` لبند (عملية التبديل، الصنف) — المفتاح `exchangeId_productId` */
  exchangeReasons(pairs: Array<[number, number]>): Promise<Map<string, string>>;
  stockedProductsInWarehouse(warehouseId: number): Promise<Array<{ id: number; name: string; serialNumber: string | null }>>;
  referenceClient(type: 'invoice' | 'credit_note', id: number): Promise<{ tradeName: string | null; code: string | null } | null>;
  lastSalesInvoiceClient(productId: number, beforeDate: string | null): Promise<{ tradeName: string | null; code: string | null } | null>;

  // الفترات
  accountingPeriodFor(date: string): Promise<{ id: number; name: string; startDate: string; endDate: string } | null>;
  defaultPeriodType(): Promise<string>;
}

// ═══════════════════════ الأذون المخزنية ═══════════════════════

export interface PermitRow {
  id: number;
  number: string | null;
  permissionType: number | null;
  permissionDate: string | null;
  status: string | null;
  storeHousesId: number | null;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  permissionSourceId: number | null;
  referenceType: string | null;
  referenceId: number | null;
  subAccount: number | null;
  details: string | null;
  grandTotal: number;
  currency: string | null;
  attachments: string | null;
  rejectionReason: string | null;
  createdBy: number | null;
  createdByName: string | null;
  warehouseName: string | null;
  fromWarehouseName: string | null;
  toWarehouseName: string | null;
}

export interface PermitItemRow {
  id: number;
  productId: number;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** `permitsListQuery()` — النطاق (`scopeToCreator` + `scopeToWarehouseColumns`) ثم `applyFilters()` */
export interface PermitListFilters {
  creatorIds: number[] | null;
  warehouseIds: number[] | null;
  branch?: number;
  keywords?: string;
  permissionType?: number;
  permissionSource?: number;
  warehouse?: number;
  client?: number;
  supplier?: number;
  status?: string;
  /** `null` = كل العملات */
  currency: string | null;
  createdBy?: number;
  product?: number;
  /** `AccountingPeriodFilter::apply` — null بلا قيد · [] بلا فترة · غير ذلك الفترات */
  periodIds: number[] | null;
  fromDate?: string;
  toDate?: string;
}

export interface PermitHeaderWrite {
  permission_type: number;
  permission_date: string;
  sub_account: number | null;
  number: string;
  details: string | null;
  grand_total: number;
  store_houses_id: number | null;
  from_store_houses_id: number | null;
  to_store_houses_id: number | null;
  permission_source_id: number;
  created_by: number;
  accounting_period_id: number | null;
  attachments?: string;
}

export interface PermitLineWrite {
  productId: number;
  quantity: number;
  unitPrice: number;
  total: number;
  stockBefore: number;
  stockAfter: number;
}

export interface StockedProductOption {
  id: number;
  name: string;
  barcode: string | null;
  purchasePrice: number;
  salePrice: number;
}

export interface PermitRepository {
  page(f: PermitListFilters, page: number, perPage: number): Promise<{ rows: PermitRow[]; total: number }>;
  find(id: number, tx?: Tx, lock?: boolean): Promise<PermitRow | null>;
  items(permitId: number, tx?: Tx): Promise<PermitItemRow[]>;
  logs(permitId: number): Promise<Array<{ date: string | null; description: string | null }>>;

  /** الأصناف المخزنية وحدها — `Product::whereIn('type', stockedValues())` */
  stockedProducts(): Promise<StockedProductOption[]>;
  productsByIds(ids: number[]): Promise<Map<number, { id: number; name: string; status: string | null; type: string | null }>>;
  existingWarehouseIds(ids: number[]): Promise<Set<number>>;
  /** `ProductDetails::where(...)->sum('quantity')` */
  stockOf(warehouseId: number | null, productId: number, tx?: Tx): Promise<number>;

  insert(header: PermitHeaderWrite, now: string, tx: Tx): Promise<number>;
  update(id: number, patch: Partial<PermitHeaderWrite> & Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  insertLines(permitId: number, lines: PermitLineWrite[], now: string, tx: Tx): Promise<void>;
  deleteLines(permitId: number, tx: Tx): Promise<void>;
  delete(id: number, tx: Tx): Promise<void>;
  setRejected(id: number, reason: string | null, userId: number, now: string, tx: Tx): Promise<void>;
}

/** `AccountingPeriodSetting` — ضوابط القفل */
export interface PeriodSettings {
  enforceLock: boolean;
  lockBeforeDate: string | null;
  blockUndefinedDates: boolean;
  blockFutureDates: boolean;
  defaultPeriodType: string;
  overridePermission: string | null;
}

export interface PeriodGuardRepository {
  settings(): Promise<PeriodSettings>;
  periodFor(date: string): Promise<{ id: number; name: string; status: string; fiscalYearId: number | null } | null>;
  fiscalYear(id: number): Promise<{ id: number; name: string; status: string } | null>;
  fiscalYearFor(date: string): Promise<{ id: number; name: string; status: string } | null>;
}

/** عدّ الصفوف لحدود الباقة — `UsageReporter::measure()` */
export interface UsageCounter {
  count(table: string, from?: string, to?: string, where?: [string, Array<string | number>]): Promise<number | null>;
}

// ═══════════════════════ الاعتماد والقيود ═══════════════════════

export interface StockRowRef {
  id: number;
  quantity: number;
}

/** حركة الكميات عند الاعتماد وإلغائه — `product_details` والمستندات المرتبطة */
export interface ApprovalRepository {
  /** أوّل صفّ للصنف في المستودع (`->first()`)، مقفولاً للتعديل */
  firstStockRow(warehouseId: number, productId: number, tx: Tx): Promise<StockRowRef | null>;
  createStockRow(warehouseId: number, productId: number, quantity: number, now: string, tx: Tx): Promise<number>;
  addToStockRow(id: number, delta: number, now: string, tx: Tx): Promise<void>;
  setPermitStatus(id: number, status: string, now: string, tx: Tx): Promise<void>;

  purchaseInvoiceForReceiving(id: number, tx: Tx): Promise<{ id: number; receivingStatus: string | null; items: Array<{ productId: number; quantity: number; productName: string | null }> } | null>;
  markInvoiceReceived(id: number, date: string, now: string, tx: Tx): Promise<void>;

  adjustmentHasPendingPermits(adjustmentId: number, tx: Tx): Promise<boolean>;
  markAdjustment(id: number, status: string, adjustedAt: string | null, onlyIfStatus: string | null, now: string, tx: Tx): Promise<void>;
}

export interface LedgerAccount {
  id: number;
  name: string;
  code: string | null;
  parentId: number | null;
  balanceType: string | null;
  balance: number;
}

export interface JournalEntryWrite {
  reference_number: string;
  reference_type: string;
  batch_reference: string | null;
  reference_id: number | null;
  date: string;
  description: string;
  status: number;
  currency: string;
  created_by_employee: number;
  branch_id: number | null;
  employee_id: number | null;
  accounting_period_id: number | null;
  linking_type: 'single';
  client_id?: number | null;
  invoice_id?: number | null;
}

/** دفتر الأستاذ — الحسابات والقيود كما يكتبها `JournalEntry` و`JournalEntryDetail` في الويب */
export interface LedgerRepository {
  settingsMap(): Promise<Map<string, number>>;
  settingName(key: string): Promise<string | null>;
  account(id: number, tx: Tx): Promise<LedgerAccount | null>;
  accountByStorehouse(storehouseId: number, tx: Tx): Promise<LedgerAccount | null>;
  setAccountParent(id: number, parentId: number, now: string, tx: Tx): Promise<void>;
  codesLike(prefix: string, tx: Tx): Promise<string[]>;
  createWarehouseAccount(row: { name: string; code: string; parentId: number; storehouseId: number }, now: string, tx: Tx): Promise<number>;

  childIds(accountId: number, tx: Tx): Promise<number[]>;
  children(accountId: number, tx: Tx): Promise<Array<{ balance: number; balanceType: string | null }>>;
  detailSums(accountId: number, tx: Tx): Promise<{ debit: number; credit: number }>;
  setBalance(id: number, balance: number, now: string, tx: Tx): Promise<void>;

  lastReferenceNumber(type: string, year: string, tx: Tx): Promise<string | null>;
  insertEntry(row: JournalEntryWrite, now: string, tx: Tx): Promise<number>;
  insertDetail(row: { journalEntryId: number; accountId: number; description: string; debit: number; credit: number; isDebit?: boolean }, now: string, tx: Tx): Promise<number>;
  /** القيود التي يُعكس بها اعتماد إذن — غير معكوسة وليست عكسيّة */
  entriesToReverse(permitId: number, tx: Tx): Promise<Array<{ id: number; referenceNumber: string | null; description: string | null }>>;
  details(entryId: number, tx: Tx): Promise<Array<{ accountId: number; description: string | null; debit: number; credit: number }>>;
  markReversed(entryId: number, now: string, tx: Tx): Promise<void>;
  setBatchReference(entryId: number, batch: string, tx: Tx): Promise<void>;
}

// ═══════════════════════ قوائم الأسعار ═══════════════════════

export interface PriceListRow {
  id: number;
  name: string;
  status: number;
  createdAt: string | null;
}

export interface PriceListRepository {
  page(f: { keywords?: string; product?: number; category?: number; brand?: number; status?: number }, page: number, perPage: number): Promise<{ rows: PriceListRow[]; total: number }>;
  find(id: number): Promise<PriceListRow | null>;
  /** `price_list_products()` — الصنف بسعر بيعه، ومعرّف سطر الربط */
  items(listId: number): Promise<Array<{ itemId: number; productId: number; name: string; salePrice: number }>>;
  /** `scopeToProductVisibility()` — null بلا قيد، ومستودعاتٌ أو منشئون */
  visibleProducts(scope: { warehouseIds: number[] | null; creatorIds: number[] | null }, productId?: number): Promise<Array<{ id: number; name: string; salePrice: number }>>;
  productExists(id: number): Promise<boolean>;
  itemExists(id: number): Promise<boolean>;

  insert(row: { name: string; status: number }, now: string, tx: Tx): Promise<number>;
  update(id: number, row: { name: string; status: number }, now: string, tx: Tx): Promise<void>;
  delete(id: number, tx: Tx): Promise<void>;
  addItem(listId: number, productId: number, now: string, tx: Tx): Promise<number>;
  setProductSalePrice(productId: number, price: number, now: string, tx: Tx): Promise<void>;
  deleteItem(id: number, tx: Tx): Promise<void>;
  /** `Logs::create()` مباشرةً كما في الويب — سطرٌ في `logs` بلا سجلّ أحداث */
  log(type: string, typeId: number, description: string, userId: number, now: string, tx: Tx): Promise<void>;
}
