import { Knex } from 'knex';
import { ActivityLogInput, ActivityLogRepository } from '../../domain/repositories';
import { sqlNow } from '../db/knex';
import { logger } from '../logger';

const ICONS: Record<string, string> = { auth: 'log-in', update: 'edit', security: 'shield', create: 'plus', delete: 'trash' };

/** يكتب في جدول `logs` كما تفعل `ActivityLogService::log` (type_log = 'log' ليظهر في شاشة النشاطات) */
export class KnexActivityLogRepository implements ActivityLogRepository {
  constructor(private readonly db: Knex) {}

  async log(input: ActivityLogInput): Promise<void> {
    try {
      const now = sqlNow();
      await this.db('logs').insert({
        type: 'setting',
        type_id: null,
        type_log: 'log',
        description: input.description,
        created_by: input.createdBy,
        icon: ICONS[input.action] ?? 'activity',
        ip_address: input.ip,
        browser: 'FawtraSmart App',
        os: input.os,
        device: input.device,
        route: input.route,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      // سجلّ النشاط لا يوقف العملية الأصلية
      logger.warn({ err: e }, 'activity log insert failed');
    }
  }
}
