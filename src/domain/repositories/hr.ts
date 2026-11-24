import { Tx } from '../../application/ports';
import { AdvanceStage, DeductionStatus, DeductionType, RunStage, SlipStatus } from '../services/hr/HrConstants';

/**
 * عقودُ وحدة الموارد البشرية — جداولُ الويب نفسها: `salary_advance_requests`
 * (نظام الطلبات) و`salary_advances` + `installment_payments` (السلفُ القديمة)،
 * و`deductions` + `deduction_histories`، و`salary_slips` + `salary_items`
 * (اتفاقُ الراتب)، و`payroll_runs` + `payroll_run_items` (الصرفةُ الشهرية).
 */

export interface NamedRef {
  id: number;
  name: string;
}

export interface JournalRef {
  id: number;
  referenceNumber: string | null;
  date: string | null;
}

/* ══════════════════ الموظف وملخّص سلفه ══════════════════ */

export interface HrEmployeeCard {
  id: number;
  name: string;
  /** الأوّل والأوسط وحدهما — إشعارُ طلب السلفة يكتب الاسمَ بهما لا بالكامل */
  firstName: string | null;
  middleName: string | null;
  jobTitle: string | null;
  department: string | null;
  hasAdvanceAccount: boolean;
  advanceAccountId: number | null;
}

/** `Employee::getAdvanceSummary()` — من دفتر القيود على حساب سلف الموظف */
export interface AdvanceSummary {
  issued: number;
  settled: number;
  remaining: number;
}

/* ══════════════════ السلف ══════════════════ */

/** صفُّ `salary_advance_requests` كما تُقرأ أعمدتُه (المرحلةُ تُحسب في المجال) */
export interface AdvanceRequestRecord {
  id: number;
  employeeId: number | null;
  employeeName: string | null;
  amount: number;
  advanceType: string | null;
  installmentsCount: number;
  installmentAmount: number;
  startMonth: string | null;
  paidInstallments: number;
  remainingInstallments: number;
  reason: string | null;
  status: string | null;
  requestedDate: string | null;
  approvedDate: string | null;
  approvedByName: string | null;
  approverUserId: number | null;
  approverName: string | null;
  treasuryId: number | null;
  treasuryName: string | null;
  rejectionReason: string | null;
  adminNotes: string | null;
  isSettled: boolean;
  settledAmount: number | null;
  disbursedAt: string | null;
  disbursedByName: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** قيدا الصرف والعكس كما حُفظا على الصفّ — أدقُّ من التقاطٍ بالمرجع */
  disbursementJournalId: number | null;
  cancellationJournalId: number | null;
  /** للترتيب الموحَّد مع السلف القديمة */
  sortDate: string | null;
}

/** صفُّ `salary_advances` القديم مع ما حُسب من أقساطه */
export interface LegacyAdvanceRecord {
  id: number;
  employeeId: number | null;
  employeeName: string | null;
  amount: number;
  currency: number | null;
  installmentAmount: number;
  totalInstallments: number;
  paidCount: number;
  paidAmount: number;
  installmentStartDate: string | null;
  submissionDate: string | null;
  treasuryId: number | null;
  treasuryName: string | null;
  note: string | null;
  status: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancellationJournalId: number | null;
  sortDate: string | null;
}

export interface AdvanceInstallment {
  id: number;
  number: number;
  amount: number;
  dueDate: string | null;
  paymentDate: string | null;
  status: string | null;
}

export interface AdvanceFilters {
  /** `null` = بلا قيد، `[]` = لا أحد */
  employeeIds: number[] | null;
  search?: string;
  from?: string;
  to?: string;
}

export interface AdvanceRequestInsert {
  employeeId: number;
  amount: number;
  reason: string;
  requestedDate: string;
  approverUserId: number;
}

export interface AdvanceRepository {
  /** صفوفُ الطلبات في النطاق وبالفلاتر — بلا صفحات: القائمةُ تُدمج بالقديمة ثمّ تُقطَّع */
  requests(f: AdvanceFilters): Promise<AdvanceRequestRecord[]>;
  legacy(f: AdvanceFilters): Promise<LegacyAdvanceRecord[]>;
  findRequest(id: number): Promise<AdvanceRequestRecord | null>;
  findLegacy(id: number): Promise<LegacyAdvanceRecord | null>;
  /** أقساطُ الطلب كما تُقتطع من مسيرات الرواتب (`payroll_run_items`) */
  requestInstallments(id: number): Promise<AdvanceInstallment[]>;
  /** أقساطُ السلفة القديمة (`installment_payments`) */
  legacyInstallments(id: number): Promise<AdvanceInstallment[]>;
  /** قيودُ السلفة: ما حُفظ معرّفُه على الصفّ، وما التُقط بمرجعه `PREFIX{id}` */
  journals(id: number, opts: { ids: Array<number | null>; prefixes: string[] }): Promise<JournalRef[]>;
  /** عددُ الطلبات المعلّقة والجارية في النطاق — لبطاقة «نظرة عامة» */
  counts(employeeIds: number[] | null): Promise<{ pending: number; active: number }>;

  // ── الكتابة الوحيدة في الوحدة ──
  insertRequest(row: AdvanceRequestInsert, now: string, tx: Tx): Promise<number>;
  log(typeId: number, description: string, userId: number, now: string, tx: Tx): Promise<void>;
  notify(row: { userId: number; receiverId: number; title: string; description: string; type: string }, now: string, tx: Tx): Promise<void>;
  cancelRequest(id: number, row: { reason: string; userId: number }, now: string, tx: Tx): Promise<void>;
  /** إشعارُ الطلب عند المعتمِد لم يعد ينتظر قراراً — `%#{id}` في آخر الوصف */
  markRequestNotificationsRead(id: number, type: string, tx: Tx): Promise<void>;
}

