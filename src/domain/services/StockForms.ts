import { LocalizedText } from './ModuleCatalog';
import { StockSectionKey } from './StockCatalog';
import { Choice, compact, FormDef as GenericFormDef, num } from './formsKit';

export type FormDef = GenericFormDef<StockSectionKey>;

const t = (ar: string, en: string): LocalizedText => ({ ar, en });

const PERMIT_TYPES: Choice[] = [
  { value: '1', label: t('إضافة', 'Addition') },
  { value: '2', label: t('صرف', 'Disbursement') },
  { value: '3', label: t('تحويل بين مستودعين', 'Transfer') },
  { value: '4', label: t('رصيد افتتاحي', 'Opening balance') },
];

/**
 * نماذج الإنشاء في وحدة المخزون. لا تحتاج مستودعاً عند إنشاء منتج — كل منتجٍ يبدأ برصيدٍ صفريٍّ
 * بلا مستودع (`ProductDetails::create(['quantity'=>0])`)، والكميات الحقيقية تدخل فقط عبر أذون
 * الصرف والإضافة. النوع الرقمي (`serial_number`) والباركود يُولَّدان في الويب؛ الباركود يبقى
 * قابلاً للتحرير هنا لأن الويب يقبل قيمة العميل إن أُرسلت.
 */
