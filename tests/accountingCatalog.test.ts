import { describe, expect, it } from 'vitest';
import { AccessContext, evaluateItem, findAccountingItem, resolveAccountingSections } from '../src/domain/services/AccountingCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveAccountingSections(c).flatMap((g) => g.items.map((i) => i.key));

describe('accounting sidebar sections by role', () => {
  it('shows nothing to a role with no account.* permission', () => {
    expect(resolveAccountingSections(ctx(['sales.invoices.view']))).toEqual([]);
  });

  it('a limited accountant sees overview plus only what the role allows', () => {
    expect(keys(ctx(['account.expenses.view', 'account.treasury.view']))).toEqual(['overview', 'expenses', 'treasuries']);
  });

  it('a full role sees every section, grouped like the web sidebar', () => {
    const all = ctx([
      'account.expenses.view', 'account.incomes.view', 'account.treasury.view', 'account.journal.view', 'account.chart.view',
      'account.cost_centers.view', 'account.payable_cheques.view', 'account.received_cheques.view', 'account.cheque_books.view',
    ]);
    const groups = resolveAccountingSections(all);
    expect(groups.map((g) => g.key)).toEqual(['home', 'finance', 'general', 'cheques']);
    expect(keys(all)).toHaveLength(10);
  });

  it('hides a whole group when its application is disabled in application settings', () => {
    const c = ctx(['account.expenses.view', 'account.journal.view'], { applicationStatuses: { finance: 'inactive' } });
    expect(keys(c)).toEqual(['overview', 'journal']);
  });

  it('shows items outside the subscription plan as locked, not hidden', () => {
    const c = ctx(['account.expenses.view'], { subscriptionLinked: true, planPermissions: { expenses: false } });
    const item = resolveAccountingSections(c).flatMap((g) => g.items).find((i) => i.key === 'expenses');
    expect(item?.locked).toBe(true);
  });

  it('treats plan features the catalog does not mention as permitted', () => {
    const c = ctx(['account.expenses.view'], { subscriptionLinked: true, planPermissions: { something_else: false } });
    expect(resolveAccountingSections(c).flatMap((g) => g.items).find((i) => i.key === 'expenses')?.locked).toBe(false);
  });

  it('evaluateItem agrees with the sidebar (used to guard the endpoints)', () => {
    const found = findAccountingItem('incomes')!;
    expect(evaluateItem(found.group, found.item, ctx(['account.expenses.view'])).visible).toBe(false);
    expect(evaluateItem(found.group, found.item, ctx(['account.incomes.view'])).visible).toBe(true);
  });
});
