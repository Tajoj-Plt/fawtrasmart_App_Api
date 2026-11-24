import { AppError } from '../../../domain/errors/AppError';
import { HrReferenceRepository, PayrollRepository, RunItem, RunRecord, SlipComponent, SlipRecord } from '../../../domain/repositories/hr';
import {
  HR_PERMISSIONS,
  HR_PLAN,
  RUN_ITEM_TYPES,
  RunItemType,
  RunStage,
  SALARY_ITEM_ADDITION,
  SALARY_ITEM_DEDUCTION,
  SlipStatus,
} from '../../../domain/services/hr/HrConstants';
import { periodLabel, runStage, runStageLabel, slipStatusLabel, slipTotals } from '../../../domain/services/hr/HrDomain';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { Cache } from '../../ports';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { HrContextFactory } from '../../services/hr/HrContext';

export interface SlipListQuery {
  page?: number;
  perPage?: number;
  status?: SlipStatus;
  search?: string;
}

export interface RunListQuery {
  page?: number;
  perPage?: number;
  stage?: RunStage;
  search?: string;
  from?: string;
  to?: string;
}

const PER_PAGE = 20;
const MAX_PER_PAGE = 100;

interface RunItemPayload {
  id: number;
  name: string | null;
  amount: number;
  description: string | null;
  sourceTable: string | null;
  sourceId: number | null;
}

const itemPayload = (i: RunItem): RunItemPayload => ({
  id: i.id,
  name: i.name,
  amount: round2(i.amount),
  description: i.description,
  sourceTable: i.sourceTable,
  sourceId: i.sourceId,
});

/**
 * اتفاقُ الراتب وصرفاتُه الشهرية — عرضٌ فقط.
 *
 * **تنبيهٌ في التسمية**: `salary_slips` اتفاقُ راتبٍ مستمرّ («قسيمة الراتب» في
 * الويب) لا راتبُ شهرٍ بعينه؛ وراتبُ الشهر صفٌّ في `payroll_runs` مولَّدٌ منها.
 * فمنفذُ `salary-slips` يقرأ الأوّل، ومنفذُ `payslips` يقرأ الثاني.
 */
export class PayslipUseCases {
  constructor(
    private readonly contexts: HrContextFactory,
    private readonly payroll: PayrollRepository,
    private readonly reference: HrReferenceRepository,
    private readonly cache: Cache,
  ) {}

