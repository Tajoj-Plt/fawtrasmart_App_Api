import { AccountingPeriodRow, FiscalYearRow } from '../../domain/entities/accounting';
import { FiscalRepository } from '../../domain/repositories/accounting';

export interface ResolvedPeriod {
  /** المفتاح الذي يُرسله التطبيق: all | none | year:ID | ID | null (الافتراضي) */
  key: string | null;
  label: string;
  /**
   * معرّفات الفترات:  null بلا قيد · [] السند بلا فترة · [0] لا يطابق شيئاً (سنة بلا فترات)
   * — كما في `AccountingPeriodFilter::apply`.
   */
  periodIds: number[] | null;
  isDefault: boolean;
  unconfigured: boolean;
  from: string | null;
  to: string | null;
}

export interface PeriodOptions {
  years: FiscalYearRow[];
  periods: AccountingPeriodRow[];
}

/**
 * ترجمة `App\Support\AccountingPeriodFilter::resolve()` — الافتراضي السنة المالية الجارية
 * لا «كل السجلات»، فلا تزاحم سندات سنواتٍ مضت سندات الفترة التي يعمل عليها المحاسب.
 */
export class PeriodResolver {
  constructor(private readonly fiscal: FiscalRepository) {}

  private async yearShape(year: FiscalYearRow, key: string | null, isDefault: boolean, unconfigured = false): Promise<ResolvedPeriod> {
    const ids = await this.fiscal.periodIdsOfYear(year.id);
    return {
      key,
      label: year.name,
      periodIds: ids.length > 0 ? ids : [0],
      isDefault,
      unconfigured,
      from: year.startDate,
      to: year.endDate,
    };
  }

  private async currentYear(today: string): Promise<FiscalYearRow | null> {
    const containing = await this.fiscal.yearContaining(today);
    if (containing) return containing;

    const marked = await this.fiscal.markedCurrentYear();
    if (marked && marked.startDate <= today && today <= marked.endDate) return marked;

    return null;
  }

  async resolve(requested: string | undefined | null, today = new Date().toISOString().slice(0, 10)): Promise<ResolvedPeriod> {
    if (requested === 'all') {
      return { key: 'all', label: 'كل الفترات', periodIds: null, isDefault: false, unconfigured: false, from: null, to: null };
    }

    if (requested === 'none') {
      return { key: 'none', label: 'بلا فترة', periodIds: [], isDefault: false, unconfigured: false, from: null, to: null };
    }

    if (requested && requested.startsWith('year:')) {
      const year = await this.fiscal.yearById(Number(requested.slice(5)));
      if (year) return this.yearShape(year, requested, false);
    }

    if (requested && /^\d+$/.test(requested)) {
      const period = await this.fiscal.periodById(Number(requested));
      if (period) {
        return { key: requested, label: period.name, periodIds: [period.id], isDefault: false, unconfigured: false, from: period.startDate, to: period.endDate };
      }
    }

    const year = await this.currentYear(today);
    if (year) return this.yearShape(year, `year:${year.id}`, true);

    // لا سنة مالية معرَّفة: تُعرض العمليات كلها ويُعلَن الغياب
    return { key: null, label: 'لا سنة مالية معرَّفة', periodIds: null, isDefault: true, unconfigured: true, from: null, to: null };
  }

  options(): Promise<PeriodOptions> {
    return this.fiscal.options();
  }
}
