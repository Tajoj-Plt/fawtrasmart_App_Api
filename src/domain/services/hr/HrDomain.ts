import { round2 } from '../sales/SalesMath';
import {
  AdvanceStage,
  AdvanceType,
  DEDUCTION_ACTION_LABELS,
  DEDUCTION_STATUS_LABELS,
  DEDUCTION_TYPE_LABELS,
  DeductionStatus,
  DeductionType,
  PAYROLL_STATUS,
  RUN_STAGE_LABELS,
  RunStage,
  SALARY_ITEM_ADDITION,
  SALARY_ITEM_DEDUCTION,
  SLIP_STATUS_LABELS,
  SlipStatus,
} from './HrConstants';

/**
 * حسابات الموارد البشرية المشتقّة — مراحلُ السلفة والخصمية والصرفة، والمبالغُ
 * التي لا عمودَ لها في القاعدة. كلُّها دوالٌّ خالصة، نسخةٌ حرفيّة عمّا تحسبه
 * موديلات الويب، كي يُقاس الحسابُ بالاختبار لا بقاعدة بيانات.
 *
 * **نظامان للسلف لا واحد**: `salary_advance_requests` هو الطلبُ بدورة حياته
 * (طلب ← اعتماد ← صرف ← سداد)، و`salary_advances` سلفٌ قديمةٌ أُصدرت مباشرةً
 * ولا تعرف مراحلَ الطلب — تُقرأ من أقساطها (`installment_payments`) وحدها.
 */

/* ══════════════════ السلف — نظام الطلبات ══════════════════ */

export interface AdvanceAmounts {
  amount: number;
  settledAmount: number | null;
  advanceType: AdvanceType | string | null;
  paidInstallments: number | null;
  installmentAmount: number | null;
  isSettled: boolean;
}

/** `SalaryAdvanceRequest::repaidAmount()` — المسدَّد نقداً أو اقتطاعاً، محدوداً بأصل المبلغ */
export function advanceRepaidAmount(a: AdvanceAmounts): number {
  let settled = Number(a.settledAmount ?? 0);

  // السلفةُ المجدولة تُقرأ من أقساطها متى لم يُكتب لها مبلغُ تسويةٍ صريح
  if (settled <= 0 && a.advanceType === 'scheduled' && Number(a.paidInstallments ?? 0) > 0) {
    settled = Number(a.paidInstallments ?? 0) * Number(a.installmentAmount ?? 0);
  }

  return round2(Math.min(settled, Number(a.amount)));
}

/** `SalaryAdvanceRequest::remainingAmount()` */
export function advanceRemainingAmount(a: AdvanceAmounts): number {
  if (a.isSettled) return 0;
  return round2(Math.max(0, Number(a.amount) - advanceRepaidAmount(a)));
}

export interface AdvanceStageInput extends AdvanceAmounts {
  status: string | null;
  disbursedAt: string | null;
}

/**
 * `SalaryAdvanceRequest::stage()` — `status` يحمل قرارَ المعتمِد وحده،
 * والمرحلةُ الفعليّة تُقرأ منه ومن `disbursed_at` و`is_settled` والمسدَّد معاً.
 */
export function advanceStage(a: AdvanceStageInput): AdvanceStage {
  if (a.status === 'pending') return 'pending';
  if (a.status === 'rejected') return 'rejected';
  if (a.status === 'cancelled') return 'cancelled';
  if (!a.disbursedAt) return 'approved';
  if (a.isSettled) return 'settled';
  return advanceRepaidAmount(a) > 0.001 ? 'repaying' : 'disbursed';
}

/* ══════════════════ السلف — النظام القديم ══════════════════ */

export interface LegacyAdvanceInput {
  status: string | null;
  totalInstallments: number | null;
  /** عددُ أقساط `installment_payments` التي حالتُها `paid` */
  paidCount: number;
  paidAmount: number;
  amount: number;
}

/** `AdvanceApprovalController::legacyRow()` — مرحلةُ السلفة القديمة من أقساطها */
export function legacyAdvanceStage(a: LegacyAdvanceInput): AdvanceStage {
  const total = Number(a.totalInstallments ?? 0);
  if ((a.status ?? 'active') === 'cancelled') return 'cancelled';
  if (total > 0 && a.paidCount >= total) return 'settled';
  if (a.paidCount > 0) return 'repaying';
  return 'disbursed';
}

export function legacyAdvanceRemaining(a: LegacyAdvanceInput, stage = legacyAdvanceStage(a)): number {
  return stage === 'cancelled' ? 0 : Math.max(0, round2(Number(a.amount) - Number(a.paidAmount)));
}

/** السلفةُ القديمةُ «مجدولة» متى زادت أقساطُها على واحد */
export function legacyAdvanceType(totalInstallments: number | null): AdvanceType {
  return Number(totalInstallments ?? 0) > 1 ? 'scheduled' : 'normal';
}

/* ══════════════════ الخصميات ══════════════════ */

/** `Deduction::getRemainingAmountAttribute()` */
export function deductionRemaining(amount: number, settledAmount: number): number {
  return Math.max(0, round2(Number(amount) - Number(settledAmount)));
}

/** `Deduction::getProgressPercentageAttribute()` */
export function deductionProgress(amount: number, settledAmount: number): number {
  if (!amount || Number(amount) <= 0) return 0;
  return Math.min(100, round2((Number(settledAmount) / Number(amount)) * 100));
}

export function deductionTypeLabel(type: string | null): string {
  return DEDUCTION_TYPE_LABELS[(type ?? '') as DeductionType] ?? String(type ?? '');
}

