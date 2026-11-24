import { CatalogGroupDef, findCatalogItem, resolveCatalogSections } from './catalogKit';
export type { AccessContext } from './catalogKit';

/**
 * أقسام وحدة المبيعات — ترجمة القائمة الجانبية في الويب (`Modules/Sales/resources/views/layouts/sidebar.blade.php`)
 * لكل ما له منفذٌ في `/api/v1/sales/*`: الفواتير، عروض الأسعار، أوامر البيع، الإشعارات الدائنة،
 * المرتجعات، سندات القبض، تبديل البضاعة، الإقفال اليومي، أهدافي، عمولاتي، وتقرير المدفوعات حسب الموظف.
 *
 * الحرّاس كما في الويب: صلاحية الدور، ثمّ مفتاح «إدارة المبيعات» في شاشة التطبيقات (المجموعات كلّها
 * داخل `$appOn('sales')`)، ثمّ ميزة الباقة (`SalesPlanFeatures`) — الخارج عن الباقة يُقفَل ولا يُخفى.
 *
 * ما لا يُحسم هنا: مفتاحا «إعدادات الفواتير» (`disable_quotes`، `enable_sales_orders`) ليسا في
 * `AccessContext`؛ المنفذ نفسه يردّ `403 DOCUMENT_DISABLED` والتطبيق يعرض الرسالة.
 * و«الإقفال اليومي» بلا قفل باقةٍ في شريط الويب، فلا قفل له هنا (المنفذ يفحص `dashboard|reports`).
 * وخارج النطاق (بلا منفذ): الفواتير الدورية، الأقساط، إعدادات المبيعات، تقارير المبيعات العامة.
 */

export type SalesSectionKey =
  | 'overview'
  | 'invoices'
  | 'quotes'
  | 'sales_orders'
  | 'credit_notes'
  | 'returns'
  | 'payments'
  | 'exchanges'
  | 'daily_closing'
  | 'reps_performance'
  | 'my_targets'
  | 'my_commissions'
  | 'payments_report';

const SALES_GROUPS: Array<CatalogGroupDef<SalesSectionKey>> = [
  {
    key: 'home',
    title: { ar: 'الرئيسية', en: 'Home' },
    registryKey: 'sales',
    items: [{ key: 'overview', title: { ar: 'نظرة عامة', en: 'Overview' }, icon: 'layout-dashboard', permissions: ['sales.dashboard.view'], planFeature: 'dashboard' }],
  },
  {
    key: 'sales',
    title: { ar: 'المبيعات', en: 'Sales' },
    registryKey: 'sales',
    items: [
      { key: 'invoices', title: { ar: 'فواتير المبيعات', en: 'Invoices' }, icon: 'file-plus', permissions: ['sales.invoices.view'], planFeature: 'invoices', createPermission: 'sales.invoices.create' },
      { key: 'quotes', title: { ar: 'عروض الأسعار', en: 'Quotes' }, icon: 'file-minus', permissions: ['sales.quotes.view'], planFeature: 'quotes', createPermission: 'sales.quotes.create' },
      { key: 'sales_orders', title: { ar: 'أوامر البيع', en: 'Sales orders' }, icon: 'shopping-cart', permissions: ['sales.sales_orders.view'], planFeature: 'quotes', createPermission: 'sales.sales_orders.create' },
      { key: 'credit_notes', title: { ar: 'إشعارات دائنة', en: 'Credit notes' }, icon: 'book-open', permissions: ['sales.credit_notes.view'], planFeature: 'credit_notes', createPermission: 'sales.credit_notes.create' },
      { key: 'returns', title: { ar: 'مرتجعات المبيعات', en: 'Sales returns' }, icon: 'arrow-down-left', permissions: ['sales.returns.view'], planFeature: 'return_invoices' },
      { key: 'payments', title: { ar: 'سندات قبض العملاء', en: 'Client receipts' }, icon: 'landmark', permissions: ['sales.payments.view'], planFeature: 'payments', createPermission: 'sales.payments.create' },
      { key: 'exchanges', title: { ar: 'تبديل البضاعة', en: 'Product exchanges' }, icon: 'git-merge', permissions: ['sales.exchanges.view'], planFeature: 'product_exchanges', createPermission: 'sales.exchanges.create' },
    ],
  },
  {
    key: 'performance',
    title: { ar: 'الإقفال والأداء', en: 'Closing & performance' },
    registryKey: 'sales',
    items: [
      { key: 'daily_closing', title: { ar: 'الإقفال اليومي', en: 'Daily closing' }, icon: 'book', permissions: ['sales.daily_closing.view'], planFeature: null, createPermission: ['sales.daily_closing.create', 'sales.daily_closing.auto_close', 'sales.daily_closing.review'] },
      // «أداء المندوبين» — شاشة الويب `dashboard.reps` بصلاحية لوحة المبيعات وميزتها
      { key: 'reps_performance', title: { ar: 'أداء المندوبين', en: 'Reps performance' }, icon: 'users', permissions: ['sales.dashboard.view'], planFeature: 'dashboard' },
      // «أهدافي» بلا صلاحيةٍ خاصة في المنفذ — تكفي أيُّ صلاحيةٍ في المبيعات، وميزة الباقة `target_settings`
      { key: 'my_targets', title: { ar: 'أهدافي', en: 'My targets' }, icon: 'target', permissions: ['sales.'], planFeature: 'target_settings' },
      { key: 'my_commissions', title: { ar: 'عمولاتي', en: 'My commissions' }, icon: 'arrow-up-right', permissions: ['sales.commissions.view'], planFeature: null },
      { key: 'payments_report', title: { ar: 'المدفوعات حسب الموظف', en: 'Payments by employee' }, icon: 'users', permissions: ['sales.reports.payments_by_employee'], planFeature: 'reports' },
    ],
  },
];

export function findSalesItem(key: string) {
  return findCatalogItem(SALES_GROUPS, key);
}

export function resolveSalesSections(ctx: import('./catalogKit').AccessContext) {
  return resolveCatalogSections(SALES_GROUPS, ctx);
}

export type SalesGroup = ReturnType<typeof resolveSalesSections>[number];
