import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { NotificationDetailRow, NotificationThreadRepository, ThreadNotification } from '../../../domain/repositories/followup';
import { legacyReplies, REPLY_TITLE_PREFIXES, replyThreads, STATUS_REQUEST_TYPES, statusDecisionFor } from '../../../domain/services/clients/NotificationThreads';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { NotificationGate } from '../../services/clients/ClientsSupport';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';

const PLAN_FEATURE = 'notifications';
const VIEW = 'sales.notifications.view';
const REPLY = ['sales.notifications.reply', 'notifications_reply_to_notifications|data_scope_all'];

/**
 * تفاصيل الإشعار والردّ عليه — `NotificationController::show()/reply()` في تكامل
 * لارافل ببوّابات شاشة الإشعارات في الويب: ميزة الباقة `notifications`،
 * و`sales.notifications.view` للعرض، و`sales.notifications.reply` مع صلاحية الردّ.
 *
 * القائمة والعدّاد و«تعليم كمقروء» موجودةٌ من قبل في هذا الخادم وتبقى كما هي.
 */
export class NotificationDetailUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly threads: NotificationThreadRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly notifications: NotificationGate,
  ) {}

  private async load(userId: number, meta: RequestMeta, permissions: string[]): Promise<ClientsContext> {
    const ctx = await this.contexts.load(userId, meta, undefined, { module: false });
    const feature = await this.reference.planFeature(PLAN_FEATURE);
    if (!feature.allowed) {
      throw new AppError('PLAN_FEATURE_UNAVAILABLE', `باقتك الحالية في فوترة لا تشمل ميزة «${feature.label}». رقِّ باقتك من لوحة تحكّم فوترة لفتح هذه الشاشة.`, 402, { features: [PLAN_FEATURE] });
    }
    for (const p of permissions) if (!ctx.can(p)) throw AppError.forbidden('FORBIDDEN', 'ليس لديك صلاحية لتنفيذ هذا الإجراء.');
    return ctx;
  }

  private present(n: NotificationDetailRow, userId: number) {
    return {
      id: n.id,
      title: n.title,
      description: n.description,
      type: n.type ?? 'general',
      read: n.read,
      isSender: n.userId === userId,
      isReceiver: n.receiverId === userId,
      from: n.from,
      to: n.to,
      client: n.client,
      scheduledAt: n.isScheduled && n.scheduledAt ? n.scheduledAt : null,
      createdAt: n.createdAt,
    };
  }

  /**
   * ردود الإشعار — نتيجة `replyThreads()` نفسها بلا كلفتها حيث لا حاجة:
   * إشعارٌ أحدث من أوّل ردٍّ مربوط ردودُه كلُّها مربوطة، وإشعارٌ أقدم لا يحتمل
   * ردّاً قديماً ردودُه المربوطة وحدها، وما عداه يُحسب كاملاً.
   */
  private async repliesOf(row: NotificationDetailRow) {
    const since = await this.threads.linkedRepliesSince();
    if (since && row.createdAt && row.createdAt >= since) return this.threads.linkedReplies(row.id);

    const asThread: ThreadNotification = { id: row.id, title: row.title, clientId: row.clientId, userId: row.userId, receiverId: row.receiverId, createdAt: row.createdAt };
    const titles = REPLY_TITLE_PREFIXES.map((prefix) => `${prefix}${row.title ?? ''}`);
    if (!(await this.threads.legacyReplyPossible(asThread, titles))) return this.threads.linkedReplies(row.id);

    const replies = await this.threads.allReplies();
    const { candidates } = legacyReplies(replies);
    const originals = await this.threads.threadOriginals(candidates);
    return this.threads.repliesByIds(replyThreads(replies, originals).get(row.id) ?? []);
  }

  private async decisionOf(row: NotificationDetailRow) {
    if (!STATUS_REQUEST_TYPES.includes(row.type ?? '') || (row.type === 'client_status_request' && !row.clientId)) return null;
    const requests = row.type === 'client_status_request' ? await this.threads.statusRequests(row.clientId!) : [];
    const statusIds = requests.flatMap((r) => [r.oldStatusId, r.newStatusId]).filter((v): v is number => v !== null);
    const userIds = [...requests.map((r) => r.approvedBy).filter((v): v is number => v !== null), ...(row.userId ? [row.userId] : [])];
    const [statusNames, userNames] = await Promise.all([this.threads.statusNames([...new Set(statusIds)]), this.threads.userNames([...new Set(userIds)])]);
    return statusDecisionFor({ id: row.id, type: row.type, userId: row.userId, clientId: row.clientId, createdAt: row.createdAt }, requests, statusNames, userNames);
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, [VIEW]);
    const row = await this.threads.visible(id, ctx.user.id);
    if (!row) throw AppError.notFound('NOTIFICATION_NOT_FOUND', 'الإشعار غير موجود.');

    const [replies, decision] = await Promise.all([this.repliesOf(row), this.decisionOf(row)]);

    if (row.receiverId === ctx.user.id && !row.read) {
      await this.threads.markRead(row.id, ctx.nowSql);
      row.read = true;
    }

    return { ...this.present(row, ctx.user.id), replies, decision };
  }

  /** الردّ يصل الطرف الآخر ويقفل الأصل */
  async reply(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, REPLY);
    const errors = new FieldErrors();
    const message = new FormInput(body, errors).string('replyMessage', { required: true, max: 500, message: 'اكتب نصّ الردّ.' });
    errors.throwIfAny();

    const original = await this.threads.visible(id, ctx.user.id);
    if (!original) throw AppError.forbidden('REPLY_FORBIDDEN', 'لا يمكنك الردّ على هذا الإشعار.');

    const receiverId = original.receiverId === ctx.user.id ? original.userId : original.receiverId;
    if (!receiverId || receiverId === ctx.user.id) throw new AppError('NO_COUNTERPART', 'لا طرفَ آخر في هذا الإشعار لتردّ عليه.', 422);

    const replyId = await this.notifications.send(
      { userId: ctx.user.id, receiverId, clientId: original.clientId, title: `رد على: ${original.title ?? ''}`, description: message, type: 'reply', read: false, isSent: true, parentId: original.id },
      ctx.now,
    );
    await this.threads.markRead(original.id, ctx.nowSql);

    return { data: { id: replyId ?? 0, replyTo: original.id }, message: 'أُرسل الردّ.' };
  }
}
