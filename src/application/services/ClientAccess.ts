import { Knex } from 'knex';
import { User } from '../../domain/entities';
import { AppError } from '../../domain/errors/AppError';
import { SettingsRepository, UserRepository } from '../../domain/repositories';
import { findClientItem, ClientSectionKey } from '../../domain/services/ClientCatalog';
import { AccessContext, evaluateCatalogItem, hasCreatePermission } from '../../domain/services/catalogKit';
import { Cache } from '../ports';
import { AccessService } from './AccessService';

/**
 * فحوص الوصول المشتركة لوحدة العملاء: صلاحية الدور + مفتاح التطبيق (`customers`)، وفوق ذلك
 * مفاتيح `client_module_settings` (صفٌّ واحد، singleton) للأقسام الفرعية القابلة للتعطيل إدارياً —
 * لا حدود باقة هنا (`ClientsPlanFeatures::hasPlanLimit()` ثابتة `false` في الويب).
 */
export class ClientAccess {
  constructor(
    private readonly users: UserRepository,
    private readonly settings: SettingsRepository,
    private readonly access: AccessService,
    private readonly db: Knex,
    private readonly cache: Cache,
    private readonly settingsTtl: number,
  ) {}

  private async moduleFlags(): Promise<{ doubtfulDebts: boolean; itinerary: boolean }> {
    return this.cache.wrap('settings:client_module', this.settingsTtl, async () => {
      const row = await this.db('client_module_settings').first('doubtful_debts_enabled', 'itinerary_enabled');
      return {
        doubtfulDebts: row ? Boolean(row.doubtful_debts_enabled) : true,
        itinerary: row ? Boolean(row.itinerary_enabled) : true,
      };
    });
  }

  async load(userId: number): Promise<{ user: User; ctx: AccessContext; flags: { doubtfulDebts: boolean; itinerary: boolean } }> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');

    const [permissions, statuses, subscription, flags] = await Promise.all([
      this.access.permissionsFor(user),
      this.cache.wrap('settings:applications', this.settingsTtl, () => this.settings.applicationStatuses()),
      this.cache.wrap('settings:subscription', 60, () => this.settings.subscription()),
      this.moduleFlags(),
    ]);

    return {
      user,
      ctx: { permissions, applicationStatuses: statuses, subscriptionLinked: subscription.linked, planPermissions: subscription.permissions },
      flags,
    };
  }

  /** يمنع فتح قسم لا يملكه الدور، معطّل من «إدارة التطبيقات»، أو معطّل إدارياً من إعدادات وحدة العملاء */
  assertSection(key: ClientSectionKey, ctx: AccessContext, flags: { doubtfulDebts: boolean; itinerary: boolean }) {
    const found = findClientItem(key);
    if (!found) throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');

    if (key === 'doubtful_debts' && !flags.doubtfulDebts) throw AppError.forbidden('SECTION_DISABLED', 'هذا القسم معطَّل من إعدادات وحدة العملاء.');
    if (key === 'itinerary' && !flags.itinerary) throw AppError.forbidden('SECTION_DISABLED', 'هذا القسم معطَّل من إعدادات وحدة العملاء.');

    const { visible, locked } = evaluateCatalogItem(found.group, found.item, ctx);
    if (!visible) throw AppError.forbidden('SECTION_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا القسم.');
    // لا حدود باقة في وحدة العملاء أصلاً (`planFeature` دائماً null هنا) — `locked` لا يكون true إطلاقاً
    if (locked) throw new AppError('PLAN_LOCKED', 'هذا القسم غير مشمول بباقتك الحالية.', 403);
  }

  /**
   * الإنشاء يشترط فوق ذلك صلاحية الإضافة نفسها. `flags` اختياريٌّ هنا (توقيعٌ يطابق
   * `CreateAccessGuard`) لأن كلا القسمين القابلين للإضافة — العملاء والمنافسون — لا يتقيّدان
   * بمفتاحي `doubtful_debts`/`itinerary`؛ استدعاءٌ حقيقي من `load()` يمرّرهما لو لزم لاحقاً.
   */
  assertCanCreate(key: ClientSectionKey, ctx: AccessContext, flags: { doubtfulDebts: boolean; itinerary: boolean } = { doubtfulDebts: true, itinerary: true }) {
    this.assertSection(key, ctx, flags);
    const found = findClientItem(key);
    if (!found || !hasCreatePermission(found.item, ctx)) throw AppError.forbidden('CREATE_FORBIDDEN', 'لا تملك صلاحية الإضافة في هذا القسم.');
  }
}
