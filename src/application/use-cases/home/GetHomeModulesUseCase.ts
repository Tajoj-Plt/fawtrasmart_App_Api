import { AppError } from '../../../domain/errors/AppError';
import { SettingsRepository, UserRepository } from '../../../domain/repositories';
import { ModuleCard, resolveModules } from '../../../domain/services/ModuleCatalog';
import { Cache } from '../../ports';
import { AccessService } from '../../services/AccessService';

export interface HomeModulesDTO {
  greetingName: string;
  modules: ModuleCard[];
  subscription: {
    linked: boolean;
    isActive: boolean;
    isTrial: boolean;
    isExpired: boolean;
    planName: string | null;
    endDate: string | null;
    daysRemaining: number | null;
  };
}

/** بطاقات الوحدات في الشاشة الرئيسية — بحسب الدور والتطبيقات المفعَّلة والباقة */
export class GetHomeModulesUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly settings: SettingsRepository,
    private readonly access: AccessService,
    private readonly cache: Cache,
    private readonly settingsTtl: number,
  ) {}

  async execute(userId: number): Promise<HomeModulesDTO> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');

    const [permissions, statuses, subscription] = await Promise.all([
      this.access.permissionsFor(user),
      this.cache.wrap('settings:applications', this.settingsTtl, () => this.settings.applicationStatuses()),
      this.cache.wrap('settings:subscription', 60, () => this.settings.subscription()),
    ]);

    const modules = resolveModules({
      permissions,
      applicationStatuses: statuses,
      subscriptionLinked: subscription.linked,
      planPermissions: subscription.permissions,
    });

    return {
      greetingName: user.name,
      modules,
      subscription: {
        linked: subscription.linked,
        isActive: subscription.linked ? subscription.isActive : true,
        isTrial: subscription.isTrial,
        isExpired: subscription.isExpired,
        planName: subscription.planName,
        endDate: subscription.endDate,
        daysRemaining: subscription.daysRemaining,
      },
    };
  }
}
