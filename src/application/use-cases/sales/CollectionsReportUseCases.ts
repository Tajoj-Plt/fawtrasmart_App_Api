import { AppError } from '../../../domain/errors/AppError';
import { CollectionLine, CollectionsReportRepository, SalesRepository } from '../../../domain/repositories/sales';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { SalesContextFactory } from '../../services/sales/SalesContext';

export type CollectionsGroupBy = 'employee' | 'day' | 'month' | 'client' | 'treasury';

export interface CollectionsReportQuery {
  fromDate?: string;
  toDate?: string;
  employeeId?: number;
  clientId?: number;
  groupBy?: CollectionsGroupBy;
  view?: 'summary' | 'details';
}

/**
 * «المدفوعات حسب الموظف» — `PaymentsByEmployeeController::ajax()` بنطاق الرؤية:
 * محور الفرع يقصّ عملاءَ القيد على شجرة الفرع، ومحور الأشخاص يقصّ منشئَه.
 */
export class CollectionsReportUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly repo: CollectionsReportRepository,
    private readonly sales: SalesRepository,
  ) {}

  async report(userId: number, meta: RequestMeta, q: CollectionsReportQuery) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: ['reports'], permissions: ['sales.reports.payments_by_employee'] });
    const day = (v: string | undefined, fallback: string) => {
      if (!v) return fallback;
      const d = parseInputDate(v);
      if (!d) throw AppError.validation({ date: ['التاريخ بصيغة YYYY-MM-DD.'] }, 'التاريخ بصيغة YYYY-MM-DD.');
      return toSqlDate(d);
    };
    const from = day(q.fromDate, `${ctx.today.slice(0, 7)}-01`);
    const to = day(q.toDate, ctx.today);
    if (from > to) throw AppError.validation({ toDate: ['«إلى» لا يسبق «من».'] }, '«إلى» لا يسبق «من».');

    // النطاق: الفرع (وشجرته) إن كان محورَه، وإلا الأشخاص؛ وفوقه فرع الشريط العلوي
    const state = await ctx.scopeState();
    let nodeIds: number[] | null = ctx.seesAll ? null : state.branchIds;
    const header = await ctx.headerBranchIds();
    if (header) nodeIds = nodeIds === null ? header : nodeIds.filter((id) => header.includes(id));
    const userIds = !ctx.seesAll && (await ctx.peopleAxis()) ? await ctx.documentUserIds() : null;

    const [cash, cancelled, closedRanges] = await Promise.all([this.repo.cashAccounts(), this.repo.cancelledEntryIds(), this.sales.closedRanges()]);
    const lines = await this.repo.lines({ from, to, nodeIds, userIds, employeeId: q.employeeId, clientId: q.clientId, closedRanges }, cash, cancelled);

    const receipts = lines.filter((l) => !l.isReturn);
    const refunds = lines.filter((l) => l.isReturn);
    const groupBy = q.groupBy ?? 'employee';
    const key = (l: CollectionLine): [string, string] => {
      switch (groupBy) {
        case 'day':
          return [l.date, l.date];
        case 'month':
          return [l.date.slice(0, 7), l.date.slice(0, 7)];
        case 'client':
          return [String(l.clientId ?? 'unknown'), l.clientName ?? '—'];
        case 'treasury':
          return [String(l.treasuryId), l.treasuryName ?? '—'];
        default:
          return [String(l.employeeId ?? 'unknown'), l.employeeName ?? '—'];
      }
    };
    const groups = new Map<string, { key: string; name: string; count: number; refundsCount: number; amount: number; items?: CollectionLine[] }>();
    for (const l of lines) {
      const [k, name] = key(l);
      const g = groups.get(k) ?? { key: k, name, count: 0, refundsCount: 0, amount: 0, ...(q.view === 'summary' ? {} : { items: [] }) };
      if (l.isReturn) g.refundsCount++;
      else g.count++;
      g.amount = round2(g.amount + l.amount);
      g.items?.push(l);
      groups.set(k, g);
    }
    const ordered = [...groups.values()].sort((a, b) => (groupBy === 'day' || groupBy === 'month' ? (a.key < b.key ? 1 : -1) : b.amount - a.amount));
    return {
      range: { from, to },
      groupBy,
      totals: {
        count: receipts.length,
        amount: round2(lines.reduce((s, l) => s + l.amount, 0)),
        grossAmount: round2(receipts.reduce((s, l) => s + l.amount, 0)),
        refundsCount: refunds.length,
        refundsAmount: round2(Math.abs(refunds.reduce((s, l) => s + l.amount, 0))),
      },
      groups: ordered,
    };
  }
}
