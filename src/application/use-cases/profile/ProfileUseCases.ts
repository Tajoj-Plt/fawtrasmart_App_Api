import { PointsTier } from '../../../domain/entities';
import { AppError } from '../../../domain/errors/AppError';
import { ActivityLogRepository, PointsRepository, UserRepository } from '../../../domain/repositories';
import { ProfileDTO, toBranchDTO } from '../../dto';
import { FileStorage, Hasher } from '../../ports';
import { AccessService } from '../../services/AccessService';
import { UserPresenter } from '../../services/UserPresenter';

/**
 * الملف الشخصي — يجمع ما تعرضه ترويسة الويب (الاسم، الفرع، مبدّل الفروع، الخروج)
 * وما تعرضه صفحة `employee/profile` (ملخّص نقاط الموظف ومستواه).
 */
export class ProfileUseCases {
  constructor(
    private readonly users: UserRepository,
    private readonly points: PointsRepository,
    private readonly activity: ActivityLogRepository,
    private readonly access: AccessService,
    private readonly presenter: UserPresenter,
    private readonly hasher: Hasher,
    private readonly storage: FileStorage,
  ) {}

  private async load(userId: number) {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');
    return user;
  }

  async get(userId: number, month?: number, year?: number): Promise<ProfileDTO> {
    const user = await this.load(userId);
    const permissions = await this.access.permissionsFor(user);
    const dto = await this.presenter.present(user);

    const switchable = await this.access.switchableBranches(user, permissions);
    const currentBranchId = await this.access.resolveBranchId(user);
    const roots = switchable.filter((b) => b.parentId === null);

    let points: ProfileDTO['points'] = null;

    if (user.employeeId) {
      const now = new Date();
      const m = month ?? now.getMonth() + 1;
      const y = year ?? now.getFullYear();
      const [summary, tiers, recent] = await Promise.all([
        this.points.summary(user.employeeId, m, y),
        this.points.tiers(),
        this.points.recent(user.employeeId, m, y, 5),
      ]);

      const balance = summary.monthNet;
      const currentTier = tierFor(balance, tiers);
      const nextTier = currentTier
        ? tiers.find((t) => t.minPoints > currentTier.minPoints) ?? null
        : tiers[0] ?? null;

      let progress = 0;
      if (currentTier && nextTier) {
        progress = Math.min(100, Math.max(0, Math.round(((balance - currentTier.minPoints) / Math.max(1, nextTier.minPoints - currentTier.minPoints)) * 100)));
      }

      points = {
        month: m,
        year: y,
        balance,
        monthEarned: summary.monthEarned,
        monthSpent: summary.monthSpent,
        totalEarned: summary.totalEarned,
        totalSpent: summary.totalSpent,
        currentTier,
        nextTier,
        pointsToNextTier: nextTier ? Math.max(0, nextTier.minPoints - balance) : null,
        progressToNextTier: progress,
        recent,
      };
    }

    return {
      user: dto,
      branches: {
        canSwitch: roots.length > 1,
        canSwitchToAll: permissions.has('data_scope_all'),
        items: roots.map((b) => toBranchDTO(b, currentBranchId)),
      },
      points,
    };
  }

  async update(userId: number, data: { name?: string; phone?: string | null }) {
    const user = await this.load(userId);
    await this.users.updateProfile(userId, data);
    await this.activity.log({
      createdBy: userId,
      action: 'update',
      description: `تحديث بيانات الملف الشخصي (${user.name})`,
      ip: null,
      os: 'Mobile',
      device: 'Mobile',
      route: 'api.profile.update',
    });
    return this.presenter.present((await this.users.findById(userId))!);
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string, ip: string | null) {
    const user = await this.load(userId);

    if (!(await this.hasher.compare(currentPassword, user.passwordHash))) {
      throw new AppError('CURRENT_PASSWORD_INVALID', 'كلمة المرور الحالية غير صحيحة.', 422);
    }

    await this.users.updatePassword(userId, await this.hasher.hash(newPassword));
    await this.activity.log({
      createdBy: userId,
      action: 'security',
      description: 'تغيير كلمة المرور من تطبيق الجوال',
      ip,
      os: 'Mobile',
      device: 'Mobile',
      route: 'api.profile.password',
    });
  }

  async switchBranch(userId: number, branchId: number | null) {
    const user = await this.load(userId);
    const permissions = await this.access.permissionsFor(user);

    if (branchId === null) {
      if (!permissions.has('data_scope_all')) {
        throw AppError.forbidden('BRANCH_SWITCH_DENIED', 'لا تملك صلاحية الدخول لجميع الفروع.');
      }
    } else {
      const allowed = await this.access.switchableBranches(user, permissions);
      if (!allowed.some((b) => b.id === branchId)) {
        throw AppError.forbidden('BRANCH_SWITCH_DENIED', 'لا تملك صلاحية الدخول لهذا الفرع.');
      }
    }

    await this.users.updateBranch(userId, branchId);
    return this.presenter.present((await this.users.findById(userId))!);
  }

  async updateAvatar(userId: number, buffer: Buffer, mimeType: string) {
    await this.load(userId);
    const path = await this.storage.saveAvatar(userId, buffer, mimeType);
    await this.users.updateAvatar(userId, path);
    return this.presenter.present((await this.users.findById(userId))!);
  }
}

/** المستوى الذي يقع فيه الرصيد — `calculateTierFromPoints` في الويب */
export function tierFor(points: number, tiers: PointsTier[]): PointsTier | null {
  let current: PointsTier | null = null;
  for (const tier of tiers) {
    if (points >= tier.minPoints && (tier.maxPoints === null || points <= tier.maxPoints)) {
      current = tier;
    }
  }
  return current;
}