export const STOCK_FORMS: Partial<Record<StockSectionKey, FormDef>> = {
  warehouses: {
    section: 'warehouses',
    title: t('مستودع جديد', 'New warehouse'),
    submitLabel: t('حفظ المستودع', 'Save warehouse'),
    createPermission: 'stock.warehouses.create',
    path: '/warehouses',
    optionsForm: 'warehouses',
    fields: [
      { key: 'name', label: t('اسم المستودع', 'Warehouse name'), type: 'text', required: true, maxLength: 255 },
      {
        key: 'status',
        label: t('الحالة', 'Status'),
        type: 'segmented',
        required: true,
        default: 'active',
        choices: [
          { value: 'active', label: t('نشط', 'Active') },
          { value: 'inactive', label: t('غير نشط', 'Inactive') },
          { value: 'stopped', label: t('متوقف', 'Stopped') },
        ],
      },
      { key: 'branch_id', label: t('الفرع (اختياري)', 'Branch (optional)'), type: 'select', optionsKey: 'branch_id' },
    ],
    toPayload: (v) => compact({ name: v.name, status: v.status ?? 'active', branch_id: v.branch_id }),
  },

  products: {
    section: 'products',
    title: t('منتج جديد', 'New product'),
    submitLabel: t('حفظ المنتج', 'Save product'),
    createPermission: 'stock.products.edit',
    path: '/products',
    optionsForm: 'products',
    fields: [
      { key: 'name', label: t('اسم المنتج', 'Product name'), type: 'text', required: true, maxLength: 255 },
      {
        key: 'type',
        label: t('النوع', 'Type'),
        type: 'segmented',
        required: true,
        default: 'products',
        choices: [
          { value: 'products', label: t('منتج', 'Product') },
          { value: 'services', label: t('خدمة', 'Service') },
          { value: 'compiled', label: t('مجمَّع', 'Compiled') },
        ],
      },
      {
        key: 'material_type',
        label: t('نوع المادة', 'Material type'),
        type: 'segmented',
        default: 'finished',
        visibleWhen: { field: 'type', in: ['products', 'compiled'] },
        requiredWhen: { field: 'type', in: ['products', 'compiled'] },
        choices: [
          { value: 'raw', label: t('خام', 'Raw') },
          { value: 'semi_finished', label: t('نصف مصنَّع', 'Semi-finished') },
          { value: 'finished', label: t('تام الصنع', 'Finished') },
        ],
      },
      { key: 'category_id', label: t('التصنيف', 'Category'), type: 'select', optionsKey: 'category_id' },
      { key: 'barcode', label: t('الباركود (اختياري، يُولَّد تلقائياً)', 'Barcode (optional, auto-generated)'), type: 'text', maxLength: 100 },
      { key: 'sale_price', label: t('سعر البيع', 'Sale price'), type: 'amount' },
      { key: 'purchase_price', label: t('سعر الشراء', 'Purchase price'), type: 'amount' },
      { key: 'low_stock_thershold', label: t('حد التنبيه بنفاذ المخزون', 'Low-stock threshold'), type: 'number' },
      {
        key: 'status',
        label: t('الحالة', 'Status'),
        type: 'segmented',
        required: true,
        default: 'active',
        choices: [
          { value: 'active', label: t('نشط', 'Active') },
          { value: 'unactive', label: t('غير نشط', 'Inactive') },
        ],
      },
    ],
    toPayload: (v) =>
      compact({
        name: v.name,
        type: v.type ?? 'products',
        material_type: ['products', 'compiled'].includes(String(v.type ?? 'products')) ? v.material_type ?? 'finished' : undefined,
        category_id: v.category_id,
        barcode: v.barcode,
        sale_price: num(v.sale_price),
        purchase_price: num(v.purchase_price),
        low_stock_thershold: num(v.low_stock_thershold),
        status: v.status ?? 'active',
      }),
  },

  permits: {
    section: 'permits',
    title: t('إذن مخزني جديد', 'New stock permit'),
    submitLabel: t('حفظ الإذن', 'Save permit'),
    createPermission: ['stock.permits.create_addition', 'stock.permits.create_disbursement', 'stock.permits.create_transfer', 'stock.permits.create_opening'],
    path: '/permits',
    optionsForm: 'permits',
    fields: [
      { key: 'permission_type', label: t('نوع الإذن', 'Permit type'), type: 'segmented', required: true, default: '1', choices: PERMIT_TYPES },
      { key: 'permission_date', label: t('التاريخ', 'Date'), type: 'date', required: true, default: 'today' },
      {
        key: 'store_houses_id',
        label: t('المستودع', 'Warehouse'),
        type: 'select',
        optionsKey: 'store_houses_id',
        visibleWhen: { field: 'permission_type', in: ['1', '2', '4'] },
        requiredWhen: { field: 'permission_type', in: ['1', '2', '4'] },
      },
      {
        key: 'from_store_houses_id',
        label: t('من مستودع', 'From warehouse'),
        type: 'select',
        optionsKey: 'store_houses_id',
        visibleWhen: { field: 'permission_type', in: ['3'] },
        requiredWhen: { field: 'permission_type', in: ['3'] },
      },
      {
        key: 'to_store_houses_id',
        label: t('إلى مستودع', 'To warehouse'),
        type: 'select',
        optionsKey: 'store_houses_id',
        visibleWhen: { field: 'permission_type', in: ['3'] },
        requiredWhen: { field: 'permission_type', in: ['3'] },
      },
      {
        key: 'lines',
        label: t('المنتجات', 'Products'),
        type: 'lines',
        required: true,
        lines: {
          min: 1,
          totals: 'line_amount',
          columns: [
            { key: 'product_id', label: t('المنتج', 'Product'), type: 'select', optionsKey: 'product_id', searchable: true, required: true },
            { key: 'quantity', label: t('الكمية', 'Quantity'), type: 'number', required: true },
            { key: 'unit_price', label: t('سعر الوحدة', 'Unit price'), type: 'amount', required: true },
          ],
        },
      },
    ],
    // خياراتُ نوع الإذن تُقصَر على ما يملكه المستخدم فعلاً من صلاحيات الإنشاء الأربع
    adjustField: (f, _options, _defaults, flags) => {
      if (f.key === 'permission_type' && f.choices) {
        const allowed: Record<string, string> = { '1': 'can_create_addition', '2': 'can_create_disbursement', '3': 'can_create_transfer', '4': 'can_create_opening' };
        const choices = f.choices.filter((c) => flags[allowed[c.value]] !== false);
        return { ...f, choices, default: choices.some((c) => c.value === (f.default as string)) ? f.default : choices[0]?.value };
      }
      return f;
    },
    toPayload: (v) => {
      const lines = Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [];
      const filled = lines.filter((l) => l.product_id);
      const type = String(v.permission_type ?? '1');
      const grandTotal = filled.reduce((sum, l) => sum + (num(l.quantity) ?? 0) * (num(l.unit_price) ?? 0), 0);

      return compact({
        permission_type: Number(type),
        permission_date: v.permission_date,
        store_houses_id: type === '3' ? undefined : v.store_houses_id,
        from_store_houses_id: type === '3' ? v.from_store_houses_id : undefined,
        to_store_houses_id: type === '3' ? v.to_store_houses_id : undefined,
        grand_total: Math.round(grandTotal * 100) / 100,
        product_id: filled.map((l) => l.product_id),
        quantity: filled.map((l) => num(l.quantity) ?? 0),
        unit_price: filled.map((l) => num(l.unit_price) ?? 0),
        total: filled.map((l) => Math.round((num(l.quantity) ?? 0) * (num(l.unit_price) ?? 0) * 100) / 100),
      });
    },
  },
};
