import { NextFunction, Request, Response } from 'express';
import { AccessTokenPayload, TokenService } from '../../../application/ports';
import { AppError } from '../../../domain/errors/AppError';
import { UserRepository } from '../../../domain/repositories';
import { passwordVersion } from '../../../application/use-cases/auth/LoginUseCase';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload;
    }
  }
}

/** يقرأ `Authorization: Bearer <jwt>` ويتحقّق أن كلمة المرور لم تتغيّر منذ إصداره */
export function authenticate(tokens: TokenService, users: UserRepository) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw AppError.unauthorized('MISSING_TOKEN', 'Authorization token missing');

      const payload = tokens.verifyAccess(token);
      const user = await users.findById(payload.sub);
      if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');
      if (payload.pv !== passwordVersion(user.passwordHash)) {
        throw AppError.unauthorized('TOKEN_REVOKED', 'تغيّرت كلمة المرور — سجّل الدخول مجدداً.');
      }

      req.auth = payload;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function currentUserId(req: Request): number {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.sub;
}
