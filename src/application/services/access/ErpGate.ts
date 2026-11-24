import { User } from '../../../domain/entities';
import { AppError } from '../../../domain/errors/AppError';
import { SettingsRepository, UserRepository } from '../../../domain/repositories';
import { SubscriptionRecord } from '../../../domain/repositories/clients';
import { Cache } from '../../ports';
import { AccessService } from '../AccessService';

/** ما يقرؤه الحارس من النظام — لقطة الاشتراك وميزات الباقة */
export interface GateSource {
  subscriptionRecord(): Promise<SubscriptionRecord | null>;
  planFeature(key: string): Promise<{ allowed: boolean; label: string }>;
}

export interface GateRequirements {
  /** مفتاح «شاشة التطبيقات» واسمه — `module:<key>` (403) */
  module?: { key: string; label: string };
  /** `plan:a|b` — تكفي ميزةٌ واحدة (402) */
  planFeatures?: string[];
  /** كل عنصرٍ شرطٌ مستقلّ؛ المصفوفة داخله «أيٌّ منها» — `permission.role:a|b` (403) */
  permissions?: Array<string | string[]>;
}

/**
 * حارس الباب لكل وحدةٍ منقولة من الويب — بترتيب وسطاء لارافل على مسارات الـAPI:
 * الاشتراك (`EnsureSubscription` ← 402)، ثم مفتاح التطبيق (`EnsureModuleEnabled` ← 403)،
 * ثم ميزة الباقة (`EnsurePlanFeature` ← 402)، ثم الصلاحية (`permission.role` ← 403).
 */
export class ErpGate {
  constructor(
    private readonly users: UserRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly source: GateSource,
    private readonly access: AccessService,
    private readonly cache: Cache,
    private readonly options: { settingsTtl: number; enforceSubscription: boolean },
  ) {}

  async enter(userId: number, req: GateRequirements = {}): Promise<{ user: User; permissions: Set<string> }> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');

    const [permissions, subscription, statuses] = await Promise.all([
      this.access.permissionsFor(user),
      this.options.enforceSubscription ? this.cache.wrap('erp:subscription', 60, () => this.source.subscriptionRecord()) : Promise.resolve(undefined),
      req.module ? this.cache.wrap('settings:applications', this.options.settingsTtl, () => this.settingsRepo.applicationStatuses()) : Promise.resolve({}),
    ]);

    if (subscription !== undefined) ErpGate.assertSubscription(subscription);

    if (req.module && ((statuses as Record<string, string>)[req.module.key] ?? 'active') !== 'active') {
      throw new AppError('MODULE_DISABLED', `وحدة «${req.module.label}» معطَّلة في إعدادات التطبيقات.`, 403);
    }

    if (req.planFeatures?.length) await this.assertPlan(req.planFeatures);

    for (const p of req.permissions ?? []) {
      if (!(Array.isArray(p) ? p : [p]).some((one) => AccessService.has(permissions, one))) {
        throw AppError.forbidden('FORBIDDEN', 'ليس لديك صلاحية لتنفيذ هذا الإجراء.');
      }
    }

    return { user, permissions };
  }

  /** `EnsurePlanFeature` — رسالةٌ تسمّي الميزة باسمها في شاشة الاشتراك */
  private async assertPlan(features: string[]) {
    const results = await Promise.all(features.map((f) => this.cache.wrap(`erp:plan:${f}`, 60, () => this.source.planFeature(f))));
    if (results.some((r) => r.allowed)) return;
    const labels = results.map((r) => r.label);
    const message =
      labels.length === 1
        ? `باقتك الحالية في فوترة لا تشمل ميزة «${labels[0]}». رقِّ باقتك من لوحة تحكّم فوترة لفتح هذه الشاشة.`
        : `باقتك الحالية في فوترة لا تشمل أياً من: «${labels.join('»، «')}». رقِّ باقتك من لوحة تحكّم فوترة لفتح هذه الشاشة.`;
    throw new AppError('PLAN_FEATURE_UNAVAILABLE', message, 402, { features });
  }

  /** `EnsureSubscription::state()` — الرسائل نفسها ورموزها */
  static assertSubscription(record: SubscriptionRecord | null) {
    if (!record || !record.hasSnapshot) {
      throw new AppError('NO_SUBSCRIPTION', 'لا يوجد اشتراك مسجَّل لهذا النظام. اربط النظام بلوحة تحكّم فوترة لتفعيله.', 402);
    }
    if (record.isExpired) {
      throw new AppError('SUBSCRIPTION_EXPIRED', `انتهى اشتراكك${record.endDate ? ` في ${record.endDate}` : ''}. جدّده من لوحة تحكّم فوترة ليعود النظام إلى العمل.`, 402);
    }
    if (!record.isActive) {
      if (record.consecutiveFailures > 0 && record.lastError) {
        throw new AppError('SUBSCRIPTION_SYNC_LOCKED', `قُفل الاشتراك محلياً: ${record.lastError} يحاول النظام إعادة الاتصال بلوحة فوترة تلقائياً.`, 402);
      }
      const label = record.status === 'suspended' ? 'موقوف' : record.status || 'غير معروف';
      throw new AppError('SUBSCRIPTION_INACTIVE', `اشتراكك غير نشط حالياً (${label}). راجع لوحة تحكّم فوترة.`, 402);
    }
  }
}
