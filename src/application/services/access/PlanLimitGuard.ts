import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { UsageCounter } from '../../../domain/repositories/stock';
import { endOfDay, parseLocal, startOfDay, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { Cache } from '../../ports';

/**
 * الحدود المعدودة وجداولها — `UsageReporter::catalog()`:
 *   quota — ما أُنشئ خلال نافذة الباقة (يومي/شهري/طوال مدتها).
 *   cap   — ما يشغل مكاناً الآن، كلُّ الصفوف.
 */
const CATALOG: Record<string, { table: string; kind: 'quota' | 'cap'; where?: [string, Array<string | number>] }> = {
  sales_invoices: { table: 'invoices', kind: 'quota', where: ['type', ['normal', 'pos', 'online']] },
  return_invoices: { table: 'invoices', kind: 'quota', where: ['type', ['returned']] },
  sales_payments: { table: 'payments_process', kind: 'quota', where: ['type', ['client payments']] },
  credit_notes: { table: 'credit_notifications', kind: 'quota' },
  quotes: { table: 'quotes', kind: 'quota' },
  product_exchanges: { table: 'product_exchanges', kind: 'quota' },
  warehouse_permits: { table: 'warehouse_permits', kind: 'quota' },
  journal_entries: { table: 'journal_entries', kind: 'quota' },
  price_lists: { table: 'price_lists', kind: 'cap' },
  // طلباتُ السلف عدّادٌ شهريّ على جدول الطلبات الجديد لا على `salary_advances` القديم
  advance_requests: { table: 'salary_advance_requests', kind: 'quota' },
  internal_notifications: { table: 'notifications', kind: 'quota' },
};

/** `UsageReporter::window()` — نافذة العدّ بحسب دورة الحدّ */
export function usageWindow(period: string | null, now: Date, subscriptionStart: string | null): [string, string] | null {
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

/**
 * `SubscriptionGate::checkLive()` — حارس `plan.limit` على المسار و`PlanLimitObserver`
 * على النموذج: المستهلَك أكبرُ العددين (لقطة فوترة والعدّ الحيّ)، فإن لم يتّسع
 * الباقي للعملية رُدّت بـ402 ورسالة الويب نفسها.
 */
export class PlanLimitGuard {
  constructor(
    private readonly reference: ClientsReferenceRepository,
    private readonly counter: UsageCounter,
    private readonly cache: Cache,
  ) {}

  /** المستهلَك والمتاح لحدٍّ واحد — `null` إن لم يكن محدوداً أصلاً */
  async describe(feature: string, now: Date): Promise<{ reached: boolean; used: number; max: number } | null> {
    const measured = await this.measure(feature, now);
    if (!measured) return null;
    return { reached: measured.used >= measured.item.allowance, used: measured.used, max: measured.item.allowance };
  }

  private async measure(feature: string, now: Date) {
    const { item, subscriptionStart } = await this.cache.wrap(`erp:plan-usage:${feature}`, 60, () => this.reference.planUsage(feature));
    if (!item || item.unlimited) return null;

    const meta = CATALOG[feature];
    let counted: number | null = null;
    if (meta) {
      if (meta.kind === 'cap') counted = await this.counter.count(meta.table, undefined, undefined, meta.where);
      else {
        const window = usageWindow(item.period, now, subscriptionStart);
        if (window) counted = await this.counter.count(meta.table, window[0], window[1], meta.where);
      }
    }

    return { item, used: counted === null ? item.used : Math.max(item.used, counted) };
  }

  async assert(feature: string, now: Date, quantity = 1): Promise<void> {
    const measured = await this.measure(feature, now);
    if (!measured) return;
    const { item, used } = measured;

    const remaining = Math.max(0, item.allowance - used);
    if (remaining >= quantity) return;

    const message =
      quantity > 1
        ? `حدّ «${item.label}» في باقة فوترة لا يتّسع لهذه العملية: المستهلَك ${used} من ${item.allowance}، والمتبقّي ${remaining} فقط بينما العملية تحتاج ${quantity}. اشترِ إضافة أو احذف ما لم يعد مستعمَلاً.`
        : `بلغت حدّ «${item.label}» في باقة فوترة: ${used} من ${item.allowance}. اشترِ إضافة أو احذف ما لم يعد مستعمَلاً.`;
    throw new AppError('PLAN_LIMIT_REACHED', message, 402, { feature, remaining });
  }
}
