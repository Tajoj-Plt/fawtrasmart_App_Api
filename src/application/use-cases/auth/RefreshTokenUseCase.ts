import { AppError } from '../../../domain/errors/AppError';
import { TokenRepository, UserRepository } from '../../../domain/repositories';
import { AuthResultDTO } from '../../dto';
import { TokenService } from '../../ports';
import { UserPresenter } from '../../services/UserPresenter';
import { passwordVersion } from './LoginUseCase';

/** تجديد رمز الوصول برمز التجديد — مع تدوير رمز التجديد نفسه */
export class RefreshTokenUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: TokenRepository,
    private readonly tokenService: TokenService,
    private readonly presenter: UserPresenter,
    private readonly refreshTtlDays: number,
  ) {}

  async execute(refreshToken: string): Promise<AuthResultDTO> {
    const record = await this.tokens.findByHash(this.tokenService.hashRefresh(refreshToken));

    if (!record || !record.abilities.includes('mobile:refresh')) {
      throw AppError.unauthorized('INVALID_REFRESH_TOKEN', 'رمز التجديد غير صالح.');
    }

    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      await this.tokens.delete(record.id);
      throw AppError.unauthorized('REFRESH_TOKEN_EXPIRED', 'انتهت صلاحية الجلسة، سجّل الدخول مجدداً.');
    }

    const user = await this.users.findById(record.userId);
    if (!user) {
      await this.tokens.delete(record.id);
      throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');
    }

    // تدوير: يُحذف القديم ويُصدر جديد
    await this.tokens.delete(record.id);
    const refresh = this.tokenService.generateRefresh();
    await this.tokens.create({
      userId: user.id,
      name: record.name,
      tokenHash: refresh.hash,
      abilities: record.abilities,
      expiresAt: new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000),
    });

    const access = this.tokenService.signAccess({ sub: user.id, rid: user.roleId, pv: passwordVersion(user.passwordHash) });

    return {
      accessToken: access.token,
      refreshToken: refresh.plain,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      user: await this.presenter.present(user),
    };
  }
}
