/**
 * مفردات المخزون المشتركة مع الويب — `App\Constants\permissions\PermissionSources`
 * وأنواع الأذون وحالاتها كما تُخزَّن فعلاً في الجداول.
 */

export const PermissionSources = {
  WAREHOUSE_ADD: 1,
  WAREHOUSE_DISBURSEMENT: 2,
  MANUFACTURING_MAIN_PRODUCT: 3,
  MANUFACTURING_DAMAGED_MATERIALS: 4,
  INVENTORY_WITHDRAWN: 5,
  INVENTORY_RECEIVED: 6,
  SALES_INVOICE: 7,
  SALES_RETURN: 8,
  SALES_CREDIT_NOTE: 9,
  PURCHASE_INVOICE: 10,
  PURCHASE_RETURN: 11,
  PURCHASE_DEBIT_NOTE: 12,
  MANUAL_TRANSFER: 13,
  POS_SHIFT_OUTBOUND: 14,
  POS_SHIFT_INBOUND: 15,
  MANUFACTURING_RETURNS: 16,
  MANUFACTURING_DISBURSEMENT: 17,
  WAREHOUSE_WITHDRAWAL: 18,
  INVENTORY_GENERAL: 19,
  PURCHASE_REQUEST: 20,
  CUSTOMER_QUOTATION: 21,
  SALES_ORDER: 22,
  PURCHASE_ORDER: 23,
  INVENTORY_DAMAGE: 24,
  INVENTORY_ADJUSTMENT: 25,
  WAREHOUSE_OPENING_BALANCE: 26,
  PRODUCT_EXCHANGE: 27,
  PRODUCT_EXCHANGE_RETURN: 28,
  REWARD_REDEMPTION: 29,
  PURCHASE_RECEIVING: 30,
} as const;

/** `PermissionSources::getAll()` */
export const PERMISSION_SOURCE_NAMES: Record<number, string> = {
  1: 'اذن إضافة مخزني',
  2: 'اذن صرف مخزني',
  18: 'اذن سحب مخزني',
  3: 'أمر تصنيع المنتج الرئيسي',
  4: 'أمر تصنيع المواد الهالكة',
  16: 'أمر تصنيع البنود المرتجعة',
  17: 'أمر تصنيع لصرف المواد',
  5: 'ورقة جرد منصرف',
  6: 'ورقة جرد وارد',
  19: 'ورقة جرد عام',
  7: 'فاتورة مبيعات',
  9: 'إشعار دائن مبيعات',
  8: 'مرتجع مبيعات',
  10: 'فاتورة مشتريات',
  12: 'إشعار مدين مشتريات',
  11: 'مرتجع مشتريات',
  13: 'تحويل يدوي بين المخازن',
  14: 'تحويل صادر من نقطة البيع',
  15: 'تحويل وارد لنقطة البيع',
  20: 'طلب شراء',
  21: 'عرض سعر للعميل',
  22: 'أمر بيع',
  23: 'أمر شراء',
  24: 'إتلاف مخزون',
  25: 'تسوية مخزنية',
  26: 'رصيد افتتاحي للمخزون',
  27: 'تبديل تالف',
  28: 'ارجاع تبديل تالف',
  29: 'صرف مكافأة',
  30: 'استلام مشتريات',
};

export const sourceName = (id: number | null | undefined) => (id !== null && id !== undefined ? PERMISSION_SOURCE_NAMES[Number(id)] : undefined) ?? 'غير معروف';

/** مصادرٌ لا تدخل متوسط التكلفة — `Product::averageCost()` */
export const COST_EXCLUDED_SOURCES = [13, 14, 15, 7, 8, 9, 2, 18];

/** الأصناف التي لها رصيد — `ProductType::stockedValues()` */
export const STOCKED_PRODUCT_TYPES = ['products', 'compiled'];

/** حالات الإذن كما تُخزَّن (بأخطائها الإملائية التاريخية) */
export const PERMIT_STATUS = { pending: 'pending', approved: 'apporod', rejected: 'rejec' } as const;
export type PermitStatusKey = keyof typeof PERMIT_STATUS;

export const permitStatusKey = (stored: string | null): string | null => {
  const found = (Object.keys(PERMIT_STATUS) as PermitStatusKey[]).find((k) => PERMIT_STATUS[k] === stored);
  return found ?? stored;
};

/** الأنواع الأربعة وصلاحية إنشاء كلٍّ منها — `CREATE_PERMISSION_BY_TYPE` */
export const PERMIT_TYPES: Record<number, { key: string; label: string; permission: string; numberSection: string; source: number }> = {
  1: { key: 'addition', label: 'إذن إضافة', permission: 'stock.permits.create_addition', numberSection: 'warehouse-add', source: PermissionSources.WAREHOUSE_ADD },
  2: { key: 'disbursement', label: 'إذن صرف', permission: 'stock.permits.create_disbursement', numberSection: 'warehouse-dispose', source: PermissionSources.WAREHOUSE_DISBURSEMENT },
  3: { key: 'transfer', label: 'إذن تحويل', permission: 'stock.permits.create_transfer', numberSection: 'transfer-request', source: PermissionSources.MANUAL_TRANSFER },
  4: { key: 'opening', label: 'رصيد افتتاحي', permission: 'stock.permits.create_opening', numberSection: 'warehouse-add', source: PermissionSources.WAREHOUSE_OPENING_BALANCE },
};

/** `StorehouseAccess` — جمهور صلاحية المستودع */
export const AUDIENCE = { ALL: 0, EMPLOYEE: 1, JOB_ROLE: 2, BRANCH: 3 } as const;
export type WarehouseScope = 'view' | 'create_invoices' | 'edit_stock';

export const INVENTORY_MODULE = { key: 'inventory_management', label: 'إدارة المخزون' };

export const STOCK_PLAN = {
  storehouses: 'stock_storehouses',
  permits: 'stock_warehouse_permits',
  priceLists: 'stock_price_lists',
} as const;
