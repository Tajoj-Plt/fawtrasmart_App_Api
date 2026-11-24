import { ActivityLogRepository, TokenRepository } from '../../../domain/repositories';
import { TokenService } from '../../ports';

export class LogoutUseCase {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly activity: ActivityLogRepository,
    private readonly tokenService: TokenService,
  ) {}

  async execute(input: { userId: number; refreshToken?: string; everywhere?: boolean; ip: string | null; platform: string }) {
    if (input.everywhere) {
      await this.tokens.deleteAllForUser(input.userId, 'mobile:');
    } else if (input.refreshToken) {
      const record = await this.tokens.findByHash(this.tokenService.hashRefresh(input.refreshToken));
      if (record && record.userId === input.userId) await this.tokens.delete(record.id);
    }

    await this.activity.log({
      createdBy: input.userId,
      action: 'auth',
      description: 'تم تسجيل الخروج من النظام (تطبيق الجوال)',
      ip: input.ip,
      os: input.platform,
      device: 'Mobile',
      route: 'api.auth.logout',
    });
  }
}
