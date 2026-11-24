import { describe, expect, it } from 'vitest';
import { validateAdvanceRequest } from '../src/application/services/hr/AdvanceForm';
import { AppError } from '../src/domain/errors/AppError';
import { ADVANCE_STAGE_LABELS } from '../src/domain/services/hr/HrConstants';
import {
  advanceNotificationName,
  advanceRemainingAmount,
  advanceRepaidAmount,
  advanceStage,
  deductionActionLabel,
  deductionProgress,
  deductionRemaining,
  deductionStatusLabel,
  deductionTypeLabel,
  employeeFullName,
  filterApprovers,
  legacyAdvanceRemaining,
  legacyAdvanceStage,
  legacyAdvanceType,
  parseApproverDepartmentIds,
  periodLabel,
  runAwaitsApproval,
  runStage,
  slipTotals,
} from '../src/domain/services/hr/HrDomain';

const advance = (over: Partial<Parameters<typeof advanceStage>[0]> = {}) => ({
  status: 'approved',
  disbursedAt: '2026-01-10 09:00:00',
  isSettled: false,
  amount: 1000,
  settledAmount: null,
  advanceType: 'normal',
  paidInstallments: 0,
  installmentAmount: 0,
  ...over,
});

describe('advance repaid / remaining', () => {
  it('reads the explicit settled amount, clamped to the advance itself', () => {
    expect(advanceRepaidAmount(advance({ settledAmount: 400 }))).toBe(400);
    expect(advanceRepaidAmount(advance({ settledAmount: 1500 }))).toBe(1000);
  });

  it('falls back to paid installments only for a scheduled advance', () => {
    expect(advanceRepaidAmount(advance({ advanceType: 'scheduled', paidInstallments: 3, installmentAmount: 250 }))).toBe(750);
    // عاديّةٌ بأقساطٍ مكتوبة لا تُقرأ منها — `isScheduled()` هي الشرط
    expect(advanceRepaidAmount(advance({ advanceType: 'normal', paidInstallments: 3, installmentAmount: 250 }))).toBe(0);
  });

  it('a settled amount wins over the installments, and the installments are clamped too', () => {
    expect(advanceRepaidAmount(advance({ advanceType: 'scheduled', settledAmount: 100, paidInstallments: 3, installmentAmount: 250 }))).toBe(100);
    expect(advanceRepaidAmount(advance({ advanceType: 'scheduled', paidInstallments: 5, installmentAmount: 250 }))).toBe(1000);
  });

  it('remaining is zero once the row is flagged settled, whatever was repaid', () => {
    expect(advanceRemainingAmount(advance({ settledAmount: 400 }))).toBe(600);
    expect(advanceRemainingAmount(advance({ settledAmount: 400, isSettled: true }))).toBe(0);
    expect(advanceRemainingAmount(advance({ settledAmount: 1200 }))).toBe(0);
  });

  it('rounds to two places instead of trailing float noise', () => {
    expect(advanceRepaidAmount(advance({ advanceType: 'scheduled', paidInstallments: 3, installmentAmount: 33.33 }))).toBe(99.99);
    expect(advanceRemainingAmount(advance({ amount: 100.1, settledAmount: 0.2 }))).toBe(99.9);
  });
});

