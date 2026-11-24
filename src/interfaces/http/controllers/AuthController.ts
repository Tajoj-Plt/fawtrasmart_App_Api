import { Request, Response } from 'express';
import { z } from 'zod';
import { GetCurrentUserUseCase } from '../../../application/use-cases/auth/GetCurrentUserUseCase';
import { LoginUseCase } from '../../../application/use-cases/auth/LoginUseCase';
import { LogoutUseCase } from '../../../application/use-cases/auth/LogoutUseCase';
import { RefreshTokenUseCase } from '../../../application/use-cases/auth/RefreshTokenUseCase';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  device: z
    .object({
      id: z.string().trim().min(1).max(191),
      name: z.string().trim().max(191).default('Mobile'),
      platform: z.enum(['ios', 'android', 'unknown']).default('unknown'),
      osVersion: z.string().max(64).optional(),
      appVersion: z.string().max(32).optional(),
    })
    .default({ id: 'unknown', name: 'Mobile', platform: 'unknown' }),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });
export const logoutSchema = z.object({ refreshToken: z.string().optional(), everywhere: z.boolean().optional() });

export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshTokenUseCase,
    private readonly logout: LogoutUseCase,
    private readonly me: GetCurrentUserUseCase,
  ) {}

  loginHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof loginSchema>;
    const result = await this.login.execute({
      email: body.email,
      password: body.password,
      device: body.device,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? '',
    });
    ok(res, result);
  };

  refreshHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof refreshSchema>;
    ok(res, await this.refresh.execute(body.refreshToken));
  };

  logoutHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof logoutSchema>;
    await this.logout.execute({
      userId: currentUserId(req),
      refreshToken: body.refreshToken,
      everywhere: body.everywhere,
      ip: req.ip ?? null,
      platform: String(req.headers['x-platform'] ?? 'Mobile'),
    });
    ok(res, { loggedOut: true });
  };

  meHandler = async (req: Request, res: Response) => {
    ok(res, await this.me.execute(currentUserId(req)));
  };
}
