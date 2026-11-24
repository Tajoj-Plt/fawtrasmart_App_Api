import { PeriodGuardRepository, PeriodSettings } from '../../../domain/repositories/stock';
import { parseLocal, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { Cache } from '../../ports';

/** `settings.accounting_periods.block.*` في ملف اللغة العربي */
const MESSAGES = {
  year_closed: 'التاريخ :date يقع في السنة المالية «:year» وهي مقفلة.',
  period_closed: 'الفترة «:period» مقفلة — لا يُقبل قيد بتاريخ :date.',
  period_locked: 'الفترة «:period» مقفلة نهائياً — لا يُقبل قيد بتاريخ :date.',
  before_lock_date: 'التاريخ :date سابق لتاريخ القفل :lock_date.',
  undefined: 'التاريخ :date لا تغطّيه أي فترة محاسبية معرَّفة.',
  future: 'التاريخ :date مستقبلي، والقيد بتاريخ مستقبلي ممنوع.',
} as const;

type Reason = keyof typeof MESSAGES;

/**
 * `RespectsAccountingPeriods::accountingPeriodBlock()` و`AccountingPeriodService::check()`:
 * لا يُفتح مستندٌ ولا يُرحَّل قيدٌ بتاريخٍ داخل فترةٍ مقفلة. صاحب صلاحية التجاوز
 * يمرّ، والفحص الذي يتعثّر يسمح (كالويب) ولا يُسقط العملية.
 */
export class AccountingPeriodGuard {
  constructor(
    private readonly repo: PeriodGuardRepository,
    private readonly cache: Cache,
  ) {}

  settings(): Promise<PeriodSettings> {
    return this.cache.wrap('erp:accounting-period-settings', 60, () => this.repo.settings());
  }

  /** رسالة المنع، أو `null` إن كان التاريخ مسموحاً */
  async block(date: string | null, today: string, can: (permission: string) => boolean): Promise<string | null> {
    try {
      const settings = await this.settings();
      if (settings.overridePermission && can(settings.overridePermission)) return null;

      const parsed = date ? parseLocal(date) : null;
      const day = parsed ? toSqlDate(parsed) : today;

      const period = await this.repo.periodFor(day);
      const year = (period?.fiscalYearId ? await this.repo.fiscalYear(period.fiscalYearId) : null) ?? (await this.repo.fiscalYearFor(day));

      const reason = this.reason(settings, day, today, period, year);
      if (!reason) return null;

      return MESSAGES[reason]
        .replace(':date', day)
        .replace(':period', period?.name ?? '—')
        .replace(':year', year?.name ?? '—')
        .replace(':lock_date', settings.lockBeforeDate ?? '—');
    } catch {
      // فحصٌ تعثّر (جدول غير مهيّأ) — يُسمح كالويب
      return null;
    }
  }

  private reason(
    s: PeriodSettings,
    day: string,
    today: string,
    period: { status: string } | null,
    year: { status: string } | null,
  ): Reason | null {
    if (!s.enforceLock) return null;
    if (s.lockBeforeDate && day < s.lockBeforeDate) return 'before_lock_date';
    if (s.blockFutureDates && day > today) return 'future';
    if (!period) return s.blockUndefinedDates ? 'undefined' : null;
    if (period.status === 'locked') return 'period_locked';
    if (period.status === 'closed') return 'period_closed';
    if (year && year.status !== 'open') return 'year_closed';
    return null;
  }
}
