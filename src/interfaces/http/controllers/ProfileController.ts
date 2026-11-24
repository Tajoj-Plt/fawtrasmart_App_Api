import { Request, Response } from 'express';
import { z } from 'zod';
import { ProfileUseCases } from '../../../application/use-cases/profile/ProfileUseCases';
import { AppError } from '../../../domain/errors/AppError';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const profileQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(191).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
    newPasswordConfirmation: z.string(),
  })
  .refine((v) => v.newPassword === v.newPasswordConfirmation, { message: 'Password confirmation does not match', path: ['newPasswordConfirmation'] });

export const switchBranchSchema = z.object({ branchId: z.coerce.number().int().positive().nullable() });

export class ProfileController {
  constructor(private readonly profile: ProfileUseCases) {}

  showHandler = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof profileQuerySchema>;
    ok(res, await this.profile.get(currentUserId(req), q.month, q.year));
  };

  updateHandler = async (req: Request, res: Response) => {
    ok(res, await this.profile.update(currentUserId(req), req.body as z.infer<typeof updateProfileSchema>));
  };

  passwordHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof changePasswordSchema>;
    await this.profile.changePassword(currentUserId(req), body.currentPassword, body.newPassword, req.ip ?? null);
    ok(res, { changed: true, reauthenticate: true });
  };

  branchHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof switchBranchSchema>;
    ok(res, await this.profile.switchBranch(currentUserId(req), body.branchId));
  };

  avatarHandler = async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) throw new AppError('AVATAR_REQUIRED', 'أرفق صورة في الحقل avatar.', 422);
    ok(res, await this.profile.updateAvatar(currentUserId(req), file.buffer, file.mimetype));
  };
}
