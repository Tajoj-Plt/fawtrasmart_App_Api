import bcrypt from 'bcryptjs';
import { Hasher } from '../../application/ports';

/** يوافق تجزئات لارافل (`$2y$`) قراءةً وكتابة */
export class BcryptHasher implements Hasher {
  constructor(private readonly rounds = 12) {}

  compare(plain: string, hash: string): Promise<boolean> {
    if (!hash) return Promise.resolve(false);
    return bcrypt.compare(plain, hash);
  }

  async hash(plain: string): Promise<string> {
    const hashed = await bcrypt.hash(plain, this.rounds);
    return hashed.replace(/^\$2[ab]\$/, '$2y$');
  }
}
