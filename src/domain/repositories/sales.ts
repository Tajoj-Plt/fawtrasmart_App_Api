import { Tx } from '../../application/ports';
import { Coupon, DiscountOffer, GiftOffer } from '../services/sales/PromotionRules';
import { TaxSetting } from '../services/sales/SalesMath';

/**
 * عقود وحدة المبيعات — جداول الويب نفسها: `invoices`، `invoice_items`، `taxs_invoice`،
 * `payments_process`، `sales_invoice_settings`، `offers`، `gift_offers`، `store_coupons`،
 * `credit_limit`، `treasuries`، `payment_methods`، `order_sources`.
 */

/** `sales_invoice_settings` — الأعلام والأرقام */
export interface SalesInvoiceSettingsRow {
  maxDiscountPercent: number | null;
  maxDiscountType: string | null;
  maxDiscountAmount: number | null;
  warehouseSource: string | null;
  flags: Record<string, boolean>;
}

export interface SalesUnitOption {
  /** `product_units.id` — أو `null` لوحدة الصنف حين لا وحدات للمنتج */
  id: number | null;
  categoryUnitId: number | null;
  name: string;
  conversionFactor: number;
  isBaseUnit: boolean;
  isDefault: boolean;
  salePrice: number;
  purchasePrice: number;
  barcode: string | null;
}

export interface SalesProduct {
  id: number;
  name: string;
  barcode: string | null;
  serialNumber: string | null;
  type: string;
  compileType: string | null;
  status: string | null;
  categoryId: number | null;
  salePrice: number;
  purchasePrice: number;
  minSalePrice: number | null;
  tax1: number | null;
  tax2: number | null;
  lowStockAlert: number | null;
  trackInventory: number | null;
  expiryDate: string | null;
  notifyBeforeDays: number | null;
}

export interface TreasuryRow {
  id: number;
  accountId: number | null;
  name: string;
  type: number | null;
  depositPermissions: number | null;
  valueOfDepositPermissions: string | null;
  withdrawPermissions: number | null;
  valueOfWithdrawPermissions: string | null;
}

export interface InvoiceListFilters {
  /** نطاق المستندات — `scopeSalesDocuments()` */
  scope: { branchIds: number[] | null; userIds: number[] | null; employeeIds: number[] | null };
  /** فرع الشريط العلوي وتوابعه (`forBranch`) — يشمل ما لا فرع له */
  headerBranchIds: number[] | null;
  /** أنواع المستند — فواتير البيع افتراضاً، و`returned` للمرتجعات */
  types?: string[];
  clientId?: number;
  invoiceNumber?: string;
  currency: string | null;
  defaultCurrency: string;
  branchIds?: number[];
  paymentStatus?: number;
  item?: string;
  totalFrom?: number;
  totalTo?: number;
  start: string;
  end: string;
  closedRanges: Array<[string, string]>;
  createdBy?: number;
  employeeId?: number;
  dueState?: 'has_terms' | 'overdue' | 'due_soon';
}

export interface InvoiceRow {
  id: number;
  code: string | null;
  type: string | null;
  clientId: number | null;
  clientName: string | null;
  clientCode: string | null;
  branchId: number | null;
  branchName: string | null;
  employeeId: number | null;
  employeeName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  invoiceDate: string | null;
  issueDate: string | null;
  paymentTerms: string | null;
  paymentStatus: number | null;
  isPaid: boolean;
  currency: string | null;
  subtotal: number;
  discountAmount: number;
  couponCode: string | null;
  couponDiscount: number;
  shippingCost: number;
  shippingTax: number;
  taxTotal: number;
  grandTotal: number;
  advancePayment: number;
  dueValue: number;
  returnedPayment: number;
  walletPaidAmount: number;
  notes: string | null;
  qrcode: string | null;
  orderSourceId: number | null;
  voidedAt: string | null;
  createdAt: string | null;
  /** المرتجع: معرّف الفاتورة الأصلية */
  referenceNumber: string | null;
}

