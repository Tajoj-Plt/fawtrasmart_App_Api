/** أنواع وحدة المبيعات — صفوف القوائم كما تُعرض في التطبيق */

export interface InvoiceRow {
  id: number;
  code: string | null;
  date: string | null;
  clientName: string | null;
  grandTotal: number | null;
  /** 1 غير مدفوعة، 2 مدفوعة جزئياً، 3 مدفوعة بالكامل */
  paymentStatus: number | null;
  currency: string | null;
}

export interface QuoteRow {
  id: number;
  number: string | null;
  date: string | null;
  clientName: string | null;
  grandTotal: number | null;
}

export interface CreditNoteRow {
  id: number;
  number: string | null;
  date: string | null;
  clientName: string | null;
  grandTotal: number | null;
  /** 1 مسودة، 2 معلّق، 3 معتمد، 4 حُوِّل لفاتورة، 5 ملغى */
  status: number | null;
}

export interface PaymentRow {
  id: number;
  date: string | null;
  clientName: string | null;
  amount: number;
  /** 1 نقدي، 2 شيك، 3 بطاقة، 4 أونلاين، 5 أخرى */
  method: number | null;
}

/** نطاق رؤية مستندات المبيعات — محورا المكان والأشخاص لا يجتمعان أبداً (كما في الويب)؛
 * محور الأشخاص هنا يجمع منشئاً أو مندوباً مُسنَداً معاً (`OR`) لا يفصلهما. */
export type SalesScope = { mode: 'unrestricted' } | { mode: 'scoped'; userIds: number[]; employeeIds: number[] };

/** مدى تاريخي فقط (لا `accounting_period_id`، غير موحَّد بين مستندات المبيعات) — `null` في أي طرفٍ = بلا قيد */
export interface DateRange {
  from: string | null;
  to: string | null;
}

export interface SalesListQuery {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
}

export interface SalesOverviewFigures {
  invoicesTotal: number | null;
  invoicesCount: number | null;
  quotesCount: number | null;
  paymentsTotal: number | null;
}
