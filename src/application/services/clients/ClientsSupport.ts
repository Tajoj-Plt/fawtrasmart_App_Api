import { AppError } from '../../../domain/errors/AppError';
import {
  ClientsReferenceRepository,
  CurrencyRow,
  NotificationInput,
  NotificationWriteRepository,
  OperationLogRepository,
} from '../../../domain/repositories/clients';
import { endOfDay, parseLocal, startOfDay, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { Cache, Tx } from '../../ports';
import { ClientsContext } from './ClientsContext';

/** وحدة السجلّ لعمليات العملاء في الويب — بها يربط العميلُ خطَّه الزمني */
export const CLIENTS_LOG_MODULE = 'Clients';

/** `OperationLog` بسياق الطلب — IP والمتصفّح والمسار والمستخدم من السياق */
export class ClientsLog {
  constructor(private readonly logs: OperationLogRepository) {}

  record(
    ctx: ClientsContext,
    action: string,
    subjectId: number | null,
    description: string,
    changes: { old?: Record<string, unknown>; new?: Record<string, unknown> } = {},
    tx?: Tx,
    module = CLIENTS_LOG_MODULE,
  ) {
    return this.logs.record(
      {
        action,
        module,
        subjectId,
        description,
        userId: ctx.user.id,
        ip: ctx.meta.ip,
        userAgent: ctx.meta.userAgent,
        route: ctx.meta.route,
        oldValues: changes.old ?? null,
        newValues: changes.new ?? null,
      },
      tx,
    );
  }

  failure(ctx: ClientsContext, error: unknown, action: string, subjectId?: number | null, module = CLIENTS_LOG_MODULE) {
    return this.logs.failure({
      module,
      action,
      error: error instanceof Error ? error : new Error(String(error)),
      userId: ctx.user.id,
      subjectId: subjectId ?? null,
      ip: ctx.meta.ip,
      userAgent: ctx.meta.userAgent,
      url: ctx.meta.url,
    });
  }
}

/**
 * إنشاء إشعار داخلي بحارسَي الويب نفسيهما:
 *   • `NotificationSetting::allows()` — نوعٌ معطَّل من الإعدادات لا يُنشأ (ويمرّ بلا خطأ).
 *   • `PlanLimitObserver` على `internal_notifications` — تجاوز حدّ الباقة يُسقط
 *     العملية كلّها (402)، فالرمي داخل المعاملة يُرجعها.
 */
export class NotificationGate {
  constructor(
    private readonly notifications: NotificationWriteRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly cache: Cache,
  ) {}

  async send(input: NotificationInput, now: Date, tx?: Tx): Promise<number | null> {
    const settings = await this.cache.wrap('clients:notification-settings', 60, () => this.reference.notificationSettings());
    if (input.type && settings[input.type] === false) return null;

    await this.assertPlanLimit(now);
    return this.notifications.insert(input, now, tx);
  }

  /** `SubscriptionGate::checkLive('internal_notifications', 1)` */
  private async assertPlanLimit(now: Date) {
    const { item, subscriptionStart } = await this.cache.wrap('clients:plan:internal_notifications', 60, () => this.reference.planUsage('internal_notifications'));
    if (!item || item.unlimited) return;

    const window = this.window(item.period, now, subscriptionStart);
    let counted: number | null = null;
    if (window) {
      try {
        counted = await this.notifications.countCreatedBetween(window[0], window[1]);
      } catch {
        counted = null;
      }
    }

    const used = counted === null ? item.used : Math.max(item.used, counted);
    const remaining = Math.max(0, item.allowance - used);
    if (remaining >= 1) return;

    throw new AppError('PLAN_LIMIT_REACHED', `بلغت حدّ «${item.label}» في باقة فوترة: ${used} من ${item.allowance}. اشترِ إضافة أو احذف ما لم يعد مستعمَلاً.`, 402, {
      feature: 'internal_notifications',
      remaining,
    });
  }

  /** `UsageReporter::window()` — يومي / شهري / طوال مدة الباقة */
  private window(period: string | null, now: Date, subscriptionStart: string | null): [string, string] | null {
    if (period === 'يومي') return [toSqlDateTime(startOfDay(now)), toSqlDateTime(endOfDay(now))];
    if (period === 'شهري') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
      return [toSqlDateTime(start), toSqlDateTime(end)];
    }
    if (period === 'طوال مدة الباقة') {
      const start = parseLocal(subscriptionStart);
      return start ? [toSqlDateTime(startOfDay(start)), toSqlDateTime(endOfDay(now))] : null;
    }
    return null;
  }
}

/** `CurrencySettings::format()` — بالعملة الافتراضية ولغة الواجهة العربية (الرمز بعد الرقم) */
export class CurrencyFormatter {
  constructor(private readonly currency: CurrencyRow | null) {}

  format(amount: number): string {
    const c = this.currency;
    const decimals = c ? c.decimalPlaces : 2;
    const value = this.round(amount, decimals);
    const [int, frac] = Math.abs(value).toFixed(decimals).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, c?.thousandsSeparator ?? ',');
    let formatted = frac !== undefined ? `${grouped}${c?.decimalSeparator ?? '.'}${frac}` : grouped;

    const symbol = c ? c.symbol : 'SAR';
    if (symbol) formatted = c?.positiveFormat === 'prefix' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;

    if (value < 0) formatted = c?.negativeFormat === 'parentheses' ? `(${formatted})` : `-${formatted}`;
    return formatted;
  }

  private round(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    const sign = value < 0 ? -1 : 1;
    const magnitude = Math.abs(value) * factor;
    if (this.currency?.roundingMethod === 'ceil') return (sign * Math.ceil(magnitude)) / factor;
    if (this.currency?.roundingMethod === 'floor') return (sign * Math.floor(magnitude)) / factor;
    // `round()` في PHP يقرّب النصف بعيداً عن الصفر
    return (sign * Math.round(magnitude + Number.EPSILON)) / factor;
  }
}