export interface InvoiceItemRow {
  id: number;
  productId: number | null;
  item: string;
  description: string | null;
  unitName: string | null;
  productUnitId: number | null;
  storeHouseId: number | null;
  storeHouseName: string | null;
  quantity: number;
  quantityInBaseUnit: number | null;
  conversionFactor: number;
  unitPrice: number;
  discount: number;
  discountType: number;
  tax1: number;
  tax1Id: number | null;
  tax2: number;
  tax2Id: number | null;
  total: number;
  /** التكلفة المجمَّدة عند البيع — بها يُعكس قيد التكلفة في المرتجع */
  unitCostAtSale: number | null;
}

/** قراءات المبيعات — الإعدادات والكتالوج والعروض والعملاء والفواتير */
export interface SalesRepository {
  settings(): Promise<SalesInvoiceSettingsRow>;
  /** `branch_setting('max_discount_percent')` حين يضبطه الفرع نفسه (`own`) */
  branchOwnMaxDiscount(branchId: number): Promise<number | null>;
  taxes(): Promise<TaxSetting[]>;
  paymentMethods(): Promise<Array<{ id: number; name: string; code: string | null; isDefault: boolean }>>;
  /** `PaymentMethod::getDefault()` على الفاتورة، وأوّل «active» على سند القبض */
  defaultInvoicePaymentMethod(): Promise<number>;
  defaultReceiptPaymentMethod(): Promise<number | null>;
  orderSources(): Promise<Array<{ id: number; name: string }>>;
  orderSourceSetting(key: string): Promise<string | null>;
  orderSource(id: number): Promise<{ id: number; name: string } | null>;
  treasuries(): Promise<TreasuryRow[]>;
  treasuryByAccount(accountId: number): Promise<TreasuryRow | null>;
  employeeTreasuryAccountIds(employeeId: number): Promise<number[]>;
  roleName(roleId: number): Promise<string | null>;
  priceLists(): Promise<Array<{ id: number; name: string }>>;
  priceListPrice(priceListId: number, productId: number): Promise<number | null>;

  // الكتالوج
  /** `inStockOnly`: أصنافٌ لها رصيدٌ موجب في المستودع — لا صفّ رصيدٍ صفريّ */
  sellableProducts(warehouseId: number | null, stocklessTypes: string[], search?: string, limit?: number, productIds?: number[], inStockOnly?: boolean): Promise<SalesProduct[]>;
  /** «السماح بالمخزون السالب» في إعدادات المخزون (`general_settings.enable_negative_stock`) */
  negativeStockAllowed(): Promise<boolean>;
  products(ids: number[]): Promise<Map<number, SalesProduct>>;
  unitsFor(products: SalesProduct[]): Promise<Map<number, SalesUnitOption[]>>;
  stockIn(warehouseId: number | null, productIds: number[]): Promise<Map<number, number>>;
  compiledComponents(productIds: number[]): Promise<Map<number, Array<{ productId: number; quantity: number }>>>;

  // العروض والكوبونات
  discountOffers(date: string): Promise<DiscountOffer[]>;
  giftOffers(clientId: number, userId: number, today: string): Promise<GiftOffer[]>;
  coupon(code: string): Promise<Coupon | null>;
  couponUsageCount(couponId: number, clientId: number | null): Promise<number>;
  clientHasInvoices(clientId: number): Promise<boolean>;
  productsInCategories(productIds: number[], categoryIds: number[]): Promise<boolean>;

  // العميل
  client(id: number): Promise<{ id: number; tradeName: string | null; code: string | null; branchId: number | null; employeeId: number | null; regionGroupId: number | null } | null>;
  clientLedgerAccount(clientId: number, tx?: Tx): Promise<{ id: number; name: string; balance: number } | null>;
  clientCreditLimit(clientId: number): Promise<number>;
  branchCredit(branchId: number): Promise<{ limit: number; debt: number }>;
  regionGroupCredit(groupId: number): Promise<{ limit: number; debt: number }>;
  employeeCredit(employeeId: number): Promise<{ limit: number; debt: number }>;
  clientWalletBalance(clientId: number): Promise<number>;
  /** حساب محفظة العميل — مقفولاً داخل المعاملة */
  clientWalletAccount(clientId: number, tx?: Tx): Promise<{ id: number; balance: number } | null>;

