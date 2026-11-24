import { describe, expect, it } from 'vitest';
import { RepsPerformanceUseCases } from '../src/application/use-cases/sales/RepsPerformanceUseCases';
import { AppError } from '../src/domain/errors/AppError';
import { resolveSalesSections } from '../src/domain/services/SalesCatalog';

const keys = (permissions: string[]) =>
  resolveSalesSections({ permissions: new Set(permissions), applicationStatuses: {}, subscriptionLinked: false, planPermissions: {} })
    .flatMap((g) => g.items.map((i) => i.key));

/** جسرٌ يردّ ما يُلقَّن — ويسجّل ما طُلب منه */
function setup(response: { status: number; body: unknown }, allow = true) {
  const calls: Array<{ method: string; module: string; path: string }> = [];
  const gates: unknown[] = [];
  const contexts = {
    load: async (_userId: number, _meta: unknown, req: unknown) => {
      gates.push(req);
      if (!allow) throw AppError.forbidden('PERMISSION_DENIED', 'لا تملك الصلاحية.');
      return {};
    },
  };
  const bridge = {
    request: async (input: { method: string; module: string; path: string }) => {
      calls.push({ method: input.method, module: input.module, path: input.path });
      return response;
    },
  };
  return { uc: new RepsPerformanceUseCases(contexts as never, bridge as never), calls, gates };
}

describe('«أداء المندوبين» in the sales catalog', () => {
  it('follows the sales dashboard permission, like the web screen', () => {
    expect(keys(['sales.dashboard.view'])).toContain('reps_performance');
    expect(keys(['sales.invoices.view'])).not.toContain('reps_performance');
  });
});

describe('reps performance through the web bridge', () => {
  const body = { success: true, data: { sort: 'collections', reps: [{ rank: 1, name: 'عدنان' }] } };

  it('returns the web screen data as is, gated by the dashboard permission and plan feature', async () => {
    const { uc, calls, gates } = setup({ status: 200, body });
    await expect(uc.report(42, {} as never, {}, 'ar')).resolves.toEqual(body.data);
    expect(calls).toEqual([{ method: 'GET', module: 'sales', path: '/reps-performance' }]);
    expect(gates).toEqual([{ planFeatures: ['dashboard'], permissions: ['sales.dashboard.view'] }]);
  });

  it('passes period, sort and branch with the web parameter names', async () => {
    const { uc, calls } = setup({ status: 200, body });
    await uc.report(42, {} as never, { period: 'year', sort: 'visits', branchId: 9 }, 'ar');
    expect(calls[0].path).toBe('/reps-performance?period=year&sort=visits&branch_id=9');
  });

  it('two explicit dates go as date_from/date_to; a reversed range never reaches the web', async () => {
    const { uc, calls } = setup({ status: 200, body });
    await uc.report(42, {} as never, { fromDate: '2026-01-01', toDate: '2026-03-31' }, 'ar');
    expect(calls[0].path).toBe('/reps-performance?date_from=2026-01-01&date_to=2026-03-31');
    await expect(uc.report(42, {} as never, { fromDate: '2026-03-31', toDate: '2026-01-01' }, 'ar')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(1);
  });

  it('refuses before reaching the web without the permission', async () => {
    const { uc, calls } = setup({ status: 200, body }, false);
    await expect(uc.report(42, {} as never, {}, 'ar')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(calls).toEqual([]);
  });
});