describe('advance stage derivation', () => {
  it('takes the approver decision straight from status', () => {
    expect(advanceStage(advance({ status: 'pending', disbursedAt: null }))).toBe('pending');
    expect(advanceStage(advance({ status: 'rejected' }))).toBe('rejected');
    expect(advanceStage(advance({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('separates "approved" from "disbursed" by the money actually leaving', () => {
    expect(advanceStage(advance({ disbursedAt: null }))).toBe('approved');
    expect(advanceStage(advance())).toBe('disbursed');
  });

  it('moves to repaying on the first riyal repaid and to settled on the flag', () => {
    expect(advanceStage(advance({ settledAmount: 1 }))).toBe('repaying');
    expect(advanceStage(advance({ advanceType: 'scheduled', paidInstallments: 1, installmentAmount: 250 }))).toBe('repaying');
    expect(advanceStage(advance({ settledAmount: 1000, isSettled: true }))).toBe('settled');
    // المسدَّدةُ تسبق «قيد السداد» في الفحص
    expect(advanceStage(advance({ settledAmount: 10, isSettled: true }))).toBe('settled');
  });

  it('ignores repayment noise under a tenth of a halala', () => {
    expect(advanceStage(advance({ settledAmount: 0.0005 }))).toBe('disbursed');
  });

  it('every stage has the web label', () => {
    expect(ADVANCE_STAGE_LABELS[advanceStage(advance({ status: 'pending', disbursedAt: null }))]).toBe('بانتظار الاعتماد');
    expect(ADVANCE_STAGE_LABELS.settled).toBe('مسدَّدة بالكامل');
  });
});

describe('legacy advances', () => {
  const legacy = (over: Partial<Parameters<typeof legacyAdvanceStage>[0]> = {}) => ({
    status: 'active',
    totalInstallments: 4,
    paidCount: 0,
    paidAmount: 0,
    amount: 1000,
    ...over,
  });

  it('a cancelled legacy advance is cancelled whatever its installments say', () => {
    expect(legacyAdvanceStage(legacy({ status: 'cancelled', paidCount: 4 }))).toBe('cancelled');
    expect(legacyAdvanceRemaining(legacy({ status: 'cancelled', paidAmount: 100 }))).toBe(0);
  });

  it('derives the stage from the paid installments alone', () => {
    expect(legacyAdvanceStage(legacy())).toBe('disbursed');
    expect(legacyAdvanceStage(legacy({ paidCount: 1 }))).toBe('repaying');
    expect(legacyAdvanceStage(legacy({ paidCount: 4 }))).toBe('settled');
    // أقساطٌ أكثرُ من المقرّر تبقى «مسدَّدة»
    expect(legacyAdvanceStage(legacy({ paidCount: 5 }))).toBe('settled');
  });

  it('a legacy advance with no installments at all is never "settled" by that fact', () => {
    expect(legacyAdvanceStage(legacy({ totalInstallments: 0, paidCount: 0 }))).toBe('disbursed');
    expect(legacyAdvanceStage(legacy({ totalInstallments: null, paidCount: 0 }))).toBe('disbursed');
  });

  it('remaining never goes negative and is rounded', () => {
    expect(legacyAdvanceRemaining(legacy({ paidAmount: 0.015 }))).toBe(999.99);
    expect(legacyAdvanceRemaining(legacy({ paidAmount: 2000 }))).toBe(0);
  });

  it('more than one installment makes it "scheduled"', () => {
    expect(legacyAdvanceType(1)).toBe('normal');
    expect(legacyAdvanceType(0)).toBe('normal');
    expect(legacyAdvanceType(null)).toBe('normal');
    expect(legacyAdvanceType(2)).toBe('scheduled');
  });
});

describe('deduction derived amounts and labels', () => {
  it('remaining is the unsettled part, never negative', () => {
    expect(deductionRemaining(500, 200)).toBe(300);
    expect(deductionRemaining(500, 700)).toBe(0);
    expect(deductionRemaining(0.3, 0.1)).toBe(0.2);
  });

  it('progress is a capped, two-place percentage', () => {
    expect(deductionProgress(500, 125)).toBe(25);
    expect(deductionProgress(300, 100)).toBe(33.33);
    expect(deductionProgress(500, 900)).toBe(100);
    expect(deductionProgress(0, 50)).toBe(0);
  });

  it('labels come from the web wording, and the unknown value is echoed', () => {
    expect(deductionTypeLabel('half_day')).toBe('نصف يوم');
    expect(deductionTypeLabel('custody_damage')).toBe('تلف عهدة');
    expect(deductionStatusLabel('partially_settled')).toBe('مسوّاة جزئياً');
    expect(deductionActionLabel('approved')).toBe('اعتماد');
    expect(deductionTypeLabel('something_else')).toBe('something_else');
    expect(deductionStatusLabel(null)).toBe('');
  });
});

describe('salary agreement totals', () => {
  it('type 1 adds and type 2 subtracts', () => {
    expect(slipTotals(5000, [{ type: 1, amount: 500 }, { type: 2, amount: 200 }, { type: 1, amount: 100 }])).toEqual({
      totalAdditions: 600,
      totalDeductions: 200,
      netSalary: 5400,
    });
  });

  it('a row with neither direction is ignored', () => {
    expect(slipTotals(1000, [{ type: 3, amount: 999 }])).toEqual({ totalAdditions: 0, totalDeductions: 0, netSalary: 1000 });
  });

  it('a slip with no basic amount is just its components', () => {
    expect(slipTotals(0, [{ type: 1, amount: 1200 }, { type: 2, amount: 100 }]).netSalary).toBe(1100);
  });

  it('rounds like the web: additions then net', () => {
    expect(slipTotals(1000.555, [{ type: 1, amount: 0.004 }, { type: 2, amount: 0.001 }]).netSalary).toBe(1000.56);
    expect(slipTotals(100, [{ type: 1, amount: 0.1 }, { type: 1, amount: 0.2 }]).totalAdditions).toBe(0.3);
  });
});

describe('payroll run stage derivation', () => {
  const run = (over: Partial<Parameters<typeof runStage>[0]> = {}) => ({
    status: 'pending',
    heldAt: null,
    scheduledDate: '2026-02-01',
    hasSlip: true,
    slipPayrollId: 7,
    payrollExists: true,
    payrollStatus: 'active',
    ...over,
  });

  it('paid and cancelled beat every other condition', () => {
    expect(runStage(run({ status: 'disbursed', heldAt: '2026-01-05 00:00:00' }), '2026-01-01', true)).toBe('paid');
    expect(runStage(run({ status: 'cancelled' }), '2026-01-01', true)).toBe('cancelled');
  });

  it('a held pending run is held', () => {
    expect(runStage(run({ heldAt: '2026-01-05 00:00:00' }), '2026-03-01', true)).toBe('held');
  });

  it('waits for the payroll to be approved when the setting demands it', () => {
    expect(runStage(run({ payrollStatus: 'draft' }), '2026-03-01', true)).toBe('awaiting_approval');
    expect(runStage(run({ payrollStatus: 'inactive' }), '2026-03-01', true)).toBe('awaiting_approval');
    expect(runStage(run({ slipPayrollId: null }), '2026-03-01', true)).toBe('awaiting_approval');
    expect(runStage(run({ hasSlip: false }), '2026-03-01', true)).toBe('awaiting_approval');
    expect(runStage(run({ payrollExists: false }), '2026-03-01', true)).toBe('awaiting_approval');
  });

  it('an empty payroll status reads as active, as Payroll::isActive() does', () => {
    expect(runStage(run({ payrollStatus: null }), '2026-03-01', true)).toBe('ready');
  });

  it('turning the approval requirement off removes that stage entirely', () => {
    expect(runAwaitsApproval(run({ payrollStatus: 'draft' }), false)).toBe(false);
    expect(runStage(run({ payrollStatus: 'draft' }), '2026-03-01', false)).toBe('ready');
    expect(runStage(run({ slipPayrollId: null }), '2026-01-01', false)).toBe('scheduled');
  });

  it('the scheduled day decides between scheduled and ready', () => {
    expect(runStage(run(), '2026-01-31', true)).toBe('scheduled');
    expect(runStage(run(), '2026-02-01', true)).toBe('ready');
    expect(runStage(run(), '2026-02-02', true)).toBe('ready');
    // بلا تاريخِ صرفٍ لا تكون مستحقّة
    expect(runStage(run({ scheduledDate: null }), '2026-02-02', true)).toBe('scheduled');
  });

  it('prints the period as the web prints it', () => {
    expect(periodLabel('2026-02-01', '2026-02-28')).toBe('2026-02-01 → 2026-02-28');
    expect(periodLabel('2026-02-01 00:00:00', null)).toBe('2026-02-01 → ');
  });
});

describe('advance approvers', () => {
  const candidates = [
    { id: 1, name: 'المدير', employeeId: 11 },
    { id: 2, name: 'مدير الموارد', employeeId: 22 },
    { id: 3, name: 'مستخدم بلا موظف', employeeId: null },
  ];

  it('reads the configured departments out of the payroll setting', () => {
    expect(parseApproverDepartmentIds(null)).toEqual([]);
    expect(parseApproverDepartmentIds('')).toEqual([]);
    expect(parseApproverDepartmentIds('[]')).toEqual([]);
    expect(parseApproverDepartmentIds('[3,4]')).toEqual([3, 4]);
    expect(parseApproverDepartmentIds('["3","0",4,4]')).toEqual([3, 4]);
    expect(parseApproverDepartmentIds([5, '6'])).toEqual([5, 6]);
    expect(parseApproverDepartmentIds('not json')).toEqual([]);
  });

  it('nobody approves their own request', () => {
    expect(filterApprovers(candidates, 2, [], []).map((c) => c.id)).toEqual([1, 3]);
  });

  it('with departments configured, only their employees stay — including dropping users with no employee row', () => {
    expect(filterApprovers(candidates, 99, [3], [22]).map((c) => c.id)).toEqual([2]);
    expect(filterApprovers(candidates, 99, [3], []).map((c) => c.id)).toEqual([]);
    expect(filterApprovers(candidates, 99, [3], [11, 22]).map((c) => c.id)).toEqual([1, 2]);
  });

  it('with no departments configured the permission alone is enough', () => {
    expect(filterApprovers(candidates, 99, [], []).map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

describe('employee names', () => {
  it('the full name joins the three columns, the notification name only two', () => {
    expect(employeeFullName({ firstName: 'سالم', middleName: 'أحمد', nickname: 'أبو سالم' })).toBe('سالم أحمد أبو سالم');
    expect(employeeFullName({ firstName: 'سالم', middleName: null, nickname: null })).toBe('سالم');
    expect(advanceNotificationName({ firstName: 'سالم', middleName: 'أحمد' })).toBe('سالم أحمد');
    expect(advanceNotificationName({ firstName: 'سالم', middleName: null })).toBe('سالم');
  });
});

describe('advance request validation', () => {
  const opts = { today: '2026-03-10', approverIds: [5, 6] };
  const valid = { amount: 1500, reason: 'ظرف طارئ', requestedDate: '2026-03-10', approverUserId: 5 };

  const details = (body: Record<string, unknown>, o = opts) => {
    try {
      validateAdvanceRequest(body, o);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
      expect((e as AppError).status).toBe(422);
      return (e as AppError).details as Record<string, string[]>;
    }
    throw new Error('expected a validation error');
  };

  it('accepts a complete request and normalises its types', () => {
    expect(validateAdvanceRequest(valid, opts)).toEqual(valid);
    expect(validateAdvanceRequest({ ...valid, amount: '1500.50', approverUserId: '6' }, opts)).toEqual({ ...valid, amount: 1500.5, approverUserId: 6 });
  });

  it('reports every missing field at once, with the web wording', () => {
    expect(details({})).toEqual({
      amount: ['يرجى إدخال مبلغ السلفة'],
      reason: ['يرجى إدخال سبب طلب السلفة'],
      requestedDate: ['يرجى تحديد تاريخ الطلب'],
      approverUserId: ['يرجى اختيار الموظف المعتمد'],
    });
  });

  it('treats an empty string as a missing value, as Laravel does', () => {
    expect(details({ ...valid, reason: '   ' }).reason).toEqual(['يرجى إدخال سبب طلب السلفة']);
  });

  it('checks the amount is a number and at least one', () => {
    expect(details({ ...valid, amount: 'abc' }).amount).toEqual(['مبلغ السلفة يجب أن يكون رقماً']);
    expect(details({ ...valid, amount: 0 }).amount).toEqual(['مبلغ السلفة يجب أن يكون أكبر من صفر']);
    expect(details({ ...valid, amount: 0.99 }).amount).toEqual(['مبلغ السلفة يجب أن يكون أكبر من صفر']);
    expect(details({ ...valid, amount: -5 }).amount).toEqual(['مبلغ السلفة يجب أن يكون أكبر من صفر']);
  });

  it('caps the reason at 500 characters', () => {
    expect(validateAdvanceRequest({ ...valid, reason: 'ب'.repeat(500) }, opts).reason).toHaveLength(500);
    expect(details({ ...valid, reason: 'ب'.repeat(501) }).reason).toEqual(['سبب الطلب يجب ألا يتجاوز 500 حرف']);
  });

  it('refuses a date before today, and a date that is not a date', () => {
    expect(details({ ...valid, requestedDate: '2026-03-09' }).requestedDate).toEqual(['تاريخ الطلب يجب أن يكون اليوم أو بعده']);
    expect(details({ ...valid, requestedDate: '2026-02-30' }).requestedDate).toEqual(['التاريخ بصيغة YYYY-MM-DD.']);
    expect(details({ ...valid, requestedDate: '10/03/2026' }).requestedDate).toEqual(['التاريخ بصيغة YYYY-MM-DD.']);
    expect(validateAdvanceRequest({ ...valid, requestedDate: '2026-03-11' }, opts).requestedDate).toBe('2026-03-11');
  });

  it('checks the approver is one of the configured ones — but only after the fields pass', () => {
    expect(details({ ...valid, approverUserId: 9 }).approverUserId).toEqual(['الموظف المختار ليس من معتمِدي السلف المضبوطين في إعدادات السلف.']);

    // مبلغٌ خاطئٌ ومعتمِدٌ خاطئ: لا يُذكر المعتمِد قبل أن تصحّ الحقول — كترتيب الويب
    expect(details({ ...valid, amount: 0, approverUserId: 9 })).toEqual({ amount: ['مبلغ السلفة يجب أن يكون أكبر من صفر'] });
  });

  it('an unparsable approver id is "not found", not "not an approver"', () => {
    expect(details({ ...valid, approverUserId: 'x' }).approverUserId).toEqual(['الموظف المعتمد المحدد غير موجود']);
    expect(details({ ...valid, approverUserId: 0 }).approverUserId).toEqual(['الموظف المعتمد المحدد غير موجود']);
  });

  it('an empty approver list refuses every candidate', () => {
    expect(details(valid, { ...opts, approverIds: [] }).approverUserId).toEqual(['الموظف المختار ليس من معتمِدي السلف المضبوطين في إعدادات السلف.']);
  });
});
