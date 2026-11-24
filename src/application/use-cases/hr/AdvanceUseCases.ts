import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { AdvanceFilters, AdvanceRepository, AdvanceRequestRecord, HrReferenceRepository, LegacyAdvanceRecord } from '../../../domain/repositories/hr';
import {
  ADVANCE_APPROVER_DEPARTMENTS_SETTING,
  ADVANCE_JOURNAL_PREFIXES,
  ADVANCE_NOTIFICATION_TYPE,
  ADVANCE_REQUESTS_LIMIT,
  ADVANCE_STAGE_LABELS,
  ADVANCE_WITHDRAW_REASON,
  AdvanceStage,
  HR_PERMISSIONS,
  HR_PLAN,
  LEGACY_ADVANCE_CURRENCIES,
  LEGACY_ADVANCE_JOURNAL_PREFIXES,
  LEGACY_ADVANCE_STAGES,
} from '../../../domain/services/hr/HrConstants';
import {
  advanceNotificationName,
  advanceRemainingAmount,
  advanceStage,
  filterApprovers,
  legacyAdvanceRemaining,
  legacyAdvanceStage,
  legacyAdvanceType,
  parseApproverDepartmentIds,
} from '../../../domain/services/hr/HrDomain';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { Cache, UnitOfWork } from '../../ports';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { CurrencyFormatter } from '../../services/clients/ClientsSupport';
import { validateAdvanceRequest } from '../../services/hr/AdvanceForm';
import { HrContext, HrContextFactory } from '../../services/hr/HrContext';

export type AdvanceSource = 'request' | 'legacy';

export interface AdvanceListQuery {
  page?: number;
  perPage?: number;
  stage?: AdvanceStage;
  search?: string;
  from?: string;
  to?: string;
  mine?: boolean;
}

const PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/**
 * السلف — قراءةٌ لنظامَي السلف معاً، وكتابةٌ واحدةٌ فقط: تقديمُ الطلب وسحبُه.
 *
 * **نظامان لا واحد**: `salary_advance_requests` طلبٌ بدورة حياةٍ كاملة، و
 * `salary_advances` سلفٌ قديمةٌ صُدرت مباشرةً بأقساطها. القائمةُ الإدارية
 * (`advances`) تُظهرهما معاً كما تفعل شاشةُ «إدارة السلف»، وقائمةُ «طلباتي»
 * (`advanceRequests`) تقرأ الطلباتِ وحدها.
 *
 * ولا قيدَ محاسبيّاً هنا: الاعتمادُ والصرفُ والتحصيلُ والإلغاءُ الإداريّ تبقى
 * في الويب لأنها تُخرج المالَ وتكتب في الدفتر.
 */
export class AdvanceUseCases {
  constructor(
    private readonly contexts: HrContextFactory,
    private readonly advances: AdvanceRepository,
    private readonly reference: HrReferenceRepository,
    private readonly clientRefs: ClientsReferenceRepository,
    private readonly planLimits: PlanLimitGuard,
    private readonly cache: Cache,
    private readonly uow: UnitOfWork,
  ) {}

