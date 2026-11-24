/** أنواع وحدة المخزون — صفوف القوائم كما تُعرض في التطبيق */

export interface ProductRow {
  id: number;
  name: string;
  barcode: string | null;
  categoryName: string | null;
  status: string;
  type: string;
  salePrice: number | null;
  lowStockThreshold: number;
  /** إجمالي الكمية في المستودعات المرئية لهذا المستخدم؛ null = المنتج بلا تتبّع مخزون */
  quantity: number | null;
}

export interface WarehouseRow {
  id: number;
  name: string;
  status: string;
  isMain: boolean;
  branchId: number | null;
}

export interface PermitRow {
  id: number;
  number: string | null;
  /** 1 إضافة، 2 صرف، 3 تحويل، 4 رصيد افتتاحي */
  permissionType: number | null;
  permissionDate: string | null;
  status: string;
  storeHouseName: string | null;
  fromStoreHouseName: string | null;
  toStoreHouseName: string | null;
  grandTotal: number | null;
}

export interface AdjustmentRow {
  id: number;
  referenceNumber: string | null;
  inventoryTime: string | null;
  status: string;
  type: string;
  storeHouseName: string | null;
  note: string | null;
}

/** نطاق رؤية المخزون: فرعٌ (متاجر الفرع) وتخصيصُ موظفٍ (default_warehouses) — كلاهما يُضيَّقان معاً لا يُستبدل أحدهما بالآخر */
export interface StockScope {
  /** معرّفات المستودعات المسموحة؛ null = بلا قيد (data_scope_all أو بلا فرع/تخصيص) */
  warehouseIds: number[] | null;
  /** معرّفات المستخدمين المنشئين المسموحة (لأذون الصرف والجرد)؛ null = بلا قيد */
  creatorIds: number[] | null;
}

export interface StockListQuery {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
}

export interface StockOverviewFigures {
  productsTotal: number | null;
  warehousesTotal: number | null;
  permitsPending: number | null;
  adjustmentsOpen: number | null;
}
