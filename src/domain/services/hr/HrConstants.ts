/**
 * مفردات الموارد البشرية المشتركة مع الويب — أسماء الصلاحيات (`HrPermissions`)
 * وميزات الباقة (`HrPlanFeatures`) ومفتاح التطبيق (`ApplicationRegistry`)
 * والمراحلُ وتسمياتُها كما تكتبها الشاشات حرفاً بحرف.
 */

/** مفتاح «شاشة التطبيقات» الذي تحرسه شاشاتُ الرواتب — لا `employees` */
export const SALARIES_MODULE = { key: 'salaries', label: 'المرتّبات' };

/** ميزات باقة فوترة — `HrPlanFeatures` */
export const HR_PLAN = {
  advances: 'hr_advances',
  deductions: 'hr_deductions',
  /** «قسائم الرواتب» = اتفاقُ الراتب (`salary_slips`) */
  payslips: 'hr_payslips',
  /** «سجلات الصرف» الشهرية (`payroll_runs`) */
  payroll: 'hr_payroll',
} as const;

/** عدّادٌ شهري في باقة فوترة — جدولُه `salary_advance_requests` */
export const ADVANCE_REQUESTS_LIMIT = 'advance_requests';

/** صلاحيات الأدوار كما في `role_has_permissions` */
export const HR_PERMISSIONS = {
  advancesIndex: 'loans.index',
  advanceCreate: 'loans.create',
  /** الويب يطلب صلاحيةَ العرض لشاشة التفاصيل فوق صلاحية القائمة — `@show` في كل متحكّم */
  advanceShow: 'loans.show',
  advanceApprove: 'loans.approve',
  deductionsIndex: 'deductions.index',
  deductionShow: 'deductions.show',
  salarySlipsIndex: 'payslips.index',
  salarySlipShow: 'payslips.show',
  payslipsIndex: 'disbursements.index',
  payslipShow: 'disbursements.show',
} as const;

/** إعدادُ أقسام معتمِدي السلف — `AdvanceApprovers::SETTING` */
export const ADVANCE_APPROVER_DEPARTMENTS_SETTING = 'advance_approver_department_ids';

/** نوعُ صفّ `logs` لطلبات السلف، ونوعُ صفّ `notifications` */
export const ADVANCE_LOG_TYPE = 'salary_advance_request_log';
export const ADVANCE_NOTIFICATION_TYPE = 'advance_request';

/** سببُ السحب كما يكتبه الويب حرفياً */
export const ADVANCE_WITHDRAW_REASON = 'سحبه الموظف قبل البتّ فيه';

/** بادئاتُ مراجع قيود السلفة — `SalaryAdvanceService` (الصرف والإصدار والتسوية والإلغاء) */
export const ADVANCE_JOURNAL_PREFIXES = ['ADV-REQ-', 'ADV-ISSUE-', 'ADV-SETTLE-', 'ADV-CANCEL-'];

/** بادئةُ قيد إلغاء السلفة القديمة — `SalaryAdvanceService::cancelLegacy()` */
export const LEGACY_ADVANCE_JOURNAL_PREFIXES = ['ADV-A-CANCEL-'];

/** بادئاتُ مراجع قيود الخصمية — `DeductionController::show()` */
export const DEDUCTION_JOURNAL_PREFIXES = ['DED-', 'DED-CAN-', 'DED-COL-', 'DED-WVR-'];

/* ══════════════════ السلف ══════════════════ */

export type AdvanceStage = 'pending' | 'approved' | 'disbursed' | 'repaying' | 'settled' | 'rejected' | 'cancelled';

/** `SalaryAdvanceRequest::STAGES` — العناوين نفسُها */
export const ADVANCE_STAGE_LABELS: Record<AdvanceStage, string> = {
  pending: 'بانتظار الاعتماد',
  approved: 'معتمدة — بانتظار الصرف',
  disbursed: 'مصروفة — في دورة السداد',
  repaying: 'قيد السداد',
  settled: 'مسدَّدة بالكامل',
  rejected: 'مرفوضة',
  cancelled: 'ملغاة',
};

export const ADVANCE_STAGES = Object.keys(ADVANCE_STAGE_LABELS) as AdvanceStage[];

/** المراحلُ التي تعرفها السلفُ القديمة (`salary_advances`) — لا مراحلَ طلبٍ لها */
export const LEGACY_ADVANCE_STAGES: AdvanceStage[] = ['disbursed', 'repaying', 'settled', 'cancelled'];

export type AdvanceType = 'normal' | 'scheduled';

