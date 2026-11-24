import { Knex } from 'knex';
import { DeviceRepository, TrustedDeviceInput } from '../../domain/repositories';
import { sqlNow } from '../db/knex';

/** `AuthController::registerTrustedDevice` — صالح 180 يوماً */
export class KnexDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Knex) {}

  async upsertTrusted(input: TrustedDeviceInput): Promise<void> {
    const now = sqlNow();
    const existing = await this.db('trusted_devices').where('user_id', input.userId).where('device_fingerprint', input.fingerprint).first();

    if (existing) {
      await this.db('trusted_devices').where('id', existing.id).update({ last_used_at: now, ip_address: input.ip, updated_at: now });
      return;
    }

    await this.db('trusted_devices').insert({
      user_id: input.userId,
      device_name: input.deviceName,
      device_fingerprint: input.fingerprint,
      ip_address: input.ip,
      user_agent: input.userAgent,
      browser: input.browser,
      os: input.os,
      is_trusted: 1,
      last_used_at: now,
      expires_at: sqlNow(new Date(Date.now() + 180 * 24 * 3600 * 1000)),
      created_at: now,
      updated_at: now,
    });
  }
}
