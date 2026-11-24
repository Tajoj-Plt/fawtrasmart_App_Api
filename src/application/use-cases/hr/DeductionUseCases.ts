import { AppError } from '../../../domain/errors/AppError';
import { DeductionFilters, DeductionRecord, DeductionRepository } from '../../../domain/repositories/hr';
import { DEDUCTION_JOURNAL_PREFIXES, DeductionStatus, DeductionType, HR_PERMISSIONS, HR_PLAN } from '../../../domain/services/hr/HrConstants';
import { deductionActionLabel, deductionProgress, deductionRemaining, deductionStatusLabel, deductionTypeLabel } from '../../../domain/services/hr/HrDomain';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { HrContext, HrContextFactory } from '../../services/hr/HrContext';

export interface DeductionListQuery {
  page?: number;
  perPage?: number;
  status?: DeductionStatus;
  type?: DeductionType;
  search?: string;
  from?: string;
  to?: string;
}

const PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/**
 * الخصميات — عرضٌ فقط. الاعتمادُ والرفضُ والتسويةُ والإلغاء تكتب قيوداً
 * محاسبيةً على ذمّة الموظف، فتبقى في الويب.
 */
export class DeductionUseCases {
  constructor(
    private readonly contexts: HrContextFactory,
    private readonly deductions: DeductionRepository,
  ) {}

  private load(userId: number, meta: RequestMeta) {
    return this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.deductions], permissions: [HR_PERMISSIONS.deductionsIndex] });
  }

  private row(d: DeductionRecord) {
    return {
      id: d.id,
      code: d.code,
      employee: d.employeeId ? { id: d.employeeId, name: d.employeeName ?? `#${d.employeeId}` } : null,
      deductionType: d.deductionType,
      deductionTypeLabel: deductionTypeLabel(d.deductionType),
      amount: round2(d.amount),
      settledAmount: round2(d.settledAmount),
      remainingAmount: deductionRemaining(d.amount, d.settledAmount),
      progressPercentage: deductionProgress(d.amount, d.settledAmount),
      status: d.status,
      statusLabel: deductionStatusLabel(d.status),
      date: d.date,
      reason: d.reason,
      notes: d.notes,
    };
  }

  private async filters(ctx: HrContext, q: DeductionListQuery): Promise<DeductionFilters> {
    return { employeeIds: await ctx.accessibleEmployeeIds(), status: q.status, type: q.type, search: q.search, from: q.from, to: q.to };
  }

  async list(userId: number, meta: RequestMeta, q: DeductionListQuery) {
    const ctx = await this.load(userId, meta);
    const page = Math.max(1, q.page ?? 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, q.perPage ?? PER_PAGE));
    const filters = await this.filters(ctx, q);

    // الإحصاءاتُ على النطاق كلِّه لا على الفلاتر — كما تحسبها شاشةُ الويب
    const [{ rows, total, totals }, stats] = await Promise.all([this.deductions.page(filters, page, perPage), this.deductions.stats(filters)]);

    return { items: rows.map((d) => this.row(d)), total, page, perPage, totals, stats };
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    // `deductions.show` فوق `deductions.index` — كما يحرس الويب `DeductionController@show`
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.deductions], permissions: [HR_PERMISSIONS.deductionsIndex, HR_PERMISSIONS.deductionShow] });

    const deduction = await this.deductions.find(id);
    if (!deduction) throw AppError.notFound('DEDUCTION_NOT_FOUND', 'الخصمية غير موجودة.');
    await ctx.assertEmployeeScope(deduction.employeeId);

    const [journals, history] = await Promise.all([this.deductions.journals(id, DEDUCTION_JOURNAL_PREFIXES), this.deductions.history(id)]);

    return {
      ...this.row(deduction),
      approvedAt: deduction.approvedAt,
      rejectedAt: deduction.rejectedAt,
      rejectionReason: deduction.rejectionReason,
      cancelledAt: deduction.cancelledAt,
      cancellationReason: deduction.cancellationReason,
      settledAt: deduction.settledAt,
      postedAmount: round2(deduction.postedAmount),
      journals,
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        actionLabel: deductionActionLabel(h.action),
        description: h.description,
        notes: h.notes,
        amount: h.amount === null ? null : round2(h.amount),
        at: h.at,
        user: h.userId ? { id: h.userId, name: h.userName ?? '' } : null,
      })),
    };
  }

  /** بطاقةُ «نظرة عامة» — في نطاق المستخدم نفسِه */
  overview(employeeIds: number[] | null) {
    return this.deductions.overview(employeeIds);
  }
}