  private loadSlips(userId: number, meta: RequestMeta) {
    return this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.payslips], permissions: [HR_PERMISSIONS.salarySlipsIndex] });
  }

  private loadRuns(userId: number, meta: RequestMeta) {
    return this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.payroll], permissions: [HR_PERMISSIONS.payslipsIndex] });
  }

  /** `PayrollRun::requiresDisbursementApproval()` — الافتراضُ «نعم» */
  private requiresApproval(): Promise<boolean> {
    return this.cache.wrap('hr:require-disbursement-approval', 60, async () => {
      const value = await this.reference.payrollSetting('require_disbursement_approval');
      return value === null || value === undefined ? true : value === true || value === 1 || value === '1';
    });
  }

  /* ══════════════════ اتفاق الراتب ══════════════════ */

  private slipRow(s: SlipRecord, components: SlipComponent[]) {
    const totals = slipTotals(s.basicAmount, components);
    return {
      id: s.id,
      code: s.code,
      employee: s.employeeId ? { id: s.employeeId, name: s.employeeName ?? `#${s.employeeId}` } : null,
      basicAmount: round2(s.basicAmount),
      currency: s.currency,
      frequency: s.frequency,
      scheduledPaymentDay: s.scheduledPaymentDay,
      startDate: s.startDate,
      endDate: s.endDate,
      status: s.status,
      statusLabel: slipStatusLabel(s.status),
      ...totals,
    };
  }

  async slips(userId: number, meta: RequestMeta, q: SlipListQuery) {
    const ctx = await this.loadSlips(userId, meta);
    const page = Math.max(1, q.page ?? 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, q.perPage ?? PER_PAGE));

    const { rows, total } = await this.payroll.slipPage({ employeeIds: await ctx.accessibleEmployeeIds(), status: q.status, search: q.search }, page, perPage);
    const components = await this.payroll.slipComponents(rows.map((s) => s.id));

    return { items: rows.map((s) => this.slipRow(s, components.get(s.id) ?? [])), total, page, perPage };
  }

  async slip(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.payslips], permissions: [HR_PERMISSIONS.salarySlipsIndex, HR_PERMISSIONS.salarySlipShow] });

    const slip = await this.payroll.findSlip(id);
    if (!slip) throw AppError.notFound('SLIP_NOT_FOUND', 'قسيمة الراتب غير موجودة.');
    await ctx.assertEmployeeScope(slip.employeeId);

    const components = (await this.payroll.slipComponents([slip.id])).get(slip.id) ?? [];
    const component = (c: SlipComponent) => ({ id: c.id, name: c.name, amount: round2(c.amount), isInsurable: c.isInsurable });

    return {
      ...this.slipRow(slip, components),
      notes: slip.notes,
      approvedAt: slip.approvedAt,
      stoppedAt: slip.stoppedAt,
      stopReason: slip.stopReason,
      additions: components.filter((c) => c.type === SALARY_ITEM_ADDITION).map(component),
      deductions: components.filter((c) => c.type === SALARY_ITEM_DEDUCTION).map(component),
    };
  }

  /* ══════════════════ الصرفة الشهرية ══════════════════ */

  private runRow(r: RunRecord, today: string, requiresApproval: boolean) {
    const stage = runStage(r, today, requiresApproval);
    return {
      id: r.id,
      employee: r.employeeId ? { id: r.employeeId, name: r.employeeName ?? `#${r.employeeId}` } : null,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      periodLabel: periodLabel(r.periodFrom, r.periodTo),
      scheduledDate: r.scheduledDate,
      basicAmount: round2(r.basicAmount),
      totalAdditions: round2(r.totalAdditions),
      totalDeductions: round2(r.totalDeductions),
      totalAdvancesDeducted: round2(r.totalAdvancesDeducted),
      netSalary: round2(r.netSalary),
      currency: r.currency,
      status: r.status,
      stage,
      stageLabel: runStageLabel(stage),
      disbursedAt: r.disbursedAt,
    };
  }

  async runs(userId: number, meta: RequestMeta, q: RunListQuery) {
    const ctx = await this.loadRuns(userId, meta);
    const page = Math.max(1, q.page ?? 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, q.perPage ?? PER_PAGE));
    const requiresApproval = await this.requiresApproval();

    const { rows, total } = await this.payroll.runPage(
      { employeeIds: await ctx.accessibleEmployeeIds(), stage: q.stage, search: q.search, from: q.from, to: q.to },
      page,
      perPage,
      ctx.today,
      requiresApproval,
    );

    return { items: rows.map((r) => this.runRow(r, ctx.today, requiresApproval)), total, page, perPage };
  }

  async run(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.contexts.load(userId, meta, { planFeatures: [HR_PLAN.payroll], permissions: [HR_PERMISSIONS.payslipsIndex, HR_PERMISSIONS.payslipShow] });

    const run = await this.payroll.findRun(id);
    if (!run) throw AppError.notFound('PAYSLIP_NOT_FOUND', 'سجل الصرف غير موجود.');
    await ctx.assertEmployeeScope(run.employeeId);

    const [requiresApproval, items] = await Promise.all([this.requiresApproval(), this.payroll.runItems(id)]);

    // أنواعُ البنود الخمسة حاضرةٌ دائماً ولو فارغة، فلا تفحص الواجهةُ وجودَ المفتاح
    const grouped: Record<RunItemType, RunItemPayload[]> = { addition: [], deduction: [], advance: [], employer: [], retro: [] };
    for (const item of items) {
      const key = (item.itemType ?? '') as RunItemType;
      if (RUN_ITEM_TYPES.includes(key)) grouped[key].push(itemPayload(item));
    }

    return {
      ...this.runRow(run, ctx.today, requiresApproval),
      notes: run.notes,
      treasury: run.treasuryId ? { id: run.treasuryId, name: run.treasuryName ?? '' } : null,
      salarySlipId: run.salarySlipId,
      items: grouped,
    };
  }

  /** آخرُ صرفةٍ للموظف — بطاقةُ «نظرة عامة» */
  async latestForEmployee(employeeId: number, today: string) {
    const run = await this.payroll.latestRunForEmployee(employeeId);
    if (!run) return null;
    const requiresApproval = await this.requiresApproval();
    const stage = runStage(run, today, requiresApproval);

    return { id: run.id, periodLabel: periodLabel(run.periodFrom, run.periodTo), netSalary: round2(run.netSalary), stage, stageLabel: runStageLabel(stage) };
  }
}
