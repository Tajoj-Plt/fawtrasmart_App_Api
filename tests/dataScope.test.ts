import { describe, expect, it } from 'vitest';
import { DataScopeService, ScopeRepositories } from '../src/application/services/DataScopeService';
import { Branch, Employee, User } from '../src/domain/entities';

/**
 * شركة صغيرة:
 *   فرع رئيسي 1 (is_main) ← فرع أبها 2 ← منفذ 3 (outlet)      فرع جدة 4
 *   موظفون: 10 مدير (أبها) ← 11 مندوب (أبها) ← 12 (أبها، يتبع 11)   ·   13 (جدة)
 *   مستخدمون: u100↔emp10, u101↔emp11, u102↔emp12, u103↔emp13
 */
const branches: Record<number, Branch & { nodeType: string }> = {
  1: { id: 1, name: 'الرئيسي', code: 'M', isMain: true, parentId: null, status: 0, city: null, nodeType: 'branch' },
  2: { id: 2, name: 'أبها', code: 'A', isMain: false, parentId: 1, status: 0, city: null, nodeType: 'branch' },
  3: { id: 3, name: 'منفذ', code: 'O', isMain: false, parentId: 2, status: 0, city: null, nodeType: 'outlet' },
  4: { id: 4, name: 'جدة', code: 'J', isMain: false, parentId: 1, status: 0, city: null, nodeType: 'branch' },
};

const emp = (id: number, branchId: number, managerId: number | null, departmentId = 1): Employee => ({
  id, firstName: 'e' + id, middleName: null, nickname: null, photo: null, code: null, email: `e${id}@x.com`, mobile: null,
  allowSystemAccess: true, status: 1, branchId, departmentId, jobTitleId: null, directManagerId: managerId, hireDate: null, deletedAt: null,
});

const employees: Record<number, Employee> = { 10: emp(10, 2, null), 11: emp(11, 2, 10), 12: emp(12, 2, 11), 13: emp(13, 4, null, 2) };
const userOfEmployee: Record<number, number> = { 10: 100, 11: 101, 12: 102, 13: 103 };

const repos: ScopeRepositories = {
  users: {
    idsByBranchIds: async (ids) => [100, 101, 102, 103].filter((u) => ids.includes(employees[Object.keys(userOfEmployee).map(Number).find((e) => userOfEmployee[e] === u)!].branchId!)),
    idsByEmployeeIds: async (ids) => ids.map((e) => userOfEmployee[e]).filter(Boolean),
  },
  employees: {
    findById: async (id) => employees[id] ?? null,
    descendantIds: async (id) => {
      const out: number[] = [];
      let frontier = [id];
      while (frontier.length) {
        const next = Object.values(employees).filter((e) => frontier.includes(e.directManagerId ?? -1)).map((e) => e.id);
        out.push(...next);
        frontier = next;
      }
      return out;
    },
    idsByBranchIds: async (ids) => Object.values(employees).filter((e) => ids.includes(e.branchId ?? -1)).map((e) => e.id),
    idsByDepartment: async (d) => Object.values(employees).filter((e) => e.departmentId === d).map((e) => e.id),
  },
  branches: {
    findById: async (id) => branches[id] ?? null,
    descendantIds: async (id) => {
      const out: number[] = [];
      let frontier = [id];
      while (frontier.length) {
        const next = Object.values(branches).filter((b) => frontier.includes(b.parentId ?? -1)).map((b) => b.id);
        out.push(...next);
        frontier = next;
      }
      return out;
    },
    organisationalChildren: async (roots) => {
      const out = [...roots];
      let frontier = [...roots];
      while (frontier.length) {
        const next = Object.values(branches).filter((b) => frontier.includes(b.parentId ?? -1) && b.nodeType !== 'branch' && !out.includes(b.id)).map((b) => b.id);
        out.push(...next);
        frontier = next;
      }
      return out;
    },
  },
};

const user = (over: Partial<User>): User => ({
  id: 101, name: 'u', email: 'u@x.com', phone: null, passwordHash: '', role: 'employee', roleId: 5, employeeId: 11, branchId: 2, clientId: null, avatar: null, lastLoginAt: null, ...over,
});

const svc = new DataScopeService(repos);
const perms = (...p: string[]) => new Set(p);

