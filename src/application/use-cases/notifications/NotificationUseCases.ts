import { AppError } from '../../../domain/errors/AppError';
import { NotificationRepository, UserRepository } from '../../../domain/repositories';
import { NotificationDTO, toNotificationDTO } from '../../dto';
import { AccessService } from '../../services/AccessService';

const SEE_ALL_PERMISSION = 'notifications_view_system_notifications';

/**
 * الإشعارات — فلترة `NotificationsController::getUnreadNotifications` في الويب:
 * من يملك `notifications_view_system_notifications` يرى الكل، وسواه يرى ما أرسله أو استُقبل له.
 * وفي التطبيق الموظفُ (له `employee_id`) يرى إشعاراته وما أُرسل إليه فقط ولو ملك الصلاحية —
 * قرار صاحب النظام 2026-10-02: جرس المندوب لا يُغرَق بإشعارات النظام كلّها.
 */
export class NotificationUseCases {
  constructor(
    private readonly users: UserRepository,
    private readonly notifications: NotificationRepository,
    private readonly access: AccessService,
  ) {}

  private async scope(userId: number) {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');
    const permissions = await this.access.permissionsFor(user);
    return { user, seeAll: !user.employeeId && permissions.has(SEE_ALL_PERMISSION) };
  }

  async list(userId: number, opts: { unreadOnly: boolean; last24h: boolean; page: number; perPage: number }) {
    const { seeAll } = await this.scope(userId);
    const result = await this.notifications.list({
      userId,
      seeAll,
      unreadOnly: opts.unreadOnly,
      last24hOnly: opts.last24h,
      page: opts.page,
      perPage: opts.perPage,
    });

    return {
      items: result.items.map((n): NotificationDTO => toNotificationDTO(n, userId)),
      total: result.total,
      page: opts.page,
      perPage: opts.perPage,
    };
  }

  async unreadCount(userId: number): Promise<number> {
    const { seeAll } = await this.scope(userId);
    return this.notifications.unreadCount(userId, seeAll);
  }

  async markRead(userId: number, ids: number[]): Promise<number> {
    const { seeAll } = await this.scope(userId);
    return this.notifications.markRead(ids, userId, seeAll);
  }

  async markAllRead(userId: number): Promise<number> {
    const { seeAll } = await this.scope(userId);
    return this.notifications.markAllRead(userId, seeAll);
  }
}
