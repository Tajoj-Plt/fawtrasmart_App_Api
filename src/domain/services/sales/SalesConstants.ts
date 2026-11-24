/**
 * مفردات المبيعات المشتركة مع الويب — `SalesPlanFeatures`، حالات الدفع،
 * أنواع المراجع، وأقسام الترقيم. الأسماء كما تُخزَّن في الجداول.
 */

/** مفتاح التطبيق في «شاشة التطبيقات» (`ApplicationRegistry`) */
export const SALES_MODULE = { key: 'sales', label: 'إدارة المبيعات' };

/** ميزات الباقة — `SalesPlanFeatures` */
export const SALES_PLAN = {
  invoices: 'invoices',
  quotes: 'quotes',
  returns: 'return_invoices',
  creditNotes: 'credit_notes',
  payments: 'payments',
  bulkPayments: 'bulk_payments',
  exchanges: 'product_exchanges',
  exchangeReasons: 'exchange_reasons',
  installments: 'installments',
  dashboard: 'dashboard',
  reports: 'reports',
} as const;

/** حدود الاستخدام — `SalesPlanFeatures::limitOf()` */
export const SALES_LIMITS = {
  invoices: 'sales_invoices',
  quotes: 'quotes',
  returns: 'return_invoices',
  creditNotes: 'credit_notes',
  payments: 'sales_payments',
  exchanges: 'product_exchanges',
} as const;

export const SALES_PERMISSIONS = {
  invoicesView: 'sales.invoices.view',
  invoicesCreate: 'sales.invoices.create',
  invoicesPrint: 'sales.invoices.print',
  invoicesBypassLocation: 'sales.invoices.bypass_location',
  invoicesViewAssignedClients: 'sales.invoices.view_assigned_clients',
  debtClient: 'Issue_an_invoice_to_a_customer_who_has_a_debt',
  paymentsView: 'sales.payments.view',
  paymentsCreate: 'sales.payments.create',
  paymentsBulk: 'sales.payments.bulk',
  paymentsPrint: 'sales.payments.print',
  paymentsViewAssignedClients: 'sales.payments.view_assigned_clients',
} as const;

/** `payments_process.payment_status` كما تعرضه شاشة المدفوعات */
export const RECEIPT_STATUS_LABELS: Record<number, string> = {
  1: 'مكتمل',
  2: 'غير مكتمل',
  3: 'مسودة',
  4: 'تحت المراجعة',
  5: 'فاشلة',
};

/** `SalesPaymentController::LOG_MODULE` */
export const SALES_PAYMENT_LOG_MODULE = 'SalesPayments';

/** `invoices.payment_status` */
export const PAYMENT_STATUS = { paid: 1, partial: 2, unpaid: 3, review: 4, failed: 5 } as const;

export const PAYMENT_STATUS_LABELS: Record<number, string> = {
  1: 'مكتملة',
  2: 'غير مكتملة',
  3: 'غير مدفوعة',
  4: 'تحت المراجعة',
  5: 'فاشلة',
};

/** أنواع فواتير البيع — المرتجع `returned` مستندٌ مستقل */
export const SALE_TYPES = ['normal', 'pos', 'online'] as const;

/** `ReferenceType` في قيود المبيعات */
export const SALES_REFERENCE = {
  invoice: 'SI',
  collection: 'REC',
  salesReturn: 'SR',
  creditNote: 'CN',
} as const;

/** أقسام «الترقيم المتسلسل» */
export const SALES_SECTIONS = {
  invoice: 'invoice',
  payment: 'invoice-payment',
  returnInvoice: 'return-invoice',
  creditNote: 'credit-note',
} as const;

/** «سجلّ النشاط» — `InvoicesController::LOG_MODULE` */
export const SALES_LOG_MODULE = 'SalesInvoices';

/** مصدر إذن المخزون لفاتورة البيع وإضافة المجمَّع الفوري */
export const SALES_PERMIT_SOURCE = 7;
export const WAREHOUSE_ADD_SOURCE = 1;
/** `PermissionSources` — صرف مخزني، مرتجع مبيعات، إشعار دائن مبيعات */
export const WAREHOUSE_DISBURSEMENT_SOURCE = 2;
export const SALES_RETURN_SOURCE = 8;
export const CREDIT_NOTE_SOURCE = 9;

/** «سجلّ النشاط» للمرتجعات والإشعارات الدائنة */
export const RETURN_LOG_MODULE = 'SalesReturns';
export const CREDIT_NOTE_LOG_MODULE = 'SalesCreditNotes';

export const RETURN_PERMISSIONS = {
  view: 'sales.returns.view',
  create: 'sales.returns.create',
  print: 'sales.returns.print',
  bypassLocation: 'sales.returns.bypass_location',
} as const;

export const CREDIT_NOTE_PERMISSIONS = {
  view: 'sales.credit_notes.view',
  create: 'sales.credit_notes.create',
  cancel: 'sales.credit_notes.cancel',
  print: 'sales.credit_notes.print',
  bypassLocation: 'sales.credit_notes.bypass_location',
} as const;

/** `credit_notifications.status` — 0 و5 ملغى، 3 معتمد */
export const CREDIT_NOTE_STATUS_LABELS: Record<number, string> = { 0: 'ملغي', 1: 'مسودة', 2: 'معلّق', 3: 'معتمد', 4: 'محوَّل إلى فاتورة', 5: 'ملغي' };
