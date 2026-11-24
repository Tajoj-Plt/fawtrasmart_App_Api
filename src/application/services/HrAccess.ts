import { User } from '../../domain/entities';
import { AppError } from '../../domain/errors/AppError';
import { SettingsRepository, UserRepository } from '../../domain/repositories';
import { AccessContext, evaluateCatalogItem, hasCreatePermission } from '../../domain/services/catalogKit';
import { findHrItem, HrSectionKey } from '../../domain/services/HrCatalog';
import { Cache } from '../ports';
import { AccessService } from './AccessService';

/** فحوص الوصول المشتركة لوحدة الموارد البشرية: صلاحية الدور + مفتاح التطبيق (`salaries`) + الباقة */
export class HrAccess {
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

    return { user, ctx: { permissions, applicationStatuses: statuses, subscriptionLinked: subscription.linked, planPermissions: subscription.permissions } };
  }

  assertSection(key: HrSectionKey, ctx: AccessContext) {
    const found = findHrItem(key);
    if (!found) throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');

    const { visible, locked } = evaluateCatalogItem(found.group, found.item, ctx);
    if (!visible) throw AppError.forbidden('SECTION_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا القسم.');
    if (locked) throw new AppError('PLAN_LOCKED', 'هذا القسم غير مشمول بباقتك الحالية — جدِّد الاشتراك أو رقِّ الباقة.', 403);
  }

  /** الإنشاء يشترط فوق ذلك صلاحية الإضافة نفسها (`loans.create` لطلب السلفة) */
  assertCanCreate(key: HrSectionKey, ctx: AccessContext) {
    this.assertSection(key, ctx);
    const found = findHrItem(key);
    if (!found || !hasCreatePermission(found.item, ctx)) throw AppError.forbidden('CREATE_FORBIDDEN', 'لا تملك صلاحية الإضافة في هذا القسم.');
  }

  /** أيُّ الأقسام يراها هذا الدور فعلاً (غيرُ المقفلة) — تُستعمل لبناء «نظرة عامة» */
  static visibleKeys(ctx: AccessContext, keys: HrSectionKey[]): Set<HrSectionKey> {
    const visible = new Set<HrSectionKey>();
    for (const key of keys) {
      const found = findHrItem(key);
      if (!found) continue;
      const { visible: ok, locked } = evaluateCatalogItem(found.group, found.item, ctx);
      if (ok && !locked) visible.add(key);
    }
    return visible;
  }

  static can(ctx: AccessContext, permission: string): boolean {
    return AccessService.has(ctx.permissions, permission);
  }
}
