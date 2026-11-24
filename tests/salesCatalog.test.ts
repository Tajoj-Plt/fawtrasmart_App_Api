import { describe, expect, it } from 'vitest';
import { AccessContext } from '../src/domain/services/catalogKit';
import { findSalesItem, resolveSalesSections } from '../src/domain/services/SalesCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveSalesSections(c).flatMap((g) => g.items.map((i) => i.key));
const item = (c: AccessContext, key: string) => resolveSalesSections(c).flatMap((g) => g.items).find((i) => i.key === key);

const FULL = [
  'sales.dashboard.view',
  'sales.invoices.view',
  'sales.quotes.view',
  'sales.sales_orders.view',
  'sales.credit_notes.view',
  'sales.returns.view',
  'sales.payments.view',
  'sales.exchanges.view',
  'sales.daily_closing.view',
  'sales.commissions.view',
  'sales.reports.payments_by_employee',
];

describe('sales sidebar sections by role', () => {
  it('shows nothing to a role with no sales.* permission', () => {
    expect(resolveSalesSections(ctx(['stock.products.view']))).toEqual([]);
  });

  it('a sales rep sees only what the role allows (plus "my targets", open to any sales role)', () => {
    expect(keys(ctx(['sales.dashboard.view', 'sales.invoices.view']))).toEqual(['overview', 'invoices', 'reps_performance', 'my_targets']);
  });

  it('a full role sees every section, grouped and ordered like the web sidebar', () => {
    const all = ctx(FULL);
    expect(resolveSalesSections(all).map((g) => g.key)).toEqual(['home', 'sales', 'performance']);
    expect(keys(all)).toEqual(['overview', 'invoices', 'quotes', 'sales_orders', 'credit_notes', 'returns', 'payments', 'exchanges', 'daily_closing', 'reps_performance', 'my_targets', 'my_commissions', 'payments_report']);
  });

  it('each section is gated by the permission the web sidebar checks', () => {
    const gates: Record<string, string> = {
      quotes: 'sales.quotes.view',
      sales_orders: 'sales.sales_orders.view',
      credit_notes: 'sales.credit_notes.view',
      returns: 'sales.returns.view',
      payments: 'sales.payments.view',
      exchanges: 'sales.exchanges.view',
      daily_closing: 'sales.daily_closing.view',
      my_commissions: 'sales.commissions.view',
      payments_report: 'sales.reports.payments_by_employee',
    };
    for (const [key, permission] of Object.entries(gates)) {
      expect(keys(ctx([permission]))).toContain(key);
      expect(keys(ctx(FULL.filter((p) => p !== permission)))).not.toContain(key);
    }
  });

  it('hides every group when "sales" is disabled in application settings — as the web does', () => {
    expect(keys(ctx(FULL, { applicationStatuses: { sales: 'inactive' } }))).toEqual([]);
  });

  it('shows a section outside the subscription plan as locked, not hidden', () => {
    const c = ctx(FULL, { subscriptionLinked: true, planPermissions: { invoices: false, quotes: false, product_exchanges: false, reports: false, target_settings: false, dashboard: false } });
    for (const key of ['overview', 'invoices', 'quotes', 'sales_orders', 'exchanges', 'payments_report', 'my_targets']) expect(item(c, key)?.locked).toBe(true);
    for (const key of ['returns', 'payments', 'credit_notes', 'daily_closing', 'my_commissions']) expect(item(c, key)?.locked).toBe(false);
  });

  it('marks a section creatable only with its create permission and inside the plan', () => {
    const viewer = ctx(FULL);
    expect(resolveSalesSections(viewer).flatMap((g) => g.items).every((i) => !i.canCreate)).toBe(true);

    const maker = ctx([...FULL, 'sales.invoices.create', 'sales.quotes.create', 'sales.sales_orders.create', 'sales.payments.create', 'sales.credit_notes.create', 'sales.exchanges.create', 'sales.daily_closing.auto_close']);
    for (const key of ['invoices', 'quotes', 'sales_orders', 'payments', 'credit_notes', 'exchanges', 'daily_closing']) expect(item(maker, key)?.canCreate).toBe(true);
    // المرتجع يُنشأ من فاتورته لا من القائمة
    expect(item(maker, 'returns')?.canCreate).toBe(false);

    const locked = ctx(['sales.invoices.view', 'sales.invoices.create'], { subscriptionLinked: true, planPermissions: { invoices: false } });
    expect(item(locked, 'invoices')?.canCreate).toBe(false);
  });

  it('keeps the five list sections the generic list routes resolve', () => {
    for (const key of ['invoices', 'quotes', 'returns', 'credit_notes', 'payments']) expect(findSalesItem(key)).not.toBeNull();
  });
});
