import { createHash } from 'node:crypto';
import { AppError } from '../../../domain/errors/AppError';
import {
  ActivityLogRepository,
  DeviceRepository,
  EmployeeRepository,
  TokenRepository,
  UserRepository,
} from '../../../domain/repositories';
import { AuthResultDTO } from '../../dto';
import { Hasher, TokenService } from '../../ports';
import { UserPresenter } from '../../services/UserPresenter';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: 'ios' | 'android' | 'unknown';
  osVersion?: string;
  appVersion?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  device: DeviceInfo;
  ip: string | null;
  userAgent: string;
}

/**
 * تسجيل الدخول — نفس تسلسل `AuthController::login` في الويب:
 * التحقق من البريد وكلمة المرور، ثم فحص إذن دخول الموظف
 * (`allow_system_access` وملفّه غير مؤرشف)، ثم تحديث آخر دخول،
 * وتسجيل النشاط، وتسجيل الجهاز الموثوق.
 */
export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly employees: EmployeeRepository,
    private readonly tokens: TokenRepository,
    private readonly devices: DeviceRepository,
    private readonly activity: ActivityLogRepository,
    private readonly hasher: Hasher,
    private readonly tokenService: TokenService,
    private readonly presenter: UserPresenter,
    private readonly refreshTtlDays: number,
  ) {}

  async execute(input: LoginInput): Promise<AuthResultDTO> {
    const user = await this.users.findByEmail(input.email.trim().toLowerCase());

    if (!user || !(await this.hasher.compare(input.password, user.passwordHash))) {
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'بيانات الاعتماد غير صحيحة.');
    }

    if (user.employeeId !== null) {
      const employee = await this.employees.findById(user.employeeId);

      if (!employee || employee.deletedAt) {
        throw AppError.forbidden('EMPLOYEE_PROFILE_UNAVAILABLE', 'ملفُّ هذا الموظف غير متاح — راجع مدير النظام.');
      }

      if (!employee.allowSystemAccess) {
        throw AppError.forbidden('EMPLOYEE_ACCESS_DENIED', 'هذا الموظف ليس لديه صلاحية دخول للنظام.');
      }
    }

    await this.users.recordLogin(user.id, input.ip);

    await this.activity.log({
      createdBy: user.id,
      action: 'auth',
      description: 'تم تسجيل الدخول بنجاح إلى النظام (تطبيق الجوال)',
      ip: input.ip,
      os: input.device.platform === 'ios' ? 'iOS' : input.device.platform === 'android' ? 'Android' : 'غير معروف',
      device: 'Mobile',
      route: 'api.auth.login',
    });

    await this.devices.upsertTrusted({
      userId: user.id,
      fingerprint: createHash('md5').update(`mobile:${input.device.id}`).digest('hex'),
      deviceName: `${input.device.name || 'Mobile'} (${input.device.platform})`,
      ip: input.ip,
      userAgent: input.userAgent,
      browser: 'FawtraSmart App',
      os: input.device.platform === 'ios' ? 'iOS' : input.device.platform === 'android' ? 'Android' : 'غير معروف',
    });

    const refresh = this.tokenService.generateRefresh();
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000);

    await this.tokens.create({
      userId: user.id,
      name: `mobile:${input.device.platform}:${input.device.id}`,
      tokenHash: refresh.hash,
      abilities: ['mobile:refresh'],
      expiresAt,
    });

    const access = this.tokenService.signAccess({
      sub: user.id,
      rid: user.roleId,
      pv: passwordVersion(user.passwordHash),
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.plain,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      user: await this.presenter.present(user),
    };
  }
}

/** بصمة قصيرة لكلمة المرور: تتغيّر مع تغييرها فتسقط رموز الوصول القديمة */
export function passwordVersion(hash: string): string {
  return createHash('sha256').update(hash).digest('hex').slice(0, 12);
}
