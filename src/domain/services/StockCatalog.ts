import { CatalogGroupDef, findCatalogItem, resolveCatalogSections } from './catalogKit';
export type { AccessContext } from './catalogKit';

/**
 * أقسام وحدة المخزون — ترجمة القائمة الجانبية في الويب (`Modules/Stock/resources/views/layouts/sidebar.blade.php`)
 * بترتيبها وصلاحياتها نفسها، وميزات الباقة من `App\Constants\planFeatures\StockPlanFeatures`
 * (الكشف المخزني يتبع `stock_storehouses` كما في الويب). ما لا منفذ له في الـ API بعد (الوحدات، تتبّع
 * المنتجات، الإعدادات، التقارير، التصنيع) غير مُدرج.
 */

export type StockSectionKey = 'overview' | 'products' | 'warehouses' | 'permits' | 'adjustments' | 'priceLists' | 'statement';

const STOCK_GROUPS: Array<CatalogGroupDef<StockSectionKey>> = [
  {
    key: 'home',
    title: { ar: 'الرئيسية', en: 'Home' },
    registryKey: null,
    items: [{ key: 'overview', title: { ar: 'نظرة عامة', en: 'Overview' }, icon: 'layout-dashboard', permissions: ['stock.'], planFeature: null }],
  },
  {
    key: 'stock',
    title: { ar: 'المخزون', en: 'Stock' },
    registryKey: 'inventory_management',
    items: [
      { key: 'products', title: { ar: 'المنتجات', en: 'Products' }, icon: 'package', permissions: ['stock.products.view'], planFeature: 'stock_products', createPermission: 'stock.products.edit' },
      { key: 'permits', title: { ar: 'أذون الصرف والإضافة', en: 'Stock permits' }, icon: 'boxes', permissions: ['stock.permits.view'], planFeature: 'stock_warehouse_permits', createPermission: ['stock.permits.create_addition', 'stock.permits.create_disbursement', 'stock.permits.create_transfer', 'stock.permits.create_opening'] },
      { key: 'priceLists', title: { ar: 'قوائم الأسعار', en: 'Price lists' }, icon: 'book-open', permissions: ['stock.price_lists.view'], planFeature: 'stock_price_lists', createPermission: 'stock.price_lists.create' },
      { key: 'warehouses', title: { ar: 'المستودعات', en: 'Warehouses' }, icon: 'warehouse', permissions: ['stock.warehouses.view'], planFeature: 'stock_storehouses', createPermission: 'stock.warehouses.create' },
      { key: 'adjustments', title: { ar: 'الجرد والتسويات', en: 'Inventory adjustments' }, icon: 'git-merge', permissions: ['stock.adjustments.view'], planFeature: 'stock_inventory_adjustment' },
      { key: 'statement', title: { ar: 'الكشف المخزني', en: 'Warehouse statement' }, icon: 'book', permissions: ['stock.reports.employee_statement'], planFeature: 'stock_storehouses' },
    ],
  },
];

export function findStockItem(key: string) {
  return findCatalogItem(STOCK_GROUPS, key);
}

export function resolveStockSections(ctx: import('./catalogKit').AccessContext) {
  return resolveCatalogSections(STOCK_GROUPS, ctx);
}

export type StockGroup = ReturnType<typeof resolveStockSections>[number];
