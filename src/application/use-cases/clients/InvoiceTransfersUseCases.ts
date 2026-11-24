import { AppError } from '../../../domain/errors/AppError';
import { ErpBridge } from '../../ports';
import { assertBridgeAvailable, interpretErpResult } from '../forms/GenericFormsUseCases';

type Lang = 'ar' | 'en';

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * «تسليم واستلام الفواتير والأرصدة» — **قواعد الويب كما هي عبر الجسر**، لا نسخةٌ ثانية منها.
 *
 * العهدة (`invoices.employee_id`)، وزملاء الفرع ومن يغطّي فرع العميل، وسقف المعلّقات، واشتراط
 * القبول والسبب، والإشعارات وملاحظات العملاء — كلّها في `InvoiceTransferController` و
 * `InvoiceTransferRules` بالويب، وتعتمد على شجرة الفروع ونطاق الرؤية وأدوار Spatie. فكلُّ
 * عملية هنا تُنفَّذ هناك بصلاحيات المستخدم نفسه (`/api/mobile/client/invoice-transfers/...`)،
 * والصلاحيات تُفحص على المسار في الويب.
 */
export class InvoiceTransfersUseCases {
  constructor(private readonly bridge: ErpBridge) {}

  private async call(userId: number, method: 'GET' | 'POST', path: string, lang: Lang, body?: unknown) {
    const res = await this.bridge.request({ userId, method, module: 'client', path: `/invoice-transfers${path}`, body, lang });
    assertBridgeAvailable(res);
    const { message } = interpretErpResult(res);
    return { body: asRecord(res.body), message };
  }

  /** بيانات الشاشة كلّها: الدفعات المنتظرة، القوائم الثلاث، الإحصاءات، ونافذة التسليم */
  async overview(userId: number, filters: Record<string, string | number | undefined>, lang: Lang) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const { body } = await this.call(userId, 'GET', qs.toString() ? `?${qs}` : '', lang);
    return body.data ?? {};
  }

  /** عملاء المصدر (يوم خطّ سيرٍ أو «كل عملائي») وما يُسلَّم لكلٍّ منهم إلى هذا المستلِم */
  async sendable(userId: number, source: string, receiverId: number | undefined, lang: Lang) {
    if (!/^(all|\d{4}-\d{2}-\d{2})$/.test(source)) throw AppError.validation({ source: ['مصدر العملاء غير صالح.'] }, 'مصدر العملاء غير صالح.');
    const qs = new URLSearchParams({ source, ...(receiverId ? { receiver_id: String(receiverId) } : {}) });
    const { body } = await this.call(userId, 'GET', `/sendable-clients?${qs}`, lang);
    return { clients: Array.isArray(body.clients) ? body.clients : [] };
  }

  /** تبويب «تسليم واستلام الفواتير» في مساحة الزيارة لعميلٍ واحد */
  async forClient(userId: number, clientId: number, lang: Lang) {
    const { body } = await this.call(userId, 'GET', `/client/${clientId}`, lang);
    return body.data ?? {};
  }

  /**
   * تسليم أرصدة عملاء (`/balance`) أو فواتيرهم (`/`) — دفعةٌ واحدة كلُّها أو لا شيء.
   * `visitId` حين يجري التسليم من زيارة (كتبويب الزيارة في الويب).
   */
  async send(userId: number, input: { mode: 'balance' | 'invoices'; toEmployeeId: number; clientIds?: number[]; invoiceIds?: number[]; notes?: string | null; visitId?: number }, lang: Lang) {
    const common = { to_employee_id: input.toEmployeeId, sender_notes: input.notes ?? null, ...(input.visitId ? { visit_id: input.visitId } : {}) };
    const body = input.mode === 'balance' ? { client_ids: input.clientIds ?? [], ...common } : { invoice_ids: input.invoiceIds ?? [], ...common };
    const { message } = await this.call(userId, 'POST', input.mode === 'balance' ? '/balance' : '', lang, body);
    return { message };
  }

  /** «استلام الكل» — لعميلٍ واحد في الزيارة (`client_id`)، أو كلّ ما سُلِّم لي */
  async receiveAll(userId: number, lang: Lang, clientId?: number) {
    return { message: (await this.call(userId, 'POST', '/receive-all', lang, clientId ? { client_id: clientId } : {})).message };
  }

  async respondBatch(userId: number, batch: string, mode: 'accept' | 'reject', notes: string | null, lang: Lang) {
    return { message: (await this.call(userId, 'POST', `/batch/${encodeURIComponent(batch)}/respond`, lang, { mode, receiver_notes: notes })).message };
  }

  async respond(userId: number, id: number, mode: 'accept' | 'reject', notes: string | null, lang: Lang) {
    return { message: (await this.call(userId, 'POST', `/${id}/${mode}`, lang, { receiver_notes: notes })).message };
  }

  async cancel(userId: number, id: number, lang: Lang) {
    return { message: (await this.call(userId, 'POST', `/${id}/cancel`, lang, {})).message };
  }
}