describe('DataScopeService — the web scope ladder', () => {
  it('data_scope_all is unrestricted: no creator filter', async () => {
    const u = user({});
    expect(await svc.accessibleUserIds(u, perms('data_scope_all'))).toBeNull();
    expect((await svc.state(u, perms('data_scope_all'))).unrestricted).toBe(true);
  });

  it('own scope with an employee still sees the direct reports (legacy hierarchy) and self', async () => {
    const ids = await svc.accessibleUserIds(user({}), perms('data_scope_own'));
    // self (101) + subordinate (102); never the manager 100 or Jeddah 103
    expect(ids?.sort()).toEqual([101, 102]);
  });

  it('team scope: me and my reports', async () => {
    const ids = await svc.accessibleUserIds(user({}), perms('data_scope_team'));
    expect(ids?.sort()).toEqual([101, 102]);
  });

  it('a manager (team) sees the whole chain below', async () => {
    const ids = await svc.accessibleUserIds(user({ id: 100, employeeId: 10 }), perms('data_scope_team'));
    expect(ids?.sort()).toEqual([100, 101, 102]);
  });

  it('branch scope: users of the branch and its outlets, not other branches', async () => {
    const state = await svc.state(user({ id: 100, employeeId: 10 }), perms('data_scope_branch'));
    expect(state.level).toBe('branch');
    expect(state.branchIds?.sort()).toEqual([2, 3]);
    const ids = await svc.accessibleUserIds(user({ id: 100, employeeId: 10 }), perms('data_scope_branch'));
    expect(ids).toContain(101);
    expect(ids).not.toContain(103);
  });

  it('region scope includes every branch below', async () => {
    const state = await svc.state(user({ id: 100, employeeId: 10, branchId: 1 }), perms('data_scope_region'));
    // sitting on the main branch with home branch Abha: scope is measured on the home branch
    expect(state.branchIds?.sort()).toEqual([2, 3]);
  });

  it('a non-employee with a role and no scope is unrestricted (system admin)', async () => {
    expect(await svc.accessibleUserIds(user({ employeeId: null, roleId: 1 }), perms())).toBeNull();
  });

  it('a non-employee with no role stays personal', async () => {
    const ids = await svc.accessibleUserIds(user({ id: 999, employeeId: null, roleId: null, role: 'client' }), perms());
    expect(ids).toEqual([999]);
  });

  it('an employee with no scope at all falls back to own', async () => {
    const state = await svc.state(user({}), perms());
    expect(state.level).toBe('own');
  });
});

describe('header branch node', () => {
  it('a normal branch is used as is, with its subtree for filtering', async () => {
    const u = user({ branchId: 2 });
    const state = await svc.state(u, perms('data_scope_own'));
    const node = await svc.headerBranchNode(u, state);
    expect(node).toBe(2);
    expect((await svc.branchFilterIds(node))?.sort()).toEqual([2, 3]);
  });

  it('standing on the main branch lifts the branch filter only for the unrestricted', async () => {
    const u = user({ branchId: 1 });
    expect(await svc.headerBranchNode(u, await svc.state(u, perms('data_scope_all')))).toBeNull();
  });

  it('a person-scoped employee on the main branch keeps that node (their creator scope still limits the rows)', async () => {
    const u = user({ branchId: 1 });
    const state = await svc.state(u, perms('data_scope_own'));
    expect(await svc.headerBranchNode(u, state)).toBe(1);
    // ...and the documents visible are still only theirs and their reports
    expect((await svc.accessibleUserIds(u, perms('data_scope_own')))?.sort()).toEqual([101, 102]);
  });

  it('a branch-scoped manager standing on the main branch is clamped back to their own branch', async () => {
    const u = user({ id: 100, employeeId: 10, branchId: 1 });
    const state = await svc.state(u, perms('data_scope_branch'));
    expect(state.level).toBe('branch');
    expect(await svc.headerBranchNode(u, state)).toBe(2);
  });

  it('no branch means no filter', async () => {
    const u = user({ branchId: null, employeeId: null });
    const state = await svc.state(u, perms('data_scope_all'));
    expect(await svc.branchFilterIds(await svc.headerBranchNode(u, state))).toBeNull();
  });
});

describe('treasury employees', () => {
  it('unrestricted users have no employee filter', async () => {
    expect(await svc.accessibleEmployeeIds(user({}), perms('data_scope_all'))).toBeNull();
  });

  it('a restricted employee gets themselves plus their reports', async () => {
    expect((await svc.accessibleEmployeeIds(user({}), perms('data_scope_own')))?.sort()).toEqual([11, 12]);
  });
});
