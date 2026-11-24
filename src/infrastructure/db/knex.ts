import knex, { Knex } from 'knex';
import { env } from '../../config/env';

/**
 * اتصال واحد بقاعدة النظام الحالية.
 * `mysql2` في الإنتاج (نفس بيانات `.env` الخاصة بلارافل)، و`sqlite` للتطوير المحلي.
 */
export function createDb(): Knex {
  if (env.DB_CLIENT === 'sqlite') {
    if (!env.DB_SQLITE_FILE) throw new Error('DB_SQLITE_FILE is required when DB_CLIENT=sqlite');
    return knex({
      client: 'better-sqlite3',
      connection: { filename: env.DB_SQLITE_FILE },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
  }

  return knex({
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_DATABASE,
      user: env.DB_USERNAME,
      password: env.DB_PASSWORD,
      charset: 'utf8mb4',
      timezone: 'Z',
      // التواريخ نصوصاً (Y-m-d) لا كائنات Date، فلا تنزاح بفرق التوقيت
      dateStrings: true,
    },
    pool: { min: 0, max: 10 },
  });
}

/** تاريخ بصيغة يقبلها MySQL وSQLite كما يكتبها لارافل (Y-m-d H:i:s) */
export function sqlNow(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + (String(value).length === 19 ? 'Z' : ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