export function deductionStatusLabel(status: string | null): string {
  return DEDUCTION_STATUS_LABELS[(status ?? '') as DeductionStatus] ?? String(status ?? '');
}

export function deductionActionLabel(action: string | null): string {
  return DEDUCTION_ACTION_LABELS[action ?? ''] ?? String(action ?? '');
}

/* ══════════════════ اتفاق الراتب ══════════════════ */

export interface SlipItem {
  /** `salary_items.type`: 1 استحقاق و2 استقطاع */
  type: number;
  amount: number;
}

export interface SlipTotals {
  totalAdditions: number;
  totalDeductions: number;
  netSalary: number;
}

/** `SalarySlipController::computeSlip()` — الإجمالي ثمّ الصافي، بتقريبٍ بينهما كما في الويب */
export function slipTotals(basicAmount: number, items: SlipItem[]): SlipTotals {
  let additions = 0;
  let deductions = 0;

  for (const item of items) {
    const amount = Number(item.amount ?? 0);
    if (Number(item.type) === SALARY_ITEM_ADDITION) additions += amount;
    else if (Number(item.type) === SALARY_ITEM_DEDUCTION) deductions += amount;
  }

  const basic = round2(Number(basicAmount ?? 0));
  const gross = round2(basic + round2(additions));

  return { totalAdditions: round2(additions), totalDeductions: round2(deductions), netSalary: round2(gross - round2(deductions)) };
}

export function slipStatusLabel(status: string | null): string {
  return SLIP_STATUS_LABELS[(status ?? '') as SlipStatus] ?? String(status ?? '');
}

/* ══════════════════ صرفةُ الراتب الشهرية ══════════════════ */

export interface RunStageInput {
  status: string | null;
  heldAt: string | null;
  scheduledDate: string | null;
  /** هل للصرفة قسيمةٌ قائمة؟ */
  hasSlip: boolean;
  /** `salary_slips.payroll_id` */
  slipPayrollId: number | null;
  /** `payrolls.status` — `null` يُقرأ «نشطاً» كما في `Payroll::isActive()` */
  payrollStatus: string | null;
  /** هل صفُّ المسير موجود؟ (المحذوف يمنع الصرف) */
  payrollExists: boolean;
}

/** `PayrollRun::disbursementApprovalBlockReason()` — هل ينتظر اعتمادَ المسير؟ */
export function runAwaitsApproval(r: RunStageInput, requiresApproval: boolean): boolean {
  if (!requiresApproval) return false;
  if (!r.hasSlip) return true;
  if (!r.slipPayrollId) return true;
  if (!r.payrollExists) return true;
  const status = r.payrollStatus ?? PAYROLL_STATUS.active;
  return status === PAYROLL_STATUS.draft || status === PAYROLL_STATUS.inactive;
}

/** `PayrollRun::stage()` — `today` بصيغة `YYYY-MM-DD` بتوقيت النظام */
export function runStage(r: RunStageInput, today: string, requiresApproval: boolean): RunStage {
  if (r.status === 'disbursed') return 'paid';
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'pending' && r.heldAt) return 'held';
  if (runAwaitsApproval(r, requiresApproval)) return 'awaiting_approval';
  return r.scheduledDate !== null && today >= r.scheduledDate.slice(0, 10) ? 'ready' : 'scheduled';
}

export function runStageLabel(stage: RunStage): string {
  return RUN_STAGE_LABELS[stage] ?? stage;
}

/** `PayrollRun::getPeriodLabelAttribute()` */
export function periodLabel(from: string | null, to: string | null): string {
  return `${(from ?? '').slice(0, 10)} → ${(to ?? '').slice(0, 10)}`;
}

/* ══════════════════ معتمِدو السلف ══════════════════ */

/** `AdvanceApprovers::departmentIds()` — قائمةُ الأقسام المضبوطة (نصّ JSON أو مصفوفة) */
export function parseApproverDepartmentIds(raw: unknown): number[] {
  if (raw === null || raw === undefined || raw === '') return [];

  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  const list = Array.isArray(value) ? value : [value];
  const ids = list.map((v) => Math.trunc(Number(v))).filter((n) => Number.isFinite(n) && n !== 0);
  return Array.from(new Set(ids));
}

export interface ApproverCandidate {
  id: number;
  name: string;
  employeeId: number | null;
}

/**
 * `AdvanceApprovers::for()` — المرشّحون يملكون `loans.approve` بأدوارهم، ثمّ:
 * لا يعتمد أحدٌ طلبَ نفسِه، وإن ضُبطت أقسامُ الاعتماد فلا يبقى إلّا موظفوها.
 */
export function filterApprovers(
  candidates: ApproverCandidate[],
  requesterUserId: number,
  departmentIds: number[],
  employeeIdsInDepartments: number[],
): ApproverCandidate[] {
  const allowed = new Set(employeeIdsInDepartments.map(Number));

  return candidates.filter((c) => {
    if (c.id === requesterUserId) return false;
    if (departmentIds.length === 0) return true;
    return c.employeeId !== null && allowed.has(Number(c.employeeId));
  });
}

/** `Employee::getFullNameAttribute()` */
export function employeeFullName(e: { firstName?: string | null; middleName?: string | null; nickname?: string | null }): string {
  return `${e.firstName ?? ''} ${e.middleName ?? ''} ${e.nickname ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** الاسمُ كما يكتبه إشعارُ طلب السلفة — الأوّل والأوسط وحدهما */
export function advanceNotificationName(e: { firstName?: string | null; middleName?: string | null }): string {
  return `${e.firstName ?? ''} ${e.middleName ?? ''}`.trim();
}
