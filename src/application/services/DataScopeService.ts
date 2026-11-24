import { User } from '../../domain/entities';
import { BranchRepository, EmployeeRepository, UserRepository } from '../../domain/repositories';

/**
 * نطاق الرؤية — ترجمة `App\\Support\\DataScope` و`HeaderBranchScope` وسمة
 * `ScopesToEmployeeHierarchy` في الويب، لتُطبَّق على بيانات الحسابات في التطبيق
 * بالضبط كما تُطبَّق في شاشات الويب.
 *
 * السلَّم من الأوسع إلى الأضيق: all ← region ← branch ← department ← team ← own.
 * و`null` تعني «بلا قيد» لا «لا أحد» — الخلط بينهما يقلب الحارس إلى باب مفتوح.
 */

export type ScopeLevel = 'all' | 'region' | 'branch' | 'department' | 'team' | 'own';

export interface DataScopeState {
  level: ScopeLevel;
  unrestricted: boolean;
  rootBranchId: number | null;
  branchIds: number[] | null;
  userIds: number[] | null;
  employeeIds: number[] | null;
}

const SCOPE_PERMISSIONS = ['data_scope_region', 'data_scope_branch', 'data_scope_department', 'data_scope_team', 'data_scope_own'];

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

export interface ScopeRepositories {
  users: Pick<UserRepository, 'idsByBranchIds' | 'idsByEmployeeIds'>;
  employees: Pick<EmployeeRepository, 'findById' | 'descendantIds' | 'idsByBranchIds' | 'idsByDepartment'>;
  branches: Pick<BranchRepository, 'findById' | 'descendantIds' | 'organisationalChildren'>;
}

export class DataScopeService {
  constructor(private readonly repos: ScopeRepositories) {}

  private hasExplicitScope(permissions: Set<string>) {
    return permissions.has('data_scope_all') || SCOPE_PERMISSIONS.some((p) => permissions.has(p));
  }

  private static isLegacyManager(user: User) {
    return !user.roleId && ['manager', 'admin', 'owner'].includes((user.role ?? '').trim().toLowerCase());
  }

  private unrestricted(level: ScopeLevel, rootBranchId: number | null): DataScopeState {
    return { level, unrestricted: true, rootBranchId, branchIds: null, userIds: null, employeeIds: null };
  }

  private personal(user: User, rootBranchId: number | null): DataScopeState {
    return {
      level: 'own',
      unrestricted: false,
      rootBranchId,
      branchIds: null,
      userIds: [user.id],
      employeeIds: user.employeeId ? [user.employeeId] : [0],
    };
  }

  /** `DataScope::compute()` */
  async state(user: User, permissions: Set<string>): Promise<DataScopeState> {
    const employee = user.employeeId ? await this.repos.employees.findById(user.employeeId) : null;
    // `Scopes::resolveBranchId`
    let rootBranchId: number | null = user.branchId ?? employee?.branchId ?? null;

    if (permissions.has('data_scope_all')) return this.unrestricted('all', rootBranchId);

    const hasAny = SCOPE_PERMISSIONS.some((p) => permissions.has(p));

    if (!hasAny && !user.employeeId) {
      return user.roleId || DataScopeService.isLegacyManager(user) ? this.unrestricted('all', rootBranchId) : this.personal(user, rootBranchId);
    }

    const isRegion = permissions.has('data_scope_region');
    const isBranch = permissions.has('data_scope_branch');

    // الرئيسيّ = المنشأة كلها، لمن فرعه الأساسي هو الرئيسيّ فقط
    if (rootBranchId) {
      const root = await this.repos.branches.findById(rootBranchId);
      if (root?.isMain) {
        const home = employee?.branchId ?? 0;
        if (home && home !== rootBranchId) {
          rootBranchId = home;
        } else if (isRegion || isBranch) {
          return this.unrestricted(isRegion ? 'region' : 'branch', rootBranchId);
        }
      }
    }

    if ((isRegion || isBranch) && rootBranchId) {
      const branchIds = isRegion
        ? uniq([rootBranchId, ...(await this.repos.branches.descendantIds(rootBranchId))])
        : await this.repos.branches.organisationalChildren([rootBranchId]);

      return {
        level: isRegion ? 'region' : 'branch',
        unrestricted: false,
        rootBranchId,
        branchIds,
        userIds: await this.repos.users.idsByBranchIds(branchIds),
        employeeIds: await this.repos.employees.idsByBranchIds(branchIds),
      };
    }

    if (permissions.has('data_scope_department') && employee?.departmentId) {
      const employeeIds = await this.repos.employees.idsByDepartment(employee.departmentId);
      return {
        level: 'department',
        unrestricted: false,
        rootBranchId,
        branchIds: null,
        userIds: await this.repos.users.idsByEmployeeIds(employeeIds),
        employeeIds,
      };
    }

    if (permissions.has('data_scope_team') && employee) {
      const employeeIds = uniq([employee.id, ...(await this.repos.employees.descendantIds(employee.id))]);
      return {
        level: 'team',
        unrestricted: false,
        rootBranchId,
        branchIds: null,
        userIds: await this.repos.users.idsByEmployeeIds(employeeIds),
        employeeIds,
      };
    }

    return this.personal(user, rootBranchId);
  }

