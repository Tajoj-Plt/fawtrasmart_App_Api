import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { DocumentNumberRepository } from '../../../domain/repositories/clients';
import { DOCUMENT_SECTIONS, formatNumber, isResetDue, SerialSetting, trailingNumber } from '../../../domain/services/clients/DocumentNumberFormat';
import { parseLocal, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const MAX_PROBE = 500;
const PROBE_BATCH = 50;

function map(r: Record<string, unknown>): SerialSetting {
  return {
    id: Number(r.id),
    section: String(r.section),
    currentNumber: Number(r.current_number ?? 0),
    numberOfDigits: Number(r.number_of_digits ?? 6),
    prefix: (r.prefix as string | null) ?? null,
    separator: (r.separator as string | null) ?? null,
    suffix: (r.suffix as string | null) ?? null,
    mode: Number(r.mode ?? 0),
    resetYearly: bool(r.reset_yearly),
    resetPeriod: (r.reset_period as string | null) ?? null,
    lastResetAt: parseLocal(r.last_reset_at),
  };
}

/**
 * `DocumentNumberService::next()` — العدّاد نفسه الذي يستعمله الويب (`serial_settings`)
 * بقفل الصفّ، وتخطّي الأرقام المحجوزة فعلاً في جدول المستند، والتصفير الدوري.
 * يُنفَّذ داخل معاملة الحفظ: إن فشل الحفظ لم يُستهلك الرقم.
 */
export class KnexDocumentNumberRepository implements DocumentNumberRepository {
  constructor(private readonly db: Knex) {}

  async load(section: string): Promise<SerialSetting | null> {
    const row = await this.db('serial_settings').where('section', section).first();
    return row ? map(row) : null;
  }

  async next(section: string, now: Date, tx: Tx): Promise<string> {
    const db = conn(this.db, tx);
    let row = await db('serial_settings').where('section', section).forUpdate().first();

    if (!row) {
      try {
        await db('serial_settings').insert(await this.defaults(section, now, db));
      } catch {
        // طلبٌ متزامن أنشأه قبلنا — نقرأ ما أنشأه
      }
      row = await db('serial_settings').where('section', section).forUpdate().first();
    }

    const setting = map(row);
    const patch: Record<string, unknown> = {};

    if (isResetDue(setting, now)) {
      setting.currentNumber = 0;
      setting.lastResetAt = now;
      patch.last_reset_at = toSqlDateTime(now);
    }

    const [number, formatted] = await this.firstFree(setting, section, setting.currentNumber + 1, now, db);
    await db('serial_settings').where('id', setting.id).update({ ...patch, current_number: number, updated_at: toSqlDateTime(now) });

    return formatted;
  }

  async peek(section: string, now: Date): Promise<string> {
    const setting = (await this.load(section)) ?? this.fromDefaults(await this.defaults(section, now, this.db));
    const base = isResetDue(setting, now) ? 0 : setting.currentNumber;
    return (await this.firstFree(setting, section, base + 1, now, this.db))[1];
  }

  /** أوّل رقمٍ شاغر فعلاً في جدول المستند — `firstFreeNumber()` */
  private async firstFree(setting: SerialSetting, section: string, start: number, now: Date, db: Knex): Promise<[number, string]> {
    let number = Math.max(1, start);
    const meta = DOCUMENT_SECTIONS[section];
    if (!meta) return [number, formatNumber(setting, number, now)];

    for (let probed = 0; probed < MAX_PROBE; probed += PROBE_BATCH) {
      const candidates = new Map<number, string>();
      for (let i = 0; i < PROBE_BATCH; i++) candidates.set(number + i, formatNumber(setting, number + i, now));

      let taken: Set<string>;
      try {
        const q = db(meta.table).whereIn(meta.column, [...candidates.values()]);
        for (const [column, value] of Object.entries(meta.scope ?? {})) q.where(column, value);
        const rows = await q.pluck(meta.column);
        taken = new Set(rows.map(String));
      } catch {
        return [number, candidates.get(number)!];
      }

      for (const [candidate, formatted] of candidates) {
        if (!taken.has(formatted)) return [candidate, formatted];
      }
      number += PROBE_BATCH;
    }

    return [number, formatNumber(setting, number, now)];
  }

  private async defaults(section: string, now: Date, db: Knex): Promise<Record<string, unknown>> {
    const meta = DOCUMENT_SECTIONS[section];
    let last = 0;
    if (meta) {
      try {
        const q = db(meta.table).whereNotNull(meta.column);
        for (const [column, value] of Object.entries(meta.scope ?? {})) q.where(column, value);
        const codes = await q.pluck(meta.column);
        for (const c of codes) last = Math.max(last, trailingNumber(String(c)));
      } catch {
        last = 0;
      }
    }
    const stamp = toSqlDateTime(now);
    return {
      section,
      current_number: last,
      number_of_digits: 6,
      prefix: meta?.prefix ?? '',
      separator: '-',
      suffix: null,
      mode: 0,
      reset_yearly: 0,
      reset_period: 'never',
      last_reset_at: stamp,
      is_active: 1,
      created_at: stamp,
      updated_at: stamp,
    };
  }

  private fromDefaults(row: Record<string, unknown>): SerialSetting {
    return map({ ...row, id: 0 });
  }
}
