import { describe, expect, it } from 'vitest';
import { AccessContext } from '../src/domain/services/catalogKit';
import { resolveHrSections } from '../src/domain/services/HrCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveHrSections(c).flatMap((g) => g.items.map((i) => i.key));
const items = (c: AccessContext) => resolveHrSections(c).flatMap((g) => g.items);

describe('hr sections by role', () => {
  it('shows nothing to a role with no payroll permission', () => {
    expect(resolveHrSections(ctx(['employees.index', 'attendance_records.index']))).toEqual([]);
  });

  it('an employee who may only request an advance sees the overview and that one section', () => {
    expect(keys(ctx(['loans.create']))).toEqual(['overview', 'advanceRequests']);
  });

  it('a payroll officer sees every section, in order', () => {
    const all = ctx(['loans.create', 'loans.index', 'deductions.index', 'payslips.index', 'disbursements.index']);
    expect(resolveHrSections(all).map((g) => g.key)).toEqual(['home', 'salaries']);
    expect(keys(all)).toEqual(['overview', 'advanceRequests', 'advances', 'deductions', 'salarySlips', 'payslips']);
  });

  it('each section follows its own web permission', () => {
    expect(keys(ctx(['deductions.index']))).toEqual(['overview', 'deductions']);
    expect(keys(ctx(['payslips.index']))).toEqual(['overview', 'salarySlips']);
    expect(keys(ctx(['disbursements.index']))).toEqual(['overview', 'payslips']);
    // «عرض السلف» الإداريّة لا تفتح «طلباتي» ولا العكس
    expect(keys(ctx(['loans.index']))).not.toContain('advanceRequests');
    expect(keys(ctx(['loans.create']))).not.toContain('advances');
  });

  it('only requesting an advance is creatable — the rest are read-only', () => {
    const list = items(ctx(['loans.create', 'loans.index', 'deductions.index', 'payslips.index', 'disbursements.index']));
    expect(list.find((i) => i.key === 'advanceRequests')?.canCreate).toBe(true);
    expect(list.filter((i) => i.key !== 'advanceRequests').every((i) => !i.canCreate)).toBe(true);
  });

  it('a section outside the subscription plan is locked, not hidden', () => {
    const c = ctx(['loans.index', 'deductions.index', 'payslips.index', 'disbursements.index'], {
      subscriptionLinked: true,
      planPermissions: { hr_advances: false, hr_deductions: true, hr_payslips: false, hr_payroll: false },
    });
    const list = items(c);
    expect(list.find((i) => i.key === 'advances')?.locked).toBe(true);
    expect(list.find((i) => i.key === 'deductions')?.locked).toBe(false);
    expect(list.find((i) => i.key === 'salarySlips')?.locked).toBe(true);
    expect(list.find((i) => i.key === 'payslips')?.locked).toBe(true);
  });

  it('a locked section cannot be created in either', () => {
    const c = ctx(['loans.create'], { subscriptionLinked: true, planPermissions: { hr_advances: false } });
    const item = items(c).find((i) => i.key === 'advanceRequests');
    expect(item?.locked).toBe(true);
    expect(item?.canCreate).toBe(false);
  });

  it('a plan key the subscription never mentions stays allowed', () => {
    const c = ctx(['loans.index'], { subscriptionLinked: true, planPermissions: {} });
    expect(items(c).find((i) => i.key === 'advances')?.locked).toBe(false);
  });

  it('turning "salaries" off in application settings hides the whole payroll group', () => {
    const c = ctx(['loans.create', 'loans.index', 'deductions.index', 'payslips.index', 'disbursements.index'], { applicationStatuses: { salaries: 'inactive' } });
    expect(keys(c)).toEqual(['overview']);
  });

  it('disabling another HR app key leaves the payroll group alone', () => {
    const c = ctx(['loans.index'], { applicationStatuses: { employees: 'inactive' } });
    expect(keys(c)).toEqual(['overview', 'advances']);
  });
});