  /** محور الأشخاص: مقيَّد ولا يحمل فروعاً */
  private static isPeopleAxis(state: DataScopeState) {
    return !state.unrestricted && state.branchIds === null;
  }

  /** `DataScope::documentEmployeeIds()` */
  private async documentEmployeeIds(user: User, permissions: Set<string>, state: DataScopeState): Promise<number[] | null> {
    const ids = state.employeeIds;
    if (ids === null || !DataScopeService.isPeopleAxis(state)) return ids;
    if (state.level !== 'own' || this.hasExplicitScope(permissions)) return ids;

    const employee = user.employeeId ? await this.repos.employees.findById(user.employeeId) : null;
    if (!employee) return ids;

    return uniq([employee.id, ...(await this.repos.employees.descendantIds(employee.id))]);
  }

  /** `DataScope::documentEmployeeIds()` — موظفو نطاق المستندات (بلا ضمّ الفريق) */
  async documentEmployees(user: User, permissions: Set<string>, state?: DataScopeState): Promise<number[] | null> {
    const st = state ?? (await this.state(user, permissions));
    return this.documentEmployeeIds(user, permissions, st);
  }

  /** `DataScope::documentUserIds()` — مستخدمو نطاق المستندات (بلا ضمّ الفريق) */
  async documentUserIds(user: User, permissions: Set<string>, state?: DataScopeState): Promise<number[] | null> {
    const st = state ?? (await this.state(user, permissions));
    const employees = await this.documentEmployeeIds(user, permissions, st);
    if (employees === null) return null;
    if (!DataScopeService.isPeopleAxis(st)) return st.userIds;
    return uniq([...(await this.repos.users.idsByEmployeeIds(employees)), user.id]);
  }

  /** `DataScope::selectableBranchIds()` — الفروع التي يحقّ له اختيارها (null = الكلّ) */
  async selectableBranchIds(state: DataScopeState): Promise<number[] | null> {
    if (state.unrestricted) return null;
    if (state.branchIds !== null) return state.branchIds;
    const root = state.rootBranchId;
    return root ? uniq([root, ...(await this.repos.branches.descendantIds(root))]) : null;
  }

  /** `ScopesToEmployeeHierarchy::accessibleUserIds()` — معرّفات المنشئين المسموحة لمستندات المستخدم */
  async accessibleUserIds(user: User, permissions: Set<string>, state?: DataScopeState): Promise<number[] | null> {
    const st = state ?? (await this.state(user, permissions));
    const employees = await this.documentEmployeeIds(user, permissions, st);
    if (employees === null) return null;

    let ids: number[];
    if (!DataScopeService.isPeopleAxis(st)) {
      ids = st.userIds ?? [];
    } else {
      ids = [...(await this.repos.users.idsByEmployeeIds(employees)), user.id];
    }

    const team = user.employeeId ? await this.repos.employees.descendantIds(user.employeeId) : [];
    const teamUsers = team.length ? await this.repos.users.idsByEmployeeIds(team) : [];

    return uniq([...ids, user.id, ...teamUsers]);
  }

  /** `ScopesToEmployeeHierarchy::accessibleEmployeeIds()` — يُستعمل لخزائن الموظفين */
  async accessibleEmployeeIds(user: User, permissions: Set<string>, state?: DataScopeState): Promise<number[] | null> {
    if (permissions.has('data_scope_all')) return null;
    if (!user.employeeId) return null;

    const st = state ?? (await this.state(user, permissions));
    const ids = await this.documentEmployeeIds(user, permissions, st);
    if (ids === null) return null;

    const team = await this.repos.employees.descendantIds(user.employeeId);
    return uniq([...ids, user.employeeId, ...team]);
  }

  /** `HeaderBranchScope::nodeId()` — فرع الشريط العلوي الذي تُرشَّح عليه القوائم */
  async headerBranchNode(user: User, state: DataScopeState): Promise<number | null> {
    const nodeId = user.branchId;
    if (!nodeId) return null;

    const node = await this.repos.branches.findById(nodeId);
    if (!node?.isMain) return nodeId;

    // الرئيسيّ يرفع قيد المكان لمن لا قيد عليه فقط
    if (state.unrestricted) return null;

    // `DataScope::clampNode()`
    const allowed = state.branchIds;
    if (allowed === null) return nodeId;
    return allowed.includes(nodeId) ? nodeId : state.rootBranchId;
  }

  /** `BelongsToBranch::scopeForBranch` — الفرع وأبناؤه */
  async branchFilterIds(node: number | null): Promise<number[] | null> {
    if (!node || node <= 0) return null;
    return uniq([node, ...(await this.repos.branches.descendantIds(node))]);
  }
}
