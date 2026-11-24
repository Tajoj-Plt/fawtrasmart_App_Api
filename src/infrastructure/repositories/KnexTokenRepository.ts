import { Knex } from 'knex';
import { PersonalAccessToken } from '../../domain/entities';
import { TokenRepository } from '../../domain/repositories';
import { parseDate, sqlNow } from '../db/knex';

const TOKENABLE = 'App\\Models\\User';

/** رموز التجديد تُحفظ في `personal_access_tokens` (جدول Sanctum) مجزّأةً بـ sha256 */
export class KnexTokenRepository implements TokenRepository {
  constructor(private readonly db: Knex) {}

  async create(data: { userId: number; name: string; tokenHash: string; abilities: string[]; expiresAt: Date }): Promise<number> {
    const now = sqlNow();
    const [id] = await this.db('personal_access_tokens').insert({
      tokenable_type: TOKENABLE,
      tokenable_id: data.userId,
      name: data.name,
      token: data.tokenHash,
      abilities: JSON.stringify(data.abilities),
      expires_at: sqlNow(data.expiresAt),
      created_at: now,
      updated_at: now,
    });
    return Number(id);
  }

  async findByHash(tokenHash: string): Promise<PersonalAccessToken | null> {
    const row = await this.db('personal_access_tokens').where('token', tokenHash).where('tokenable_type', TOKENABLE).first();
    if (!row) return null;

    let abilities: string[] = [];
    try {
      abilities = JSON.parse(String(row.abilities ?? '[]'));
    } catch {
      abilities = [];
    }

    return {
      id: Number(row.id),
      userId: Number(row.tokenable_id),
      name: String(row.name),
      tokenHash: String(row.token),
      abilities,
      expiresAt: parseDate(row.expires_at),
    };
  }

  async touch(id: number): Promise<void> {
    await this.db('personal_access_tokens').where('id', id).update({ last_used_at: sqlNow() });
  }

  async delete(id: number): Promise<void> {
    await this.db('personal_access_tokens').where('id', id).delete();
  }

  async deleteAllForUser(userId: number, namePrefix = ''): Promise<void> {
    const qb = this.db('personal_access_tokens').where('tokenable_type', TOKENABLE).where('tokenable_id', userId);
    if (namePrefix) qb.where('name', 'like', `${namePrefix}%`);
    await qb.delete();
  }
}
