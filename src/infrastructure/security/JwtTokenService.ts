import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AccessTokenPayload, TokenService } from '../../application/ports';
import { AppError } from '../../domain/errors/AppError';

function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 3600;
  const n = Number(m[1]);
  return { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

export class JwtTokenService implements TokenService {
  private readonly accessTtl: number;

  constructor(private readonly secret: string, accessTtl: string) {
    this.accessTtl = ttlToSeconds(accessTtl);
  }

  signAccess(payload: AccessTokenPayload) {
    const token = jwt.sign(payload, this.secret, { expiresIn: this.accessTtl, issuer: 'fawtrasmart-mobile' });
    return { token, expiresIn: this.accessTtl };
  }

  verifyAccess(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, this.secret, { issuer: 'fawtrasmart-mobile' }) as jwt.JwtPayload;
      return { sub: Number(decoded.sub), rid: decoded.rid ?? null, pv: String(decoded.pv ?? '') };
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) throw AppError.unauthorized('TOKEN_EXPIRED', 'انتهت صلاحية رمز الوصول.');
      throw AppError.unauthorized('INVALID_TOKEN', 'رمز الوصول غير صالح.');
    }
  }

  generateRefresh() {
    const plain = randomBytes(40).toString('hex');
    return { plain, hash: this.hashRefresh(plain) };
  }

  /** نفس تجزئة Sanctum (sha256) كي يبقى الصفّ مفهوماً لأدوات لارافل */
  hashRefresh(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }
}