  // الفواتير
  invoicePage(f: InvoiceListFilters, page: number, perPage: number): Promise<{ rows: InvoiceRow[]; total: number }>;
  invoice(id: number, tx?: Tx): Promise<InvoiceRow | null>;
  invoiceItems(invoiceId: number): Promise<InvoiceItemRow[]>;
  creditNoteItems(creditNoteId: number): Promise<InvoiceItemRow[]>;
  quoteItems(quoteId: number): Promise<InvoiceItemRow[]>;
  invoicePayments(invoiceId: number): Promise<Array<{ id: number; amount: number; paymentDate: string | null; reference: string | null; method: number | null; createdAt: string | null }>>;
  returnedInvoiceIds(invoiceIds: number[]): Promise<Set<number>>;
  activeCreditNoteInvoiceIds(invoiceIds: number[]): Promise<Set<number>>;
  /** المدَيات المقفلة — `ClosedPeriodRanges::all()` */
  closedRanges(): Promise<Array<[string, string]>>;
  /** السنة المالية أو الفترة التي يقع فيها اليوم — `defaultReportRange()` */
  fiscalYearFor(date: string): Promise<{ start: string; end: string } | null>;
  businessInfo(): Promise<{ name: string; taxNumber: string }>;
  /** `Visit::openWorkspaceClientIdsFor()` — عملاء زيارةٍ مفتوحةٍ اليوم */
  openWorkspaceClientIds(userId: number, today: string): Promise<number[]>;
  allWarehouseIds(): Promise<number[]>;
}

// ═══════════════════════ الكتابة ═══════════════════════

export interface StockRow {
  id: number;
  quantity: number;
}

