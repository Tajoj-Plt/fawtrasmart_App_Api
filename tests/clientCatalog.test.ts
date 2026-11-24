import { describe, expect, it } from 'vitest';
import { AccessContext } from '../src/domain/services/catalogKit';
import { findClientItem, resolveClientSections } from '../src/domain/services/ClientCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveClientSections(c).flatMap((g) => g.items.map((i) => i.key));
const item = (c: AccessContext, key: string) => resolveClientSections(c).flatMap((g) => g.items).find((i) => i.key === key);

describe('client sidebar sections by role', () => {
  it('shows nothing to a role with no clients_* permission', () => {
    expect(resolveClientSections(ctx(['account.expenses.view']))).toEqual([]);
  });

  it('an "own clients" rep sees the directory and its map but no itinerary section', () => {
    expect(keys(ctx(['clients_dashboard_view', 'clients_view_own_clients']))).toEqual(['overview', 'clients', 'clients_map']);
  });

  it('every client-view permission the API accepts opens the directory and the map', () => {
    for (const p of ['clients_view_all_clients', 'clients_view_own_clients', 'clients_view_by_employee_groups', 'clients_view_by_daily_itinerary']) {
      expect(keys(ctx([p]))).toEqual(expect.arrayContaining(['clients', 'clients_map']));
    }
  });

  it('a role with the itinerary screen permission sees it as its own group', () => {
    const groups = resolveClientSections(ctx(['clients_view_by_daily_itinerary', 'clients_daily_itinerary_view']));
    expect(groups.map((g) => g.key)).toContain('itinerary');
    expect(keys(ctx(['clients_daily_itinerary_add_for_others']))).toEqual(['itinerary']);
  });

  it('gates each itinerary entry with the permission of its web sidebar entry', () => {
    expect(keys(ctx(['clients_itinerary_view']))).toEqual(['team_tracking']);
    expect(keys(ctx(['clients_view_forgotten_visits_own']))).toEqual(['forgotten_visits']);
    expect(keys(ctx(['clients_view_forgotten_visits_all']))).toEqual(['forgotten_visits']);
    expect(keys(ctx(['clients_visit_justifications_view_own']))).toEqual(['visit_justifications']);
    expect(keys(ctx(['clients_visit_justifications_view_all']))).toEqual(['visit_justifications']);
  });

  it('does not open an entry with a permission the API route would refuse', () => {
    // «الزيارات الجارية» في الويب تقبل أيضاً `clients_view_itinerary_dashboard`، لكنّ `GET visits/forgotten` لا يقبلها
    expect(keys(ctx(['clients_view_itinerary_dashboard']))).toEqual([]);
    // صلاحيات العمل داخل الزيارة لا تفتح أقسام القائمة
    expect(keys(ctx(['clients_visit_workspace_access', 'clients_visit_complete', 'clients_itinerary_edit']))).toEqual([]);
  });

  it('a field rep sees the full working set in sidebar order', () => {
    const rep = ctx(['clients_view_by_daily_itinerary', 'clients_daily_itinerary_view', 'clients_visit_workspace_access', 'clients_visit_justifications_view_own', 'clients_view_forgotten_visits_own']);
    expect(keys(rep)).toEqual(['clients', 'clients_map', 'itinerary', 'forgotten_visits', 'visit_justifications']);
  });

  it('hides every client group when the "customers" application is disabled', () => {
    const all = ['clients_dashboard_view', 'clients_view_all_clients', 'clients_daily_itinerary_view', 'clients_itinerary_view', 'clients_view_forgotten_visits_all', 'clients_visit_justifications_view_all', 'doubtful_debts_view'];
    expect(keys(ctx(all, { applicationStatuses: { customers: 'inactive' } }))).toEqual(['overview']);
    expect(keys(ctx(all))).toHaveLength(8);
  });

  it('marks the directory creatable only for a role that may add clients', () => {
    expect(item(ctx(['clients_view_all_clients']), 'clients')?.canCreate).toBe(false);
    expect(item(ctx(['clients_view_all_clients', 'clients_add_client']), 'clients')?.canCreate).toBe(true);
    expect(item(ctx(['clients_view_all_clients', 'clients_add_client']), 'clients_map')?.canCreate).toBe(false);
  });

  it('never marks a section creatable without its add permission', () => {
    const groups = resolveClientSections(ctx(['clients_view_all_clients', 'clients_competitors_view', 'clients_daily_itinerary_view']));
    expect(groups.flatMap((g) => g.items).every((i) => !i.canCreate)).toBe(true);
  });

  it('uses only icon names the app can draw', () => {
    const known = ['layout-dashboard', 'file-minus', 'file-plus', 'landmark', 'book-open', 'git-merge', 'target', 'arrow-up-right', 'arrow-down-left', 'book', 'users', 'swords', 'map', 'alert-triangle', 'package', 'boxes', 'warehouse', 'shopping-cart'];
    for (const key of ['overview', 'clients', 'clients_map', 'competitors', 'itinerary', 'team_tracking', 'forgotten_visits', 'visit_justifications', 'doubtful_debts']) {
      expect(known).toContain(findClientItem(key)?.item.icon);
    }
  });

  it('no client section is tied to a plan feature', () => {
    const all = ctx(['clients_dashboard_view', 'clients_view_all_clients', 'clients_itinerary_view', 'doubtful_debts_view'], { subscriptionLinked: true, planPermissions: { clients: false } });
    expect(resolveClientSections(all).flatMap((g) => g.items).every((i) => !i.locked)).toBe(true);
  });
});
