import { describe, expect, it } from 'vitest';
import { PeriodResolver } from '../src/application/services/PeriodResolver';
import { AccountingPeriodRow, FiscalYearRow } from '../src/domain/entities/accounting';
import { FiscalRepository } from '../src/domain/repositories/accounting';

const y2026: FiscalYearRow = { id: 1, name: 'سنة 2026', startDate: '2026-01-01', endDate: '2026-12-31', isCurrent: true };
const y2025: FiscalYearRow = { id: 2, name: 'سنة 2025', startDate: '2025-01-01', endDate: '2025-12-31', isCurrent: false };
const periods: AccountingPeriodRow[] = [
  { id: 11, fiscalYearId: 1, name: 'يناير 2026', startDate: '2026-01-01', endDate: '2026-01-31' },
  { id: 12, fiscalYearId: 1, name: 'فبراير 2026', startDate: '2026-02-01', endDate: '2026-02-28' },
];

const repo = (years: FiscalYearRow[]): FiscalRepository => ({
  yearContaining: async (d) => years.find((y) => y.startDate <= d && d <= y.endDate) ?? null,
  markedCurrentYear: async () => years.find((y) => y.isCurrent) ?? null,
  yearById: async (id) => years.find((y) => y.id === id) ?? null,
  periodById: async (id) => periods.find((p) => p.id === id) ?? null,
  periodIdsOfYear: async (id) => periods.filter((p) => p.fiscalYearId === id).map((p) => p.id),
  options: async () => ({ years, periods }),
});

describe('PeriodResolver — like AccountingPeriodFilter', () => {
  const r = new PeriodResolver(repo([y2026, y2025]));

  it('defaults to the current fiscal year, not to everything', async () => {
    const p = await r.resolve(undefined, '2026-03-10');
    expect(p.isDefault).toBe(true);
    expect(p.label).toBe('سنة 2026');
    expect(p.periodIds).toEqual([11, 12]);
  });

  it('all means no period filter', async () => {
    expect((await r.resolve('all', '2026-03-10')).periodIds).toBeNull();
  });

  it('none means records without a period', async () => {
    expect((await r.resolve('none', '2026-03-10')).periodIds).toEqual([]);
  });

  it('a specific period', async () => {
    const p = await r.resolve('12', '2026-03-10');
    expect(p.periodIds).toEqual([12]);
    expect(p.label).toBe('فبراير 2026');
  });

  it('a year with no periods matches nothing rather than everything', async () => {
    expect((await r.resolve('year:2', '2026-03-10')).periodIds).toEqual([0]);
  });

  it('an unknown period falls back to the default', async () => {
    expect((await r.resolve('999', '2026-03-10')).isDefault).toBe(true);
  });

  it('with no fiscal calendar everything is shown and the absence is flagged', async () => {
    const p = await new PeriodResolver(repo([])).resolve(undefined, '2026-03-10');
    expect(p.periodIds).toBeNull();
    expect(p.unconfigured).toBe(true);
  });
});
