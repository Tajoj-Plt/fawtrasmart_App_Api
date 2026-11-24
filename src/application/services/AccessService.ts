import { Branch, User } from '../../domain/entities';
import { BranchRepository, EmployeeRepository, RoleRepository } from '../../domain/repositories';
import { Cache } from '../ports';

/**
 * الصلاحيات ونطاق الفروع — ترجمة `hasPermission()` و`User::hasRolePermission()`
 * و`App\Support\BranchScope` من الويب.
 *
 * الصلاحيات تُقرأ من دور المستخدم الأساسي (`users.role_id` ← `role_has_permissions`)
 * لا من `model_has_roles`، كما يفعل `CheckPermissionRole` في الويب.
 */
export class AccessService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly employees: EmployeeRepository,
    private readonly branches: BranchRepository,
    private readonly cache: Cache,
    private readonly permissionsTtl: number,
  ) {}

  async permissionsForRole(roleId: number | null): Promise<Set<string>> {
    if (roleId === null) return new Set();

    const names = await this.cache.wrap(`perm:role:${roleId}`, this.permissionsTtl, () =>
      this.roles.permissionNames(roleId),
    );

    return new Set(names);
  }

  async permissionsFor(user: User): Promise<Set<string>> {
    return this.permissionsForRole(user.roleId);
  }

  /** يقبل بدائل مفصولة بـ`|` كما في الويب */
  static has(permissions: Set<string>, permission: string): boolean {
    return permission.split('|').some((p) => permissions.has(p.trim()));
  }

  forgetRole(roleId: number | null) {
    if (roleId !== null) this.cache.del(`perm:role:${roleId}`);
  }

  /** الفرع الفعلي للمستخدم — `Scopes::resolveBranchId` */
  async resolveBranchId(user: User): Promise<number | null> {
    if (user.branchId) return user.branchId;
    if (!user.employeeId) return null;
    const employee = await this.employees.findById(user.employeeId);
    return employee?.branchId ?? null;
  }

  /** الفروع التي يجوز للمستخدم التبديل إليها — `BranchScope::resolve` */
  async switchableBranches(user: User, permissions: Set<string>): Promise<Branch[]> {
    // ١. بلا قيد — لمالك data_scope_all ولمن ليس موظفاً
    if (permissions.has('data_scope_all') || !user.employeeId) {
      return this.branches.active();
    }

    const own = await this.resolveBranchId(user);
    const assigned = await this.employees.assignedBranchIds(user.employeeId);
    const baseIds = Array.from(new Set([...assigned, ...(own ? [own] : [])]));

    // ٢. فروعه وما تحتها في الشجرة
    if (baseIds.length > 0 && permissions.has('data_scope_region')) {
      const all = new Set<number>(baseIds);
      for (const id of baseIds) {
        for (const d of await this.branches.descendantIds(id)) all.add(d);
      }
      return this.branches.activeByIds(Array.from(all));
    }

    // ٣. فروعه وحدها
    if (baseIds.length > 0 && permissions.has('data_scope_branch')) {
      return this.branches.activeByIds(baseIds);
    }

    // ٤. من يدير موظفين: فروعه وفروع التابعين له
    const descendants = await this.employees.descendantIds(user.employeeId);
    if (descendants.length > 0) {
      const teamBranches = await this.employees.branchIdsOf(descendants);
      const ids = Array.from(new Set([...baseIds, ...teamBranches]));
      if (ids.length > 0) return this.branches.activeByIds(ids);
    }

    // ٥. فرعه وحده
    return baseIds.length > 0 ? this.branches.activeByIds(baseIds) : [];
  }
}