  /** الحارس: الاشتراك ← «المرتّبات» ← `hr_advances` ← الصلاحية */
  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.advances], permissions: [permission] });
  }

  private money() {
    return this.cache.wrap('hr:currency', 300, () => this.clientRefs.defaultCurrency()).then((c) => ({ formatter: new CurrencyFormatter(c), code: c?.code ?? 'SAR' }));
  }

  /** نطاقُ الموظفين، ومع `mine=1` معرّفُ الموظف نفسِه داخل ذلك النطاق */
  private async employeeScope(ctx: HrContext, mine: boolean): Promise<number[] | null> {
    const scope = await ctx.accessibleEmployeeIds();
    if (!mine) return scope;

    const own = ctx.employeeId;
    if (!own) return [];
    return scope === null || scope.includes(own) ? [own] : [];
  }

  private requestRow(r: AdvanceRequestRecord, currency: string) {
    const stage = advanceStage(r);
    return {
      id: r.id,
      source: 'request' as const,
      employee: r.employeeId ? { id: r.employeeId, name: r.employeeName ?? `#${r.employeeId}` } : null,
      amount: round2(r.amount),
      advanceType: r.advanceType === 'scheduled' ? ('scheduled' as const) : ('normal' as const),
      installmentsCount: r.installmentsCount,
      installmentAmount: round2(r.installmentAmount),
      startMonth: r.startMonth,
      paidInstallments: r.paidInstallments,
      remainingInstallments: r.remainingInstallments,
      status: r.status,
      stage,
      stageLabel: ADVANCE_STAGE_LABELS[stage],
      requestedDate: r.requestedDate,
      approvedDate: r.approvedDate,
      disbursedAt: r.disbursedAt,
      isSettled: r.isSettled,
      settledAmount: r.settledAmount === null ? null : round2(r.settledAmount),
      remainingAmount: advanceRemainingAmount(r),
      reason: r.reason,
      rejectionReason: r.rejectionReason,
      treasury: r.treasuryId ? { id: r.treasuryId, name: r.treasuryName ?? '' } : null,
      currency,
    };
  }

  private legacyRow(a: LegacyAdvanceRecord) {
    const stage = legacyAdvanceStage(a);
    return {
      id: a.id,
      source: 'legacy' as const,
      employee: a.employeeId ? { id: a.employeeId, name: a.employeeName ?? `#${a.employeeId}` } : null,
      amount: round2(a.amount),
      advanceType: legacyAdvanceType(a.totalInstallments),
      installmentsCount: a.totalInstallments,
      installmentAmount: round2(a.installmentAmount),
      startMonth: a.installmentStartDate ? a.installmentStartDate.slice(0, 7) : null,
      paidInstallments: a.paidCount,
      remainingInstallments: Math.max(0, a.totalInstallments - a.paidCount),
      status: a.status ?? 'active',
      stage,
      stageLabel: ADVANCE_STAGE_LABELS[stage],
      requestedDate: a.submissionDate,
      approvedDate: null,
      // السلفةُ القديمة أُصدرت مصروفةً: لا تاريخَ صرفٍ لها غيرُ تاريخ تقديمها
      disbursedAt: a.submissionDate,
      isSettled: stage === 'settled',
      settledAmount: round2(a.paidAmount),
      remainingAmount: legacyAdvanceRemaining(a, stage),
      reason: a.note,
      rejectionReason: null,
      treasury: a.treasuryId ? { id: a.treasuryId, name: a.treasuryName ?? '' } : null,
      currency: LEGACY_ADVANCE_CURRENCIES[Number(a.currency ?? 0)] ?? 'SAR',
    };
  }

  async list(userId: number, meta: RequestMeta, q: AdvanceListQuery) {
    const mine = q.mine === true;
    const ctx = await this.load(userId, meta, mine ? HR_PERMISSIONS.advanceCreate : HR_PERMISSIONS.advancesIndex);

    const page = Math.max(1, q.page ?? 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, q.perPage ?? PER_PAGE));
    const filters: AdvanceFilters = { employeeIds: await this.employeeScope(ctx, mine), search: q.search, from: q.from, to: q.to };
    const { code } = await this.money();

    // السلفُ القديمة لا تعرف مراحلَ الطلب — تُستبعد عند التصفية بمرحلةٍ لا تملكها
    const wantsLegacy = !mine && (!q.stage || LEGACY_ADVANCE_STAGES.includes(q.stage));

    const [requests, legacy] = await Promise.all([this.advances.requests(filters), wantsLegacy ? this.advances.legacy(filters) : Promise.resolve([])]);

    const merged = [
      ...requests.map((r) => ({ row: this.requestRow(r, code), sortDate: r.sortDate })),
      ...legacy.map((a) => ({ row: this.legacyRow(a), sortDate: a.sortDate })),
    ]
      .filter((e) => !q.stage || e.row.stage === q.stage)
      .sort((a, b) => (b.sortDate ?? '').localeCompare(a.sortDate ?? '') || b.row.id - a.row.id);

    const stats = { pending: 0, approved: 0, disbursed: 0, settled: 0 };
    let amount = 0;
    let remaining = 0;
    for (const e of merged) {
      amount += e.row.amount;
      remaining += e.row.remainingAmount;
      if (e.row.stage in stats) stats[e.row.stage as keyof typeof stats] += 1;
    }

    return {
      items: merged.slice((page - 1) * perPage, page * perPage).map((e) => e.row),
      total: merged.length,
      page,
      perPage,
      totals: { amount: round2(amount), remaining: round2(remaining) },
      stats,
    };
  }

  async show(userId: number, meta: RequestMeta, id: number, source: AdvanceSource) {
    // حارسُ أحد القسمين + صلاحيةُ العرض — كما يحرس الويب `@show` بـ`loans.show` فوق حارس المجموعة
    const ctx = await this.contexts.load(userId, meta, {
      planFeatures: [HR_PLAN.advances],
      permissions: [[HR_PERMISSIONS.advancesIndex, HR_PERMISSIONS.advanceCreate], HR_PERMISSIONS.advanceShow],
    });

    const { code } = await this.money();

    if (source === 'legacy') {
      const legacy = await this.advances.findLegacy(id);
      if (!legacy) throw AppError.notFound('ADVANCE_NOT_FOUND', 'السلفة غير موجودة.');
      await ctx.assertEmployeeScope(legacy.employeeId);

      return {
        ...this.legacyRow(legacy),
        installments: await this.advances.legacyInstallments(id),
        approver: null,
        approvedBy: null,
        disbursedBy: null,
        adminNotes: null,
        cancellationReason: legacy.cancellationReason,
        journals: await this.advances.journals(id, { ids: [legacy.cancellationJournalId], prefixes: LEGACY_ADVANCE_JOURNAL_PREFIXES }),
        can: { withdraw: false },
      };
    }

    const request = await this.advances.findRequest(id);
    if (!request) throw AppError.notFound('ADVANCE_NOT_FOUND', 'السلفة غير موجودة.');
    await ctx.assertEmployeeScope(request.employeeId);

    const row = this.requestRow(request, code);
    const [installments, journals] = await Promise.all([
      this.advances.requestInstallments(id),
      this.advances.journals(id, { ids: [request.disbursementJournalId, request.cancellationJournalId], prefixes: ADVANCE_JOURNAL_PREFIXES }),
    ]);

    return {
      ...row,
      installments,
      approver: request.approverUserId ? { id: request.approverUserId, name: request.approverName ?? '' } : null,
      approvedBy: request.approvedByName,
      disbursedBy: request.disbursedByName,
      adminNotes: request.adminNotes,
      cancellationReason: request.cancellationReason,
      journals,
      can: { withdraw: this.canWithdraw(ctx, request) },
    };
  }

  /** السحبُ لصاحب الطلب وحده، وقبل البتّ فيه، وبصلاحية «طلب سلفة» */
  private canWithdraw(ctx: HrContext, r: AdvanceRequestRecord): boolean {
    return r.status === 'pending' && r.employeeId !== null && ctx.employeeId === r.employeeId && ctx.can(HR_PERMISSIONS.advanceCreate);
  }

  /** `AdvanceApprovers::for()` — المعتمِدون المتاحون لطلبٍ يقدّمه هذا المستخدم */
  private async approvers(userId: number) {
    const [candidates, settingRaw] = await Promise.all([
      this.reference.usersWithPermission(HR_PERMISSIONS.advanceApprove),
      this.reference.payrollSetting(ADVANCE_APPROVER_DEPARTMENTS_SETTING),
    ]);

    const departmentIds = parseApproverDepartmentIds(settingRaw);
    const employeeIds = departmentIds.length ? await this.reference.employeeIdsInDepartments(departmentIds) : [];

    return filterApprovers(candidates, userId, departmentIds, employeeIds).map((a) => ({ id: a.id, name: a.name }));
  }

  async createData(userId: number, meta: RequestMeta) {
    const ctx = await this.load(userId, meta, HR_PERMISSIONS.advanceCreate);
    const employeeId = ctx.requireEmployeeId();

    const card = await this.reference.employeeCard(employeeId);
    const [approvers, summary, limit] = await Promise.all([
      this.approvers(ctx.user.id),
      this.reference.advanceSummary(card?.advanceAccountId ?? null),
      this.planLimits.describe(ADVANCE_REQUESTS_LIMIT, ctx.now),
    ]);

    return { hasAdvanceAccount: card?.hasAdvanceAccount ?? false, approvers, summary, limit };
  }

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, HR_PERMISSIONS.advanceCreate);

    // ترتيبُ الشروط مقصود: سجلُّ الموظف ← حسابُ السلف ← حدُّ الباقة ← التحقّق من الحقول
    const employeeId = ctx.requireEmployeeId();
    const card = await this.reference.employeeCard(employeeId);
    if (!card?.hasAdvanceAccount) {
      throw new AppError(
        'NO_ADVANCE_ACCOUNT',
        'لا يمكن طلب سلفة: لا يوجد حساب سلف مرتبط بك في شجرة الحسابات. يرجى التواصل مع إدارة الموارد البشرية.',
        422,
      );
    }

    await this.planLimits.assert(ADVANCE_REQUESTS_LIMIT, ctx.now);

    const approvers = await this.approvers(ctx.user.id);
    const input = validateAdvanceRequest(body, { today: ctx.today, approverIds: approvers.map((a) => a.id) });

    const { formatter } = await this.money();
    const employeeName = advanceNotificationName(card);

    const id = await this.uow.run(async (tx) => {
      await this.planLimits.assert(ADVANCE_REQUESTS_LIMIT, ctx.now);

      const newId = await this.advances.insertRequest({ ...input, employeeId }, ctx.nowSql, tx);
      await this.advances.log(newId, `قُدِّم طلب السلفة بمبلغ ${formatter.format(input.amount)}`, ctx.user.id, ctx.nowSql, tx);

      // «#رقم» في آخر الوصف: منه يستخرج بوبُ الإشعار في الويب رقمَ الطلب للاعتماد السريع
      await this.advances.notify(
        {
          userId: ctx.user.id,
          receiverId: input.approverUserId,
          title: 'طلب سلفة جديد',
          description: `طلب سلفة جديد من الموظف ${employeeName} بمبلغ ${formatter.format(input.amount)} - رقم الطلب #${newId}`,
          type: ADVANCE_NOTIFICATION_TYPE,
        },
        ctx.nowSql,
        tx,
      );

      return newId;
    });

    return { data: { id }, message: 'أُرسل طلب السلفة إلى المعتمِد، وستُخطَر بقراره.' };
  }

  async withdraw(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, HR_PERMISSIONS.advanceCreate);

    const request = await this.advances.findRequest(id);
    if (!request) throw AppError.notFound('ADVANCE_NOT_FOUND', 'السلفة غير موجودة.');
    await ctx.assertEmployeeScope(request.employeeId);

    if (ctx.employeeId !== request.employeeId) {
      throw AppError.forbidden('FORBIDDEN', 'السحبُ لصاحب الطلب وحده — وإلغاءُ سلفة غيره فعلٌ إداريٌّ يُنفَّذ من النظام.');
    }

    if (request.status !== 'pending') {
      throw new AppError('ADVANCE_NOT_PENDING', `بُتَّ في هذا الطلب (${ADVANCE_STAGE_LABELS[advanceStage(request)]}) — لا يُسحب بعد قرار المعتمِد.`, 422);
    }

    await this.uow.run(async (tx) => {
      await this.advances.cancelRequest(id, { reason: ADVANCE_WITHDRAW_REASON, userId: ctx.user.id }, ctx.nowSql, tx);
      // إشعارُ الطلب عند المعتمِد لم يعد ينتظر قراراً
      await this.advances.markRequestNotificationsRead(id, ADVANCE_NOTIFICATION_TYPE, tx);
    });

    return { data: { id, stage: 'cancelled' as AdvanceStage }, message: 'سُحب الطلب وأُغلق «ملغى».' };
  }

  /** ملخّصُ سلف موظفٍ بعينه — تستعمله «نظرة عامة» */
  async summaryFor(employeeId: number) {
    const card = await this.reference.employeeCard(employeeId);
    return this.reference.advanceSummary(card?.advanceAccountId ?? null);
  }
}
