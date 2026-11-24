import { Knex } from 'knex';
import { Clock, Tx } from '../../../application/ports';
import { OperationFailureInput, OperationLogInput, OperationLogRepository } from '../../../domain/repositories/clients';
import { toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { conn } from '../../db/KnexUnitOfWork';
import { logger } from '../../logger';

/** `ActivityLogService::iconFor()` */
function iconFor(action: string): string {
  const map: Array<[string[], string]> = [
    [['created', 'create', 'store'], 'feather icon-plus-circle'],
    [['updated', 'update', 'edit'], 'feather icon-edit-2'],
    [['deleted', 'delete', 'destroy'], 'feather icon-trash-2'],
    [['approved', 'approve'], 'feather icon-check-circle'],
    [['rejected', 'reject'], 'feather icon-x-circle'],
    [['restored', 'restore', 'undo'], 'feather icon-rotate-ccw'],
    [['printed', 'print', 'export'], 'feather icon-printer'],
    [['viewed', 'view'], 'feather icon-eye'],
    [['paid', 'payment'], 'feather icon-credit-card'],
    [['signed', 'sign'], 'feather icon-edit-3'],
  ];
  return map.find(([keys]) => keys.includes(action))?.[1] ?? 'feather icon-activity';
}

/** `ActivityLogService::parseBrowser/OS/Device()` */
function parseBrowser(ua: string): string {
  if (/Edg[/\s]([\d.]+)/i.test(ua)) return 'Edge';
  if (/OPR[/\s]([\d.]+)/i.test(ua)) return 'Opera';
  if (/Chrome[/\s]([\d.]+)/i.test(ua)) return 'Chrome';
  if (/Firefox[/\s]([\d.]+)/i.test(ua)) return 'Firefox';
  if (/Safari[/\s]([\d.]+)/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  if (/MSIE|Trident/i.test(ua)) return 'Internet Explorer';
  return 'غير معروف';
}

function parseOS(ua: string): string {
  if (/Windows NT 10/i.test(ua)) return 'Windows 10/11';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return /Android/i.test(ua) ? 'Android' : 'Linux';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  return 'غير معروف';
}

function parseDevice(ua: string): string {
  if (/Mobile|Android.*Mobile|iPhone/i.test(ua)) return 'جوال';
  if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua)) return 'لوحي';
  return 'كمبيوتر';
}

/** `Str::snake()` للوحدة — `ClientVisitWorkspace` ← `client_visit_workspace` */
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();

/**
 * `OperationLog::record()` — صفٌّ في `logs` (شاشة النشاطات) وآخر في `event_logs`
 * (سجلّ الأحداث). السجلّ لا يُسقط العملية الأصلية أبداً.
 */
export class KnexOperationLogRepository implements OperationLogRepository {
  constructor(private readonly db: Knex, private readonly clock: Clock) {}

  async record(input: OperationLogInput, tx?: Tx): Promise<void> {
    const db = conn(this.db, tx);
    const now = toSqlDateTime(this.clock.now());
    const ua = input.userAgent ?? '';

    try {
      await db('logs').insert({
        type: input.module,
        type_id: input.subjectId,
        type_log: 'log',
        description: input.description,
        created_by: input.userId,
        icon: iconFor(input.action),
        ip_address: input.ip,
        browser: parseBrowser(ua),
        os: parseOS(ua),
        device: parseDevice(ua),
        route: input.route,
        old_values: input.oldValues && Object.keys(input.oldValues).length ? JSON.stringify(input.oldValues) : null,
        new_values: input.newValues && Object.keys(input.newValues).length ? JSON.stringify(input.newValues) : null,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      logger.warn({ err: e }, 'activity log insert failed');
    }

    try {
      await db('event_logs').insert({
        user_id: input.userId,
        action: `${snake(input.module)}.${input.action}`,
        description: input.description.replace(/<[^>]*>/g, ''),
        ip_address: input.ip,
        user_agent: input.userAgent,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      logger.warn({ err: e }, 'event log insert failed');
    }
  }

  /** `OperationLog::failure()` — سجلّ الأخطاء + سجلّ الأحداث (لا سجلّ نشاط: العملية لم تُغيّر شيئاً) */
  async failure(input: OperationFailureInput): Promise<void> {
    const now = toSqlDateTime(this.clock.now());
    const { error } = input;

    try {
      await this.db('error_logs').insert({
        user_id: input.userId,
        error_type: error.name || 'Error',
        error_message: error.message,
        stack_trace: error.stack ?? null,
        url: input.url,
        ip_address: input.ip,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      logger.warn({ err: e }, 'error log insert failed');
    }

    try {
      await this.db('event_logs').insert({
        user_id: input.userId,
        action: `${snake(input.module)}.${input.action}_failed`,
        description: `${error.message}${input.subjectId ? ` [#${input.subjectId}]` : ''}`.trim(),
        ip_address: input.ip,
        user_agent: input.userAgent,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      logger.warn({ err: e }, 'failure event log insert failed');
    }
  }
}