/* ══════════════════ الخصميات ══════════════════ */

export interface DeductionRecord {
  id: number;
  code: string | null;
  employeeId: number | null;
  employeeName: string | null;
  deductionType: string | null;
  amount: number;
  settledAmount: number;
  status: string | null;
  date: string | null;
  reason: string | null;
  notes: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  settledAt: string | null;
  postedAmount: number;
}

export interface DeductionHistoryRecord {
  id: number;
  action: string | null;
  description: string | null;
  notes: string | null;
  amount: number | null;
  at: string | null;
  userId: number | null;
  userName: string | null;
}

export interface DeductionFilters {
  employeeIds: number[] | null;
  status?: DeductionStatus;
  type?: DeductionType;
  search?: string;
  from?: string;
  to?: string;
}

export interface DeductionStats {
  pending: number;
  approved: number;
  settled: number;
  cancelled: number;
  unsettledTotal: number;
}

export interface DeductionRepository {
  page(f: DeductionFilters, page: number, perPage: number): Promise<{ rows: DeductionRecord[]; total: number; totals: { amount: number; remaining: number } }>;
  stats(f: DeductionFilters): Promise<DeductionStats>;
  find(id: number): Promise<DeductionRecord | null>;
  history(id: number): Promise<DeductionHistoryRecord[]>;
  journals(id: number, prefixes: string[]): Promise<JournalRef[]>;
  /** عددُ خصميات النطاق وما لم يُسوَّ منها — لبطاقة «نظرة عامة» */
  overview(employeeIds: number[] | null): Promise<{ count: number; pending: number; unsettledTotal: number }>;
}

/* ══════════════════ اتفاق الراتب والصرفة الشهرية ══════════════════ */

export interface SlipRecord {
  id: number;
  code: string | null;
  employeeId: number | null;
  employeeName: string | null;
  basicAmount: number;
  currency: string | null;
  frequency: string | null;
  scheduledPaymentDay: number | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  notes: string | null;
  approvedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
}

export interface SlipComponent {
  id: number;
  name: string | null;
  amount: number;
  /** `salary_items.type`: 1 استحقاق و2 استقطاع */
  type: number;
  isInsurable: boolean;
}

export interface SlipFilters {
  employeeIds: number[] | null;
  status?: SlipStatus;
  search?: string;
}

export interface RunRecord {
  id: number;
  employeeId: number | null;
  employeeName: string | null;
  salarySlipId: number | null;
  /** عملةُ اتفاق الراتب — `payroll_runs` نفسه بلا عمود عملة */
  currency: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  scheduledDate: string | null;
  basicAmount: number;
  totalAdditions: number;
  totalDeductions: number;
  totalAdvancesDeducted: number;
  netSalary: number;
  status: string | null;
  heldAt: string | null;
  disbursedAt: string | null;
  notes: string | null;
  treasuryId: number | null;
  treasuryName: string | null;
  /** لاشتقاق المرحلة: مسيرُ رواتب قسيمة الصرفة */
  hasSlip: boolean;
  slipPayrollId: number | null;
  payrollExists: boolean;
  payrollStatus: string | null;
}

export interface RunItem {
  id: number;
  itemType: string | null;
  name: string | null;
  amount: number;
  description: string | null;
  sourceTable: string | null;
  sourceId: number | null;
}

export interface RunFilters {
  employeeIds: number[] | null;
  stage?: RunStage;
  search?: string;
  from?: string;
  to?: string;
}

export interface PayrollRepository {
  slipPage(f: SlipFilters, page: number, perPage: number): Promise<{ rows: SlipRecord[]; total: number }>;
  findSlip(id: number): Promise<SlipRecord | null>;
  /** بنودُ القسائم مجموعةً بمعرّف القسيمة — استعلامٌ واحدٌ لصفحةٍ كاملة */
  slipComponents(slipIds: number[]): Promise<Map<number, SlipComponent[]>>;
  /** آخرُ صرفةٍ للموظف — بطاقةُ «نظرة عامة» */
  latestRunForEmployee(employeeId: number): Promise<RunRecord | null>;
  runPage(f: RunFilters, page: number, perPage: number, today: string, requiresApproval: boolean): Promise<{ rows: RunRecord[]; total: number }>;
  findRun(id: number): Promise<RunRecord | null>;
  runItems(runId: number): Promise<RunItem[]>;
}

/* ══════════════════ المراجع المشتركة ══════════════════ */

export interface HrReferenceRepository {
  employeeCard(employeeId: number): Promise<HrEmployeeCard | null>;
  /** رصيدُ حساب سلف الموظف من `journal_entry_details` — مدين/دائن */
  advanceSummary(advanceAccountId: number | null): Promise<AdvanceSummary>;
  /** قيمةُ عمودٍ من `payroll_settings` — الصفُّ الواحد */
  payrollSetting(column: string): Promise<unknown>;
  /** المستخدمون الذين تملك أدوارُهم صلاحيةً بعينها */
  usersWithPermission(permission: string): Promise<Array<{ id: number; name: string; employeeId: number | null }>>;
  /** موظفو هذه الأقسام — العمود الأساسي ∪ `department_employee` */
  employeeIdsInDepartments(departmentIds: number[]): Promise<number[]>;
  /** حسابُ المستخدم المرتبط بسجلّ موظف — لإشعار صاحب الطلب */
  userIdForEmployee(employeeId: number): Promise<number | null>;
}

export type { AdvanceStage, DeductionStatus, DeductionType, RunStage, SlipStatus };
