import { AppError } from '../../../domain/errors/AppError';
import { PerformanceRepository, TargetKind } from '../../../domain/repositories/sales';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { SalesContextFactory } from '../../services/sales/SalesContext';

const METHOD_LABELS: Record<string, string> = {
  net_sales: 'صافي المبيعات (بعد المرتجعات والإشعارات الدائنة)',
  gross_sales: 'إجمالي المبيعات',
  paid_only: 'الفواتير المسدَّدة فقط',
  total_collected: 'إجمالي التحصيل',
  cash_only: 'التحصيل النقدي فقط',
  bank_only: 'التحصيل البنكي فقط',
};

/**
 * خدمة المندوب الذاتية — «أهدافي» و«عمولاتي»: إنجازُه في كل هدفٍ هو فيه
 * بطريقة الاحتساب المضبوطة (`TargetCalculationService`) وعمولتُه بمستوياتها،
 * وعمولاتُه الأسبوعية المستحقّة والمصروفة. بياناته هو وحده — لا معرّف موظّفٍ في الطلب.
 */
export class MyPerformanceUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly repo: PerformanceRepository,
  ) {}

  private range(from: string | undefined, to: string | undefined, today: string) {
    const parse = (v: string | undefined, fallback: string) => {
      if (!v) return fallback;
      const d = parseInputDate(v);
      if (!d) throw AppError.validation({ date: ['التاريخ بصيغة YYYY-MM-DD.'] }, 'التاريخ بصيغة YYYY-MM-DD.');
      return toSqlDate(d);
    };
    const start = parse(from, `${today.slice(0, 7)}-01`);
    const end = parse(to, today);
    if (start > end) throw AppError.validation({ toDate: ['«إلى» لا يسبق «من».'] }, '«إلى» لا يسبق «من».');
    return { start, end };
  }

  /** `calculateCommission()` — أعلى مستوى بلغه، من المبلغ المحقَّق؛ وبلا مستويات النسبةُ الافتراضية */
  private commission(achieved: number, target: number, base: number, tiers: Array<{ achievement: number; commission: number }>) {
    if (target <= 0) return { amount: 0, percentage: 0, tier: null as null | { achievement: number; commission: number } };
    const pct = (achieved / target) * 100;
    if (tiers.length) {
      const tier = [...tiers].sort((a, b) => b.achievement - a.achievement).find((t) => pct >= t.achievement) ?? null;
      return { amount: tier ? round2(achieved * (tier.commission / 100)) : 0, percentage: pct, tier };
    }
    return { amount: round2(achieved * (base / 100)), percentage: pct, tier: null };
  }

  private async salesBreakdown(userId: number, method: string, from: string, to: string) {
    const salesAcc = await this.repo.accountId('sales');
    const returnsAcc = await this.repo.accountId('sales_returns');
    const gross = salesAcc ? -(await this.repo.accountNet(userId, salesAcc, 'SI', from, to)) : 0;
    const paid = salesAcc ? -(await this.repo.accountNet(userId, salesAcc, 'SI', from, to, true)) : 0;
    const returns = returnsAcc ? await this.repo.accountNet(userId, returnsAcc, 'SR', from, to) : 0;
    const credits = returnsAcc ? await this.repo.accountNet(userId, returnsAcc, 'CN', from, to) : 0;
    const net = Math.max(0, gross - returns - credits);
    const achieved = method === 'gross_sales' ? gross : method === 'paid_only' ? paid : net;
    return { grossSales: round2(gross), paidSales: round2(paid), returns: round2(returns), creditNotes: round2(credits), netSales: round2(net), achieved: round2(achieved) };
  }

  private async collectionsBreakdown(userId: number, method: string, from: string, to: string) {
    const cash = await this.repo.descendantsOf(await this.repo.accountId('cash_treasuries_parent'));
    const bank = await this.repo.descendantsOf(await this.repo.accountId('bank_accounts_parent'));
    const all = [...new Set([...cash, ...bank])];
    const counted = method === 'cash_only' ? cash : method === 'bank_only' ? bank : all;
    const entries = await this.repo.collectionEntries(userId, all, from, to);
    const invoicePayments = await this.repo.debitSum(entries.filter((e) => e.invoiceId !== null).map((e) => e.id), counted);
    const receipts = await this.repo.debitSum(entries.filter((e) => e.invoiceId === null).map((e) => e.id), counted);
    return { invoicePayments: round2(invoicePayments), receipts: round2(receipts), achieved: round2(invoicePayments + receipts) };
  }

  async targets(userId: number, meta: RequestMeta, q: { fromDate?: string; toDate?: string }) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: ['target_settings'] });
    const { start, end } = this.range(q.fromDate, q.toDate, ctx.today);
    const from = `${start} 00:00:00`;
    const to = `${end} 23:59:59`;
    const out: Record<TargetKind, unknown[]> = { sales: [], collections: [] };
    for (const kind of ['sales', 'collections'] as const) {
      const method = (await this.repo.calculationMethod(kind)) ?? (kind === 'sales' ? 'net_sales' : 'total_collected');
      const targets = await this.repo.targetsFor(kind, ctx.user.id);
      if (!targets.length) continue;
      const breakdown = kind === 'sales' ? await this.salesBreakdown(ctx.user.id, method, from, to) : await this.collectionsBreakdown(ctx.user.id, method, from, to);
      out[kind] = targets.map((t) => {
        const c = this.commission(breakdown.achieved, t.targetAmount, t.commissionPercentage, t.tiers);
        return {
          id: t.id,
          name: t.name,
          period: t.period,
          method,
          methodLabel: METHOD_LABELS[method] ?? method,
          targetAmount: t.targetAmount,
          achieved: breakdown.achieved,
          remaining: round2(Math.max(0, t.targetAmount - breakdown.achieved)),
          percentage: round2(c.percentage),
          commissionPercentage: c.tier ? c.tier.commission : t.commissionPercentage,
          appliedTier: c.tier,
          commission: c.amount,
          breakdown,
        };
      });
    }
    return { range: { from: start, to: end }, ...out };
  }

  async commissions(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta, { permissions: ['sales.commissions.view'] });
    if (!ctx.user.employeeId) return { employee: false, pending: [], paid: [], totalPending: 0, totalPaidLast30Days: 0, treasury: null };
    const since = new Date(ctx.now.getTime() - 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const { pending, paid } = await this.repo.weeklyCommissions(ctx.user.employeeId, since);
    return {
      employee: true,
      pending,
      paid,
      totalPending: round2(pending.reduce((s, c) => s + c.amount, 0)),
      totalPaidLast30Days: round2(paid.reduce((s, c) => s + c.amount, 0)),
      treasury: await this.repo.employeeTreasury(ctx.user.employeeId),
    };
  }
}
