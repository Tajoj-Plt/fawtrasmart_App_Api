import { AppError } from '../../../domain/errors/AppError';
import { ErpBridge } from '../../ports';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { SalesContextFactory } from '../../services/sales/SalesContext';
import { assertBridgeAvailable, interpretErpResult } from '../forms/GenericFormsUseCases';

/** فتراتُ شاشة الويب (`ReportPeriod::TABS`) — والمدى المخصَّص بتاريخين */
export const REP_PERIODS = ['today', 'week', 'month', 'quarter', 'year'] as const;
/** أعمدةُ الترتيب (`SalesDashboardMetrics::REP_SORTS`) */
export const REP_SORTS = ['collections', 'sales', 'net_sales', 'returns_total', 'invoices', 'visits'] as const;

export interface RepsPerformanceQuery {
  period?: (typeof REP_PERIODS)[number];
  sort?: (typeof REP_SORTS)[number];
  fromDate?: string;
  toDate?: string;
  branchId?: number;
}

/**
 * «أداء المندوبين» — **شاشة الويب نفسها عبر الجسر** (`DashboardController::reps`)، لا حسابٌ ثانٍ.
 *
 * المبيعات والمرتجعات والتحصيل من دفتر العملاء، والمصروفات والزيارات وخط السير والهدف الشهري —
 * كلُّها في `SalesDashboardMetrics::salesByEmployee()` بالويب، وبفرع المستخدم وشجرته كما تحسبه اللوحة.
 * فيُطلب الناتج منه بحساب المستخدم نفسه (`GET /api/mobile/sales/reps-performance`).
 */
export class RepsPerformanceUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly bridge: ErpBridge,
  ) {}

  async report(userId: number, meta: RequestMeta, q: RepsPerformanceQuery, lang: 'ar' | 'en') {
    await this.contexts.load(userId, meta, { planFeatures: ['dashboard'], permissions: ['sales.dashboard.view'] });
    if (q.fromDate && q.toDate && q.fromDate > q.toDate) throw AppError.validation({ toDate: ['«إلى» لا يسبق «من».'] }, '«إلى» لا يسبق «من».');

    const query = new URLSearchParams();
    if (q.period) query.set('period', q.period);
    if (q.sort) query.set('sort', q.sort);
    // تاريخان صريحان يتقدّمان على مفتاح الفترة — كما في الويب
    if (q.fromDate && q.toDate) {
      query.set('date_from', q.fromDate);
      query.set('date_to', q.toDate);
    }
    if (q.branchId) query.set('branch_id', String(q.branchId));
    const qs = query.toString();

    const res = await this.bridge.request({ userId, method: 'GET', module: 'sales', path: `/reps-performance${qs ? `?${qs}` : ''}`, lang });
    assertBridgeAvailable(res);
    interpretErpResult(res);
    return (res.body as { data?: unknown }).data ?? {};
  }
}
