import { LocalizedText } from './ModuleCatalog';
import { SalesSectionKey } from './SalesCatalog';
import { compact, FormDef as GenericFormDef, num } from './formsKit';

export type FormDef = GenericFormDef<SalesSectionKey>;

const t = (ar: string, en: string): LocalizedText => ({ ar, en });

const ITEM_COLUMNS = [
  { key: 'product_id', label: t('المنتج', 'Product'), type: 'select' as const, optionsKey: 'product_id', searchable: true, required: true },
  { key: 'quantity', label: t('الكمية', 'Quantity'), type: 'number' as const, required: true },
  { key: 'unit_price', label: t('سعر الوحدة', 'Unit price'), type: 'amount' as const, required: true },
  { key: 'discount', label: t('الخصم', 'Discount'), type: 'amount' as const },
];

function itemsPayload(v: Record<string, unknown>): Array<Record<string, unknown>> {
  const lines = Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [];
  return lines
    .filter((l) => l.product_id)
    .map((l) =>
      compact({
        product_id: l.product_id,
        quantity: num(l.quantity) ?? 0,
        unit_price: num(l.unit_price) ?? 0,
        discount: num(l.discount) ?? 0,
      }),
    );
}

/**
 * نماذج الإنشاء في وحدة المبيعات. فاتورة المبيعات هي الأثقل في كل النظام — لا تحقّقٍ حقيقيٍّ في
 * الويب لمعظم حقولها (`persistInvoice()` مكتوبٌ يدوياً، يُعيد تحويلاً برسالة جلسةٍ لا خطأ حقلٍ
 * محدَّد عند فشل قاعدةٍ تجارية)، فتحقّق التطبيق هنا احتياطيٌّ فقط. عرض الأسعار له تحقّقٌ حقيقيٌّ
 * (`FormRequest`) ولا يلمس المخزون أو القيود إطلاقاً — أخفّ الثلاثة خطراً.
 */
export const SALES_FORMS: Partial<Record<SalesSectionKey, FormDef>> = {
  payments: {
    section: 'payments',
    title: t('سند قبض جديد', 'New client receipt'),
    submitLabel: t('حفظ السند', 'Save receipt'),
    createPermission: 'sales.payments.create',
    path: '/payments',
    optionsForm: 'payments',
    fields: [
      { key: 'invoice_id', label: t('الفاتورة', 'Invoice'), type: 'select', required: true, optionsKey: 'invoice_id', searchable: true },
      { key: 'amount', label: t('المبلغ', 'Amount'), type: 'amount', required: true },
      { key: 'payment_date', label: t('تاريخ السداد', 'Payment date'), type: 'date', required: true, default: 'today' },
      { key: 'payment_type', label: t('طريقة الدفع', 'Payment method'), type: 'select', optionsKey: 'payment_type' },
      { key: 'reference_number', label: t('رقم مرجعي', 'Reference number'), type: 'text', maxLength: 255 },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 1000 },
    ],
    toPayload: (v) =>
      compact({
        invoice_id: v.invoice_id,
        amount: num(v.amount),
        payment_date: v.payment_date,
        payment_type: v.payment_type,
        reference_number: v.reference_number,
        notes: v.notes,
      }),
  },

  invoices: {
    section: 'invoices',
    title: t('فاتورة مبيعات جديدة', 'New sales invoice'),
    submitLabel: t('حفظ الفاتورة', 'Save invoice'),
    createPermission: 'sales.invoices.create',
    path: '/invoices',
    optionsForm: 'invoices',
    fields: [
      { key: 'client_id', label: t('العميل', 'Client'), type: 'select', required: true, optionsKey: 'client_id', searchable: true },
      { key: 'store_house_id', label: t('المستودع', 'Warehouse'), type: 'select', required: true, optionsKey: 'store_house_id' },
      { key: 'invoice_date', label: t('تاريخ الفاتورة', 'Invoice date'), type: 'date', required: true, default: 'today' },
      { key: 'order_source_id', label: t('مصدر الطلب', 'Order source'), type: 'select', optionsKey: 'order_source_id', default: 'defaults.order_source_id' },
      { key: 'lines', label: t('الأصناف', 'Items'), type: 'lines', required: true, lines: { min: 1, totals: 'line_amount', columns: ITEM_COLUMNS } },
      { key: 'discount_amount', label: t('خصمٌ إجمالي', 'Overall discount'), type: 'amount' },
      { key: 'is_paid', label: t('سُدِّدت بالكامل الآن', 'Fully paid now'), type: 'switch', default: false },
      { key: 'advance_payment', label: t('المبلغ المسدَّد الآن', 'Amount paid now'), type: 'amount' },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 1000 },
    ],
    // مصدر الطلب يُطلب فقط إن فرضته إعدادات المبيعات
    adjustField: (f, _options, _defaults, flags) => (f.key === 'order_source_id' ? { ...f, required: Boolean(flags.orderSourceRequired) } : f),
    toPayload: (v) =>
      compact({
        client_id: v.client_id,
        store_house_id: v.store_house_id,
        invoice_date: v.invoice_date,
        order_source_id: v.order_source_id,
        discount_amount: num(v.discount_amount),
        is_paid: v.is_paid === true || v.is_paid === 'true' ? 1 : 0,
        advance_payment: num(v.advance_payment),
        notes: v.notes,
        items: itemsPayload(v),
      }),
  },

  quotes: {
    section: 'quotes',
    title: t('عرض سعر جديد', 'New quote'),
    submitLabel: t('حفظ العرض', 'Save quote'),
    createPermission: 'sales.quotes.create',
    path: '/quotes',
    optionsForm: 'quotes',
    fields: [
      { key: 'client_id', label: t('العميل', 'Client'), type: 'select', required: true, optionsKey: 'client_id', searchable: true },
      { key: 'quote_date', label: t('تاريخ العرض', 'Quote date'), type: 'date', required: true, default: 'today' },
      { key: 'expiry_date', label: t('تاريخ الانتهاء', 'Expiry date'), type: 'date' },
      { key: 'lines', label: t('الأصناف', 'Items'), type: 'lines', required: true, lines: { min: 1, totals: 'line_amount', columns: ITEM_COLUMNS } },
      { key: 'discount_amount', label: t('خصمٌ إجمالي', 'Overall discount'), type: 'amount' },
      { key: 'shipping_cost', label: t('تكلفة الشحن', 'Shipping cost'), type: 'amount' },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 1000 },
    ],
    toPayload: (v) =>
      compact({
        client_id: v.client_id,
        quote_date: v.quote_date,
        expiry_date: v.expiry_date,
        discount_amount: num(v.discount_amount),
        shipping_cost: num(v.shipping_cost),
        tax_type: 1,
        notes: v.notes,
        items: itemsPayload(v),
      }),
    mapErrorKey: (key) => (key.startsWith('items.') ? 'lines' : key),
  },
};
