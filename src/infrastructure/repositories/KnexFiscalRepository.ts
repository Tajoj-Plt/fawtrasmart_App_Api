import { Knex } from 'knex';
import { AccountingPeriodRow, FiscalYearRow } from '../../domain/entities/accounting';
import { FiscalRepository } from '../../domain/repositories/accounting';
import { bool } from '../db/knex';

const day = (v: unknown) => (v ? String(v).slice(0, 10) : '');

const year = (r: Record<string, unknown>): FiscalYearRow => ({
  id: Number(r.id),
  name: String(r.name ?? ''),
  startDate: day(r.start_date),
  endDate: day(r.end_date),
  isCurrent: bool(r.is_current),
});

const period = (r: Record<string, unknown>): AccountingPeriodRow => ({
  id: Number(r.id),
  fiscalYearId: Number(r.fiscal_year_id),
  name: String(r.name ?? ''),
  startDate: day(r.start_date),
  endDate: day(r.end_date),
});

/** السنوات والفترات المحاسبية — تُقرأ بحذر: غياب الجدول يعني «لا تقويم مالي» لا خطأً */
export class KnexFiscalRepository implements FiscalRepository {
  constructor(private readonly db: Knex) {}

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  yearContaining(date: string) {
    return this.safe(async () => {
      const r = await this.db('fiscal_years').where('start_date', '<=', date).where('end_date', '>=', date).orderBy('start_date', 'desc').first();
      return r ? year(r) : null;
    }, null);
  }

  markedCurrentYear() {
    return this.safe(async () => {
      const r = await this.db('fiscal_years').where('is_current', 1).first();
      return r ? year(r) : null;
    }, null);
  }

  yearById(id: number) {
    return this.safe(async () => {
      const r = await this.db('fiscal_years').where('id', id).first();
      return r ? year(r) : null;
    }, null);
  }

  periodById(id: number) {
    return this.safe(async () => {
      const r = await this.db('accounting_periods').where('id', id).first();
      return r ? period(r) : null;
    }, null);
  }

  periodIdsOfYear(yearId: number) {
    return this.safe(async () => (await this.db('accounting_periods').where('fiscal_year_id', yearId).pluck('id')).map(Number), [] as number[]);
  }

  options() {
    return this.safe(
      async () => {
        const years = await this.db('fiscal_years').orderBy('start_date', 'desc');
        const periods = await this.db('accounting_periods').orderBy('start_date', 'desc');
        return { years: years.map(year), periods: periods.map(period) };
      },
      { years: [] as FiscalYearRow[], periods: [] as AccountingPeriodRow[] },
    );
  }
}