/** كتابة مستندات المبيعات — الأعمدة كما يكتبها الويب */
export interface SalesWriteRepository {
  insertInvoice(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  updateInvoice(id: number, patch: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  insertItem(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  freezeItemCost(itemId: number, unitCost: number, tx: Tx): Promise<void>;
  insertTaxRows(rows: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void>;
  /** `ModelsLog::insert()` — أسطر «سجلّ النشاط» بلا مراقب */
  insertLogs(rows: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void>;
  /** `notifications::insert()` — تنبيهات المخزون بلا مراقب (لا تُعدّ في حدّ الباقة) */
  insertRawNotifications(rows: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void>;
  insertPayment(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  lastDepositCount(clientId: number, tx: Tx): Promise<number>;
  insertClientRelation(row: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  recordCouponUsage(couponId: number, clientId: number | null, invoiceId: number, discount: number, now: string, tx: Tx): Promise<void>;

  /** أرصدة (صنف، مستودع) مقفلةً حتى نهاية المعاملة — المفتاح `product_warehouse` */
  lockStock(pairs: Array<[number, number]>, tx: Tx): Promise<Map<string, StockRow>>;
  createStockRow(productId: number, warehouseId: number, now: string, tx: Tx): Promise<StockRow>;
  addStock(id: number, delta: number, now: string, tx: Tx): Promise<void>;
  insertPermit(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  insertPermitLine(row: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  permissionSourceExists(id: number, tx: Tx): Promise<boolean>;

  employeeLocation(userId: number, tx?: Tx): Promise<{ id: number; latitude: number | null; longitude: number | null } | null>;
  saveEmployeeLocation(existingId: number | null, userId: number, latitude: number, longitude: number, now: string): Promise<void>;
  insertWalletTransaction(row: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  clientPoint(clientId: number): Promise<{ latitude: number | null; longitude: number | null } | null>;
}

// ═══════════════════════ التحصيل ═══════════════════════

/** فلاتر «مدفوعات العملاء» — `SalesPaymentController::index()` */
export interface PaymentListFilters {
  /** نطاق فواتير السند — `scopeSalesDocuments()` */
  scope: { branchIds: number[] | null; userIds: number[] | null; employeeIds: number[] | null };
  /** `payments_process.employee_id` (= `users.id`) في نطاقه — `null` بلا قيد */
  collectorIds: number[] | null;
  /** «عملائي المُسنَدون»: موظّف المستخدم في `client_employee` */
  assignedEmployeeId: number | null;
  headerBranchIds: number[] | null;
  clientId?: number;
  invoiceNumber?: string;
  reference?: string;
  paymentStatus?: number;
  amountFrom?: number;
  amountTo?: number;
  collectedBy?: number;
  treasuryId?: number;
  paymentMethod?: number;
  branchIds?: number[];
  search?: string;
  start: string;
  end: string;
}

export interface PaymentRow {
  id: number;
  invoiceId: number | null;
  invoiceCode: string | null;
  invoiceCreatedBy: number | null;
  invoiceEmployeeId: number | null;
  invoiceBranchId: number | null;
  clientId: number | null;
  clientName: string | null;
  branchId: number | null;
  branchName: string | null;
  treasuryId: number | null;
  treasuryName: string | null;
  amount: number;
  paymentDate: string | null;
  paymentMethod: number | null;
  paymentMethodName: string | null;
  referenceNumber: string | null;
  notes: string | null;
  paymentStatus: number | null;
  collectorId: number | null;
  collectorName: string | null;
  currency: string | null;
  createdAt: string | null;
}

/** الفاتورة كما يقرؤها التحصيل — مقفلةً داخل المعاملة */
export interface PayableInvoice {
  id: number;
  code: string | null;
  type: string | null;
  clientId: number | null;
  clientName: string | null;
  branchId: number | null;
  createdBy: number | null;
  employeeId: number | null;
  grandTotal: number;
  dueValue: number;
  walletPaidAmount: number;
  /** ما سوّاه مرتجعٌ أو إشعارٌ دائن — المستحقّ الفعليّ `due_value − returned_payment` */
  returnedPayment: number;
  paymentStatus: number | null;
  currency: string | null;
  disablePartialPayment: boolean;
  voidedAt: string | null;
  invoiceDate: string | null;
  createdAt: string | null;
}

export interface SalesPaymentRepository {
  page(f: PaymentListFilters, page: number, perPage: number): Promise<{ rows: PaymentRow[]; total: number; sum: number }>;
  find(id: number): Promise<PaymentRow | null>;
  invoices(ids: number[], tx?: Tx): Promise<PayableInvoice[]>;
  /** `lockForUpdate` — تحصيلان متزامنان على فاتورةٍ واحدة يتتابعان */
  lockInvoices(ids: number[], tx: Tx): Promise<void>;
  /** المقبوض بسندات «client payments» غير الفاشلة */
  paidTotals(invoiceIds: number[], tx?: Tx): Promise<Map<number, number>>;
  installmentInvoiceIds(invoiceIds: number[]): Promise<Set<number>>;
  unpaidInvoiceIds(clientId: number, scope: PaymentListFilters['scope'], headerBranchIds: number[] | null): Promise<number[]>;
  clientAssignedTo(employeeId: number, clientId: number): Promise<boolean>;
  entryFor(invoiceId: number, reference: string | null): Promise<{ id: number; referenceNumber: string | null; date: string | null } | null>;
}

// ═══════════════════════ الإشعارات الدائنة ═══════════════════════

export interface CreditNoteRow {
  id: number;
  creditNumber: string | null;
  clientId: number | null;
  clientName: string | null;
  branchId: number | null;
  branchName: string | null;
  invoiceId: number | null;
  invoiceCode: string | null;
  createdBy: number | null;
  createdByName: string | null;
  employeeId: number | null;
  storeHouseId: number | null;
  creditDate: string | null;
  releaseDate: string | null;
  currency: string | null;
  subtotal: number;
  discountAmount: number;
  totalDiscount: number;
  totalTax: number;
  shippingCost: number;
  shippingTax: number;
  grandTotal: number;
  status: number | null;
  notes: string | null;
  createdAt: string | null;
}

export interface CreditNoteListFilters {
  scope: { branchIds: number[] | null; userIds: number[] | null; employeeIds: number[] | null };
  headerBranchIds: number[] | null;
  clientId?: number;
  number?: string;
  status?: number;
  branchIds?: number[];
  start: string;
  end: string;
}

/** فاتورةٌ مفتوحة للتسوية — `ClientDebtSettlement::openInvoices()` */
export interface SettlementInvoice {
  id: number;
  code: string | null;
  invoiceDate: string | null;
  grandTotal: number;
  dueValue: number;
  walletPaidAmount: number;
  returnedPayment: number;
  paid: number;
}

export interface CreditNoteRepository {
  insert(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  update(id: number, patch: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  find(id: number, tx?: Tx): Promise<CreditNoteRow | null>;
  lock(id: number, tx: Tx): Promise<void>;
  lockInvoice(invoiceId: number, tx: Tx): Promise<void>;
  page(f: CreditNoteListFilters, page: number, perPage: number): Promise<{ rows: CreditNoteRow[]; total: number }>;

  /** فواتير العميل غير المسدَّدة، الأقدم أوّلاً، بلا مرتجعٍ عليها — مقفلةً داخل المعاملة */
  openInvoices(clientId: number, tx?: Tx): Promise<SettlementInvoice[]>;
  /** رصيد حساب الذمّة من القيود (مدين − دائن) */
  ledgerBalance(accountId: number, tx?: Tx): Promise<number>;
  /** القيد الافتتاحي على الحساب (مدين − دائن) */
  openingBalance(accountId: number, tx?: Tx): Promise<number>;
  /** ما سُدِّد من الرصيد الافتتاحي بسندات */
  openingPaid(clientId: number, tx?: Tx): Promise<number>;

  insertLink(entryId: number, invoiceId: number, amount: number, now: string, tx: Tx): Promise<void>;
  links(creditNoteId: number, clientId: number, tx?: Tx): Promise<Array<{ linkId: number; invoiceId: number; amount: number }>>;
  deleteLinks(linkIds: number[], tx: Tx): Promise<void>;
  setLinking(entryId: number, linkingType: string, batch: string | null, tx: Tx): Promise<void>;
  previousBalancePaid(creditNoteId: number, tx?: Tx): Promise<number>;
  deletePreviousBalancePayments(creditNoteId: number, tx: Tx): Promise<void>;
  addReturned(invoiceId: number, delta: number, now: string, tx: Tx): Promise<void>;
  /** قيود الإشعار (لا قيود عكسه) */
  entries(creditNoteId: number, clientId: number, tx: Tx): Promise<Array<{ id: number; currency: string | null }>>;
  deleteTaxRows(creditNoteId: number, tx: Tx): Promise<void>;

  /** الكمية الأساسية المباعة للعميل من الصنف، ناقصاً ما رُدّ منها بمرتجعٍ أو إشعارٍ سارٍ */
  clientReturnable(clientId: number, productId: number): Promise<{ sold: number; returned: number; lastBasePrice: number | null }>;
}

// ═══════════════════════ تبديل البضاعة ═══════════════════════

export interface ExchangeRow {
  id: number;
  code: string | null;
  clientId: number | null;
  clientName: string | null;
  branchId: number | null;
  employeeId: number | null;
  employeeName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  storehouseId: number | null;
  storehouseName: string | null;
  returnStorehouseId: number | null;
  returnStorehouseName: string | null;
  exchangeDate: string | null;
  image: string | null;
  notes: string | null;
  totalValue: number;
  status: number | null;
  createdAt: string | null;
}

export interface ExchangeListFilters {
  scope: { branchIds: number[] | null; userIds: number[] | null; employeeIds: number[] | null };
  headerBranchIds: number[] | null;
  clientId?: number;
  code?: string;
  branch?: number;
  fromDate?: string;
  toDate?: string;
}

export interface ExchangeItemRow {
  id: number;
  productId: number;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  reasonId: number | null;
  reasonName: string | null;
  reasonNotes: string | null;
}

export interface ExchangeRepository {
  reasons(): Promise<Array<{ id: number; name: string; description: string | null }>>;
  reasonIds(): Promise<Set<number>>;
  insert(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  insertItem(row: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  update(id: number, patch: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  /** مجموع كميات التبديل في يومٍ — للموظف أو للعميل */
  dayQuantity(by: 'employee_id' | 'client_id', id: number, date: string, tx?: Tx): Promise<number>;
  employeeLimit(employeeId: number): Promise<{ name: string; limit: number | null } | null>;
  clientLimit(clientId: number): Promise<number | null>;
  globalClientLimit(): Promise<number | null>;
  page(f: ExchangeListFilters, page: number, perPage: number): Promise<{ rows: ExchangeRow[]; total: number }>;
  find(id: number): Promise<ExchangeRow | null>;
  items(id: number): Promise<ExchangeItemRow[]>;
}

// ═══════════════════════ عروض الأسعار وأوامر البيع ═══════════════════════

export interface QuoteRow {
  id: number;
  type: string;
  number: string | null;
  clientId: number | null;
  clientName: string | null;
  branchId: number | null;
  invoiceId: number | null;
  invoiceCode: string | null;
  createdBy: number | null;
  createdByName: string | null;
  employeeId: number | null;
  employeeName: string | null;
  quoteDate: string | null;
  expiryDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  discountType: string | null;
  discountAmount: number;
  shippingCost: number;
  shippingTax: number;
  taxType: string | null;
  subtotal: number;
  totalDiscount: number;
  totalTax: number;
  grandTotal: number;
  status: string;
  notes: string | null;
  createdAt: string | null;
}

export interface QuoteListFilters {
  type: string;
  scope: { branchIds: number[] | null; userIds: number[] | null; employeeIds: number[] | null };
  headerBranchIds: number[] | null;
  clientId?: number;
  number?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
}

export interface QuoteRepository {
  insert(row: Record<string, unknown>, now: string, tx: Tx): Promise<number>;
  update(id: number, patch: Record<string, unknown>, tx: Tx): Promise<void>;
  delete(id: number, docType: string, tx: Tx): Promise<void>;
  find(id: number, type: string, tx?: Tx): Promise<QuoteRow | null>;
  lock(id: number, tx: Tx): Promise<void>;
  /** البنود (`invoice_items.quotation_id`) وضرائبها (`taxs_invoice.type_invoice` = نوع المستند) تُستبدل كلّها */
  replaceItems(id: number, docType: string, items: Array<Record<string, unknown>>, taxRows: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void>;
  page(f: QuoteListFilters, page: number, perPage: number): Promise<{ rows: QuoteRow[]; total: number }>;
}

// ═══════════════════════ الإقفال اليومي ═══════════════════════

export interface ClosingStockProduct {
  productId: number;
  productName: string;
  systemQuantity: number;
}

export interface ClosingRow {
  id: number;
  employeeId: number;
  employeeName: string | null;
  date: string;
  status: string | null;
  notes: string | null;
  reported: Record<string, number>;
  system: Record<string, number>;
  createdAt: string | null;
}

export interface WorkspaceVisit {
  clientId: number;
  minutes: number | null;
  outcome: string | null;
  endedAt: string | null;
  startedAt: string | null;
}

/** `DailyClosingLedger` و`daily_closings` — `userId` هو `users.id` كما في الويب */
export interface DailyClosingRepository {
  accountId(key: string, fallback: number): Promise<number>;
  grossSales(userId: number, from: string, to: string, salesAccount: number): Promise<number>;
  cashSaleInvoices(userId: number, date: string): Promise<Array<{ id: number; grandTotal: number }>>;
  nonCashSettlements(invoiceIds: number[]): Promise<Map<number, number>>;
  receipts(userId: number, from: string, to: string): Promise<number>;
  cashRefunds(userId: number, date: string): Promise<number>;
  returns(userId: number, from: string, to: string): Promise<number>;
  treasuryAndBankAccountIds(cashParent: number, bankParent: number): Promise<number[]>;
  cancelledExpenseRefs(): Promise<string[]>;
  employeeTreasuryId(hrEmployeeId: number): Promise<number | null>;
  expenseEntryIds(userId: number, from: string, to: string, treasuryId: number, cancelledRefs: string[], ownOnly: boolean, treasuryAndBank: number[], salesReturns: number): Promise<number[]>;
  creditSum(entryIds: number[], accountId: number): Promise<number>;
  userEmployeeId(userId: number): Promise<number | null>;
  stockProducts(hrEmployeeId: number): Promise<ClosingStockProduct[]>;
  itineraryRows(userId: number, date: string): Promise<Array<{ clientId: number; visitStatus: string | null; status: string | null; startedAt: string | null; completedAt: string | null; missedReason: string | null; minutes: number | null }>>;
  workspaceVisits(userId: number, date: string, nowSql: string): Promise<Map<number, WorkspaceVisit>>;
  clientNames(ids: number[]): Promise<Map<number, { name: string | null; code: string | null }>>;
  servedClientIds(userId: number, date: string): Promise<Set<number>>;
  existing(userId: number, date: string, tx?: Tx): Promise<number | null>;
  lockUser(userId: number, tx: Tx): Promise<void>;
  insert(row: Record<string, unknown>, stock: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<number>;
  page(f: { employeeId: number | null; fromDate?: string; toDate?: string }, page: number, perPage: number): Promise<{ rows: ClosingRow[]; total: number }>;
  find(id: number): Promise<ClosingRow | null>;
  stockDetails(id: number): Promise<Array<{ productId: number; productName: string | null; reportedQuantity: number; systemQuantity: number }>>;
}

// ═══════════════════════ أهدافي وعمولاتي ═══════════════════════

export type TargetKind = 'sales' | 'collections';

export interface CommissionLine {
  id: number;
  target: { id: number; name: string };
  amount: number;
  fromDate: string | null;
  toDate: string | null;
  paidAt: string | null;
  notes: string | null;
  createdAt: string | null;
}

export interface PerformanceRepository {
  accountId(key: string): Promise<number | null>;
  calculationMethod(kind: TargetKind): Promise<string | null>;
  targetsFor(kind: TargetKind, userId: number): Promise<Array<{ id: number; name: string; period: string | null; commissionPercentage: number; targetAmount: number; tiers: Array<{ achievement: number; commission: number }> }>>;
  accountNet(userId: number, accountId: number, referenceType: string, from: string, to: string, paidInvoicesOnly?: boolean): Promise<number>;
  descendantsOf(parentId: number | null): Promise<number[]>;
  collectionEntries(userId: number, treasuryIds: number[], from: string, to: string): Promise<Array<{ id: number; invoiceId: number | null }>>;
  debitSum(entryIds: number[], accountIds: number[]): Promise<number>;
  weeklyCommissions(hrEmployeeId: number, paidSince: string): Promise<{ pending: CommissionLine[]; paid: CommissionLine[] }>;
  employeeTreasury(hrEmployeeId: number): Promise<{ id: number; name: string; balance: number } | null>;
}

// ═══════════════════════ تقرير المدفوعات حسب الموظف ═══════════════════════

export interface CollectionsReportFilters {
  from: string;
  to: string;
  /** عُقد العملاء (فرعٌ أو شجرة) — `null` بلا قيد */
  nodeIds: number[] | null;
  /** محور الأشخاص: منشئ القيد (`users.id`) — `null` بلا قيد */
  userIds: number[] | null;
  employeeId?: number;
  clientId?: number;
  closedRanges: Array<[string, string]>;
}

export interface CollectionLine {
  entryId: number;
  date: string;
  reference: string | null;
  referenceType: string | null;
  description: string | null;
  clientId: number | null;
  clientName: string | null;
  employeeId: number | null;
  employeeName: string | null;
  treasuryId: number;
  treasuryName: string | null;
  amount: number;
  isReturn: boolean;
}

export interface CollectionsReportRepository {
  cashAccounts(): Promise<number[]>;
  cancelledEntryIds(): Promise<number[]>;
  lines(f: CollectionsReportFilters, cash: number[], cancelled: number[]): Promise<CollectionLine[]>;
}