/* ══════════════════ الخصميات ══════════════════ */

export type DeductionType = 'absence' | 'late' | 'early_leave' | 'half_day' | 'violation' | 'custody_damage' | 'admin_penalty' | 'other';

/** `Deduction::types()` */
export const DEDUCTION_TYPE_LABELS: Record<DeductionType, string> = {
  absence: 'غياب',
  late: 'تأخير',
  early_leave: 'انصراف مبكر',
  half_day: 'نصف يوم',
  violation: 'مخالفة',
  custody_damage: 'تلف عهدة',
  admin_penalty: 'عقوبة إدارية',
  other: 'أخرى',
};

export const DEDUCTION_TYPES = Object.keys(DEDUCTION_TYPE_LABELS) as DeductionType[];

export type DeductionStatus = 'pending' | 'approved' | 'rejected' | 'settled' | 'partially_settled' | 'cancelled';

/** `Deduction::statuses()` */
export const DEDUCTION_STATUS_LABELS: Record<DeductionStatus, string> = {
  pending: 'قيد الانتظار',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  settled: 'مسوّاة',
  partially_settled: 'مسوّاة جزئياً',
  cancelled: 'ملغاة',
};

export const DEDUCTION_STATUSES = Object.keys(DEDUCTION_STATUS_LABELS) as DeductionStatus[];

/** المعتمدةُ وغيرُ المسوّاة بالكامل — `Deduction::scopeUnsettled()` */
export const DEDUCTION_UNSETTLED_STATUSES: DeductionStatus[] = ['approved', 'partially_settled'];

/** `DeductionHistory::actionLabels()` */
export const DEDUCTION_ACTION_LABELS: Record<string, string> = {
  created: 'إنشاء',
  updated: 'تعديل',
  approved: 'اعتماد',
  rejected: 'رفض',
  cancelled: 'إلغاء',
  settled: 'تسوية',
  partially_settled: 'تسوية جزئية',
};

/* ══════════════════ اتفاق الراتب (`salary_slips`) ══════════════════ */

export type SlipStatus = 'draft' | 'approved' | 'active' | 'stopped' | 'expired';

/** `SalarySlip::statuses()` */
export const SLIP_STATUS_LABELS: Record<SlipStatus, string> = {
  draft: 'مسودة',
  approved: 'معتمدة',
  active: 'نشطة',
  stopped: 'موقوفة',
  expired: 'منتهية',
};

export const SLIP_STATUSES = Object.keys(SLIP_STATUS_LABELS) as SlipStatus[];

/**
 * اتجاهُ بند الراتب في `salary_items.type` — **1 استحقاق و2 استقطاع**.
 * ثابتا الموديل في الويب كانا مقلوبَين حتى صُحِّحا؛ والقيمُ في القاعدة على
 * هذا الاصطلاح، وعليه تُرشِّح `SalarySlip::additionItems()/deductionItems()`.
 */
export const SALARY_ITEM_ADDITION = 1;
export const SALARY_ITEM_DEDUCTION = 2;

/* ══════════════════ صرفةُ الراتب الشهرية (`payroll_runs`) ══════════════════ */

export type RunStage = 'awaiting_approval' | 'scheduled' | 'ready' | 'held' | 'paid' | 'cancelled';

/** `PayrollRun::stages()` */
export const RUN_STAGE_LABELS: Record<RunStage, string> = {
  awaiting_approval: 'بانتظار اعتماد مسير الرواتب',
  scheduled: 'معتمدة — قبل يوم الصرف',
  ready: 'مستحقة الصرف',
  held: 'موقوفة',
  paid: 'مدفوعة',
  cancelled: 'ملغاة',
};

export const RUN_STAGES = Object.keys(RUN_STAGE_LABELS) as RunStage[];

/** `PayrollRunItem` — أنواع البنود الخمسة */
export const RUN_ITEM_TYPES = ['addition', 'deduction', 'advance', 'employer', 'retro'] as const;
export type RunItemType = (typeof RUN_ITEM_TYPES)[number];

/** حالاتُ مسير الرواتب (`payrolls.status`) — الفارغةُ تُقرأ «نشطاً» */
export const PAYROLL_STATUS = { draft: 'draft', active: 'active', inactive: 'inactive' } as const;

/** `SalaryAdvance::getCurrencyTextAttribute()` — عملةُ السلفة القديمة رقمٌ لا رمز */
export const LEGACY_ADVANCE_CURRENCIES: Record<number, string> = { 1: 'SAR', 2: 'USD', 3: 'EUR', 4: 'GBP', 5: 'CNY' };
