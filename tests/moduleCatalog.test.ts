import { describe, expect, it } from 'vitest';
import { resolveModules } from '../src/domain/services/ModuleCatalog';
import { tierFor } from '../src/application/use-cases/profile/ProfileUseCases';

const base = { applicationStatuses: {}, subscriptionLinked: false, planPermissions: {} };

describe('resolveModules', () => {
  it('hides modules the role has no permission for', () => {
    const cards = resolveModules({ ...base, permissions: new Set(['sales.invoices.view']) });
    expect(cards.map((c) => c.key)).toEqual(['sales']);
  });

  it('matches prefix gates like the web header (stock.*, account.*)', () => {
    const cards = resolveModules({ ...base, permissions: new Set(['stock.products.view', 'account.expenses.view']) });
    expect(cards.map((c) => c.key)).toEqual(['stock', 'accounts']);
  });

  it('hides modules disabled in application settings', () => {
    const cards = resolveModules({ ...base, permissions: new Set(['sales.invoices.view']), applicationStatuses: { sales: 'inactive' } });
    expect(cards).toHaveLength(0);
  });

  it('locks modules outside the subscription plan', () => {
    const cards = resolveModules({
      permissions: new Set(['sales.invoices.view']),
      applicationStatuses: {},
      subscriptionLinked: true,
      planPermissions: { invoices: false, quotes: false, return_invoices: false, credit_notes: false, periodic_invoices: false, payments: false, dashboard: false, reports: false },
    });
    expect(cards[0].locked).toBe(true);
    expect(cards[0].lockReason).toBe('plan');
  });

  it('treats unknown plan features as permitted', () => {
    const cards = resolveModules({ permissions: new Set(['sales.invoices.view']), applicationStatuses: {}, subscriptionLinked: true, planPermissions: { invoices: false } });
    expect(cards[0].locked).toBe(false);
  });
});

describe('tierFor', () => {
  const tiers = [
    { id: 1, name: 'برونزي', nameEn: 'Bronze', minPoints: 0, maxPoints: 99, color: null, icon: null, sortOrder: 1 },
    { id: 2, name: 'فضي', nameEn: 'Silver', minPoints: 100, maxPoints: null, color: null, icon: null, sortOrder: 2 },
  ];

  it('picks the tier whose range contains the balance', () => {
    expect(tierFor(50, tiers)?.id).toBe(1);
    expect(tierFor(150, tiers)?.id).toBe(2);
  });
});
