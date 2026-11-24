import { User } from '../../domain/entities';
import { AppError } from '../../domain/errors/AppError';
import { SettingsRepository, UserRepository } from '../../domain/repositories';
import { AccessContext, AccountingSectionKey, evaluateItem, findAccountingItem } from '../../domain/services/AccountingCatalog';
import { Cache } from '../ports';
import { AccessService } from './AccessService';

/**
 * فحوص الوصول المشتركة لوحدة الحسابات (عرضاً وإنشاءً): صلاحية الدور + مفتاح التطبيق + الباقة —
 * كحراس المسارات في الويب.
 */
export class AccountingAccess {
  constructor(
    private readonly users: UserRepository,
    private readonly settings: SettingsRepository,
    private readonly access: AccessService,
    private readonly cache: Cache,
    private readonly settingsTtl: number,
  ) {}

  async load(userId: number): Promise<{ user: User; ctx: AccessContext }> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');

    const [permissions, statuses, subscription] = await Promise.all([
      this.access.permissionsFor(user),
      this.cache.wrap('settings:applications', this.settingsTtl, () => this.settings.applicationStatuses()),
      this.cache.wrap('settings:subscription', 60, () => this.settings.subscription()),
    ]);

    return {
      user,
      ctx: { permissions, applicationStatuses: statuses, subscriptionLinked: subscription.linked, planPermissions: subscription.permissions },
    };
  }

  /** يمنع فتح قسم لا يملكه الدور أو معطّل أو خارج الباقة */
  assertSection(key: AccountingSectionKey, ctx: AccessContext) {
    const found = findAccountingItem(key);
    if (!found) throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');

    const { visible, locked } = evaluateItem(found.group, found.item, ctx);
    if (!visible) throw AppError.forbidden('SECTION_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا القسم.');
    if (locked) throw new AppError('PLAN_LOCKED', 'هذا القسم غير مشمول بباقتك الحالية — جدِّد الاشتراك أو رقِّ الباقة.', 403);
  }

  /** الإنشاء يشترط فوق ذلك صلاحية `…create` نفسها */
  assertCanCreate(key: AccountingSectionKey, ctx: AccessContext) {
    this.assertSection(key, ctx);
    const permission = findAccountingItem(key)?.item.createPermission;
    if (!permission || !ctx.permissions.has(permission)) {
      throw AppError.forbidden('CREATE_FORBIDDEN', 'لا تملك صلاحية الإضافة في هذا القسم.');
    }
  }
}
