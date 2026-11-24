import { describe, expect, it } from 'vitest';
import { AccessContext } from '../src/domain/services/catalogKit';
import { resolveStockSections } from '../src/domain/services/StockCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveStockSections(c).flatMap((g) => g.items.map((i) => i.key));

describe('stock sidebar sections by role', () => {
  it('shows nothing to a role with no stock.* permission', () => {
    expect(resolveStockSections(ctx(['clients_view_all_clients']))).toEqual([]);
  });

  it('a warehouse clerk sees only what the role allows', () => {
    expect(keys(ctx(['stock.', 'stock.warehouses.view']))).toEqual(['overview', 'warehouses']);
  });

  it('a full role sees every section, in the web sidebar order', () => {
    const all = ctx(['stock.', 'stock.products.view', 'stock.warehouses.view', 'stock.permits.view', 'stock.adjustments.view', 'stock.price_lists.view', 'stock.reports.employee_statement']);
    const groups = resolveStockSections(all);
    expect(groups.map((g) => g.key)).toEqual(['home', 'stock']);
    expect(keys(all)).toEqual(['overview', 'products', 'permits', 'priceLists', 'warehouses', 'adjustments', 'statement']);
  });

  it('price lists and the warehouse statement follow their own web permissions', () => {
    expect(keys(ctx(['stock.', 'stock.price_lists.view']))).toEqual(['overview', 'priceLists']);
    expect(keys(ctx(['stock.', 'stock.reports.employee_statement']))).toEqual(['overview', 'statement']);
    // عرض المستودعات وحده لا يفتح الكشف المخزني
    expect(keys(ctx(['stock.', 'stock.warehouses.view']))).not.toContain('statement');
  });

  it('locks price lists and the statement by their plan features', () => {
    const c = ctx(['stock.', 'stock.price_lists.view', 'stock.reports.employee_statement'], { subscriptionLinked: true, planPermissions: { stock_price_lists: false, stock_storehouses: false } });
    const items = resolveStockSections(c).flatMap((g) => g.items);
    expect(items.find((i) => i.key === 'priceLists')?.locked).toBe(true);
    expect(items.find((i) => i.key === 'statement')?.locked).toBe(true);
  });

  it('hides the whole stock group when "inventory_management" is disabled in application settings', () => {
    const c = ctx(['stock.', 'stock.products.view'], { applicationStatuses: { inventory_management: 'inactive' } });
    expect(keys(c)).toEqual(['overview']);
  });

  it('shows a section outside the subscription plan as locked, not hidden', () => {
    const c = ctx(['stock.', 'stock.products.view'], { subscriptionLinked: true, planPermissions: { stock_products: false } });
    const item = resolveStockSections(c).flatMap((g) => g.items).find((i) => i.key === 'products');
    expect(item?.locked).toBe(true);
  });

  it('marks a section creatable only with its create permission', () => {
    const viewOnly = resolveStockSections(ctx(['stock.', 'stock.warehouses.view', 'stock.permits.view', 'stock.price_lists.view']));
    expect(viewOnly.flatMap((g) => g.items).every((i) => !i.canCreate)).toBe(true);

    const items = resolveStockSections(ctx(['stock.', 'stock.permits.view', 'stock.permits.create_transfer', 'stock.price_lists.view', 'stock.price_lists.create', 'stock.reports.employee_statement'])).flatMap((g) => g.items);
    expect(items.find((i) => i.key === 'permits')?.canCreate).toBe(true);
    expect(items.find((i) => i.key === 'priceLists')?.canCreate).toBe(true);
    expect(items.find((i) => i.key === 'statement')?.canCreate).toBe(false);
  });
});
