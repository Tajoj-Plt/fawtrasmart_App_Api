import { User } from '../../../domain/entities';
import { AppError } from '../../../domain/errors/AppError';
import { BranchRepository, EmployeeRepository } from '../../../domain/repositories';
import { toSqlDate, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { SALARIES_MODULE } from '../../../domain/services/hr/HrConstants';
import { Clock } from '../../ports';
import { AccessService } from '../AccessService';
import { ErpGate, GateRequirements } from '../access/ErpGate';
import { RequestMeta } from '../clients/ClientsContext';

const uniq = (ids: Array<number | null | undefined>) => Array.from(new Set(ids.filter((v): v is number => Boolean(v)).map(Number)));

/**
 * سياقُ طلبٍ في الموارد البشرية ونطاقُه — ترجمةُ
 * `Modules\HR\…\Concerns\ScopesToAccessibleEmployees` حرفاً بحرف.
 *
 * نطاقُ هذه الوحدة محورُه **الموظف** لا منشئُ السجل: قسيمةُ الراتب تخصّ من
 * صُرفت له، لا كاتبَ الرواتب الذي أنشأها. ولذلك لا تُستعمل هنا
 * `DataScopeService.accessibleEmployeeIds()` — سلَّمُها يُضيف فريقَ المستخدم
 * دائماً ويفتح الباب لمستخدمٍ بلا سجلّ موظف، والموارد البشرية تفعل عكسَ
 * الاثنين: الفريقُ يُضاف في مستوى «الفريق» وحده، ومن لا سجلَّ موظفٍ له ولا
 * نطاقَ فرعٍ أو «كلّ» لا يرى أحداً.
 *
 * و`null` تعني «بلا قيد» و`[]` تعني «لا أحد» — الخلطُ بينهما يقلب الحارسَ
 * إلى بابٍ مفتوح أو شاشةٍ فارغة.
 */
export class HrContext {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly user: User,
    readonly permissions: Set<string>,
    readonly now: Date,
    readonly meta: RequestMeta,
    private readonly deps: { employees: EmployeeRepository; branches: BranchRepository },
  ) {}

  can(permission: string | string[]): boolean {
    return (Array.isArray(permission) ? permission : [permission]).some((p) => AccessService.has(this.permissions, p));
  }

  get today(): string {
    return toSqlDate(this.now);
  }

  get nowSql(): string {
    return toSqlDateTime(this.now);
  }

  remember<T>(key: string, producer: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, producer());
    return this.memo.get(key) as Promise<T>;
  }

  /** سجلُّ الموظف المرتبط بالحساب — لا شيءَ لمستخدمٍ إداريٍّ محض */
  get employeeId(): number | null {
    return this.user.employeeId ?? null;
  }

  /** طلبُ السلفة يُقدَّم باسم موظف — فحسابٌ بلا سجلّ موظفٍ لا يقدّمه */
  requireEmployeeId(): number {
    if (!this.employeeId) throw new AppError('NO_EMPLOYEE', 'ليس لديك سجل موظف مرتبط — طلب السلفة يُقدَّم باسم موظف.', 422);
    return this.employeeId;
  }

  /** `Scopes::resolveBranchId()` — فرعُ المستخدم أو فرعُ سجلّ موظفه */
  private resolvedBranchId(): Promise<number | null> {
    return this.remember('branch', async () => {
      if (this.user.branchId) return this.user.branchId;
      if (!this.employeeId) return null;
      return (await this.deps.employees.findById(this.employeeId))?.branchId ?? null;
    });
  }

  /** `hrScopeBranchIds()` — فروعُ النطاق، أو `null` إن لم يكن نطاقُه فرعياً */
  private scopeBranchIds(): Promise<number[] | null> {
    return this.remember('branches', async () => {
      const isRegion = this.permissions.has('data_scope_region');
      if (!isRegion && !this.permissions.has('data_scope_branch')) return null;

      const branchId = await this.resolvedBranchId();
      // نطاقٌ فرعيٌّ بلا فرع: يُعامَل كموظفٍ عاديّ بدل أن يُفتح له كلُّ شيء
      if (!branchId) return null;
      if (!isRegion) return [branchId];

      const descendants = await this.deps.branches.descendantIds(branchId);
      return uniq([branchId, ...descendants]);
    });
  }

  /** `accessibleEmployeeIds()` — «لا رأسَ فرعٍ في الشريط»: القوائمُ والسجلُّ المفرد على الصلاحية وحدها */
  accessibleEmployeeIds(): Promise<number[] | null> {
    return this.remember('employees', async () => {
      if (this.permissions.has('data_scope_all')) return null;

      const branchIds = await this.scopeBranchIds();
      if (branchIds !== null) return this.deps.employees.idsByBranchIds(branchIds);

      // ليس موظفاً ولا نطاقَ أوسعَ له: «بياناته هو» لا شيءَ فيها
      if (!this.employeeId) return [];

      const employee = await this.deps.employees.findById(this.employeeId);
      if (!employee) return [this.employeeId];

      if (this.permissions.has('data_scope_department')) {
        // نطاقُ قسمٍ بلا قسمٍ محفوظ: يُضيَّق إلى نفسه لا أن يُفتح له كل شيء
        return employee.departmentId ? this.deps.employees.idsByDepartment(employee.departmentId) : [employee.id];
      }

      if (this.permissions.has('data_scope_team')) {
        return uniq([employee.id, ...(await this.deps.employees.descendantIds(employee.id))]);
      }

      return [employee.id];
    });
  }

  /** `canAccessEmployee()` */
  async canAccessEmployee(employeeId: number | null): Promise<boolean> {
    const ids = await this.accessibleEmployeeIds();
    if (ids === null) return true;
    return employeeId !== null && ids.includes(Number(employeeId));
  }

  /**
   * `authorizeEmployeeScope()` — 403 لا 404: السجلُّ موجودٌ وإنما خارج النطاق،
   * والتقييدُ في القائمة وحدَه لا يكفي لأن `show/{id}` تُطلب بمعرّفٍ مباشر.
   */
  async assertEmployeeScope(employeeId: number | null): Promise<void> {
    if (!(await this.canAccessEmployee(employeeId))) {
      throw AppError.forbidden('OUT_OF_SCOPE', 'هذا السجل خارج نطاق الموظفين المصرّح لك بالاطّلاع عليهم.');
    }
  }
}

/** يبني سياقَ الموارد البشرية بعد حارس الباب: الاشتراك ← «المرتّبات» ← ميزة الباقة ← الصلاحية */
export class HrContextFactory {
  constructor(
    private readonly gate: ErpGate,
    private readonly employees: EmployeeRepository,
    private readonly branches: BranchRepository,
    private readonly clock: Clock,
  ) {}

  async load(userId: number, meta: RequestMeta, req: Omit<GateRequirements, 'module'> = {}): Promise<HrContext> {
    const { user, permissions } = await this.gate.enter(userId, { module: SALARIES_MODULE, ...req });
    return new HrContext(user, permissions, this.clock.now(), meta, { employees: this.employees, branches: this.branches });
  }
}
