import { AppError } from '../../../domain/errors/AppError';
import { CREDIT_NOTE_PERMISSIONS, RETURN_PERMISSIONS, SALES_PERMISSIONS, SALES_PLAN } from '../../../domain/services/sales/SalesConstants';
import { ErpBridge } from '../../ports';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { SalesContextFactory } from '../../services/sales/SalesContext';
import { assertBridgeAvailable, interpretErpResult } from '../forms/GenericFormsUseCases';

export const PRINT_KINDS = ['invoice', 'return', 'credit-note', 'payment', 'income', 'closing'] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

/** ميزة الباقة وصلاحية الطباعة لكل نوع — نفسها على مسار طباعة الويب */
const GATES: Record<PrintKind, { plan: string | string[]; permission: string }> = {
  invoice: { plan: SALES_PLAN.invoices, permission: SALES_PERMISSIONS.invoicesPrint },
  return: { plan: SALES_PLAN.returns, permission: RETURN_PERMISSIONS.print },
  'credit-note': { plan: SALES_PLAN.creditNotes, permission: CREDIT_NOTE_PERMISSIONS.print },
  payment: { plan: SALES_PLAN.payments, permission: SALES_PERMISSIONS.paymentsPrint },
  // سند القبض الماليّ (`receipts`) — `incomes.print` في الويب؛ والويب يفحص وحدة المالية على مساره
  income: { plan: 'incomes', permission: 'account.incomes.print' },
  // الإقفال اليوميّ — `daily-closing.print`: لوحة المبيعات أو التقارير في الباقة
  closing: { plan: ['dashboard', 'reports'], permission: 'sales.daily_closing.print' },
};

/** أنواعٌ لا قوالب لها في «قوالب المستندات» — مطبوعة الويب الواحدة */
const NO_TEMPLATES: readonly PrintKind[] = ['closing'];

/** مسار الجسر لكل نوع: مستندات المبيعات في `/api/mobile/sales`، وسند القبض الماليّ في `/api/mobile/accounting` */
const BRIDGE_MODULE = (kind: PrintKind) => (kind === 'income' ? 'accounting' : 'sales');

/**
 * مطبوعة مستند المبيعات **كما يطبعها الويب** — لا تصميمٌ ثانٍ في التطبيق.
 *
 * القوالب المصمَّمة («قوالب المستندات») ومُصيِّرُها وبياناتُها كلّها في الويب، فيُطلب الـHTML منه عبر
 * الجسر (`GET /api/mobile/sales/print/{kind}/{id}`) وهو يستدعي دالّة طباعة الويب نفسها:
 *  - الافتراضيّ: القالب المعيَّن افتراضياً لنوعه، وإلّا قالب النظام — كشاشات المستندات في الويب.
 *  - `builtin`: قالب النظام المدمج دائماً (والحراريّ لسند القبض) — كمطبوعات مساحة الزيارة.
 */
export class PrintTemplateUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly bridge: ErpBridge,
  ) {}

  private async authorize(userId: number, meta: RequestMeta, kind: string): Promise<PrintKind> {
    if (!(PRINT_KINDS as readonly string[]).includes(kind)) throw AppError.notFound('PRINT_KIND_UNKNOWN', 'نوع مستندٍ غير معروف للطباعة.');
    const gate = GATES[kind as PrintKind];
    await this.contexts.load(userId, meta, { planFeatures: Array.isArray(gate.plan) ? gate.plan : [gate.plan], permissions: [gate.permission] });
    return kind as PrintKind;
  }

  /** قوالب النوع كقائمة «المطبوعات» في الويب — الافتراضيّ أولاً */
  async templates(userId: number, meta: RequestMeta, kind: string, lang: 'ar' | 'en') {
    const k = await this.authorize(userId, meta, kind);
    if (NO_TEMPLATES.includes(k)) return { templates: [] };
    const res = await this.bridge.request({ userId, method: 'GET', module: BRIDGE_MODULE(k), path: `/print/${k}/templates`, lang });
    assertBridgeAvailable(res);
    interpretErpResult(res);
    const list = (res.body as { data?: { templates?: unknown } }).data?.templates;
    return { templates: Array.isArray(list) ? list : [] };
  }

  async html(userId: number, meta: RequestMeta, kind: string, id: number, opts: { builtin: boolean; thermal: boolean; templateId: number | null; visitId?: number | null; lang: 'ar' | 'en' }) {
    const k = await this.authorize(userId, meta, kind);

    const query = new URLSearchParams();
    if (opts.builtin) query.set('builtin', '1');
    else if (opts.templateId) query.set('template', String(opts.templateId));
    if (opts.builtin && opts.thermal && (k === 'payment' || k === 'income')) query.set('type', 'thermal');
    // سند قبضٍ فُتح من زيارة: الويب يُجيزه بالزيارة متى خرج عن سندات منشئه
    if (k === 'income' && opts.visitId) query.set('visit', String(opts.visitId));
    const qs = query.toString();

    const res = await this.bridge.request({ userId, method: 'GET', module: BRIDGE_MODULE(k), path: `/print/${k}/${id}${qs ? `?${qs}` : ''}`, lang: opts.lang });
    assertBridgeAvailable(res);
    interpretErpResult(res);

    const data = (res.body as { data?: { html?: unknown } }).data;
    const html = typeof data?.html === 'string' ? data.html : '';
    if (html.trim() === '') throw new AppError('PRINT_EMPTY', 'تعذّر تجهيز المطبوعة من نظام الإدارة.', 502);
    return { html };
  }
}
