import { Knex } from 'knex';
import { AdvanceSummary, HrEmployeeCard, HrReferenceRepository } from '../../../domain/repositories/hr';
import { employeeFullName } from '../../../domain/services/hr/HrDomain';

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const day = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
export const stamp = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 19).replace('T', ' '));
export const flag = (v: unknown): boolean => v === true || v === 1 || v === '1';

export const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** اسمُ الموظف من أعمدته الثلاثة — `Employee::full_name` */
export const rowEmployeeName = (r: Record<string, unknown>, prefix = 'employee_'): string | null => {
  const name = employeeFullName({
    firstName: str(r[`${prefix}first`]),
    middleName: str(r[`${prefix}middle`]),
    nickname: str(r[`${prefix}nickname`]),
  });
  return name === '' ? null : name;
};

/** أعمدةُ اسم الموظف في استعلامٍ موصولٍ بـ`employees as e` */
export const EMPLOYEE_NAME_COLUMNS = ['e.first_name as employee_first', 'e.middle_name as employee_middle', 'e.nickname as employee_nickname'];

/** شرطُ البحث على اسم الموظف كما في شاشات الويب */
export function whereEmployeeName(q: Knex.QueryBuilder, alias: string, term: string) {
  const like = likeTerm(term);
  q.where(`${alias}.first_name`, 'like', like).orWhere(`${alias}.middle_name`, 'like', like).orWhere(`${alias}.nickname`, 'like', like);
}

/**
 * مراجعُ الموارد البشرية المشتركة: بطاقةُ الموظف، وملخّصُ سلفه من دفتر القيود،
 * وإعداداتُ الرواتب، ومعتمِدو السلف.
 */
export class KnexHrRepository implements HrReferenceRepository {
  constructor(private readonly db: Knex) {}

  async employeeCard(employeeId: number): Promise<HrEmployeeCard | null> {
    const r = await this.db('employees as e')
      .leftJoin('departments as d', 'd.id', 'e.department_id')
      .leftJoin('jop_titles as j', 'j.id', 'e.job_title_id')
      .leftJoin('accounts as a', 'a.id', 'e.employee_advance_account_id')
      .where('e.id', employeeId)
      .first(...EMPLOYEE_NAME_COLUMNS, 'e.id', 'e.employee_advance_account_id', 'd.name as department_name', 'j.name as job_title_name', 'a.id as advance_account_exists');

    if (!r) return null;

    return {
      id: Number(r.id),
      name: rowEmployeeName(r as Record<string, unknown>) ?? `#${employeeId}`,
      firstName: str(r.employee_first),
      middleName: str(r.employee_middle),
      jobTitle: str(r.job_title_name),
      department: str(r.department_name),
      // `Employee::hasAdvanceAccount()` — العمودُ مضبوطٌ **وصفُّ الحساب قائم**
      hasAdvanceAccount: r.advance_account_exists !== null && r.advance_account_exists !== undefined,
      advanceAccountId: nullableNum(r.employee_advance_account_id),
    };
  }

  async advanceSummary(advanceAccountId: number | null): Promise<AdvanceSummary> {
    if (!advanceAccountId) return { issued: 0, settled: 0, remaining: 0 };

    const r = await this.db('journal_entry_details').where('account_id', advanceAccountId).sum({ debit: 'debit', credit: 'credit' }).first();
    const issued = Math.round(num(r?.debit) * 100) / 100;
    const settled = Math.round(num(r?.credit) * 100) / 100;

    return { issued, settled, remaining: Math.round((issued - settled) * 100) / 100 };
  }

  /** `PayrollSettings::value()` — الصفُّ الواحد؛ غيابُ الجدول أو العمود يُقرأ `null` */
  async payrollSetting(column: string): Promise<unknown> {
    try {
      const r = await this.db('payroll_settings').first(column);
      const value = (r as Record<string, unknown> | undefined)?.[column];
      return value === undefined || value === '' ? null : value;
    } catch {
      return null;
    }
  }

  /** `AdvanceApprovers::roleIds()` ثمّ مستخدمو تلك الأدوار — المصدرُ نفسُه الذي يقرؤه حارسُ المسار */
  async usersWithPermission(permission: string): Promise<Array<{ id: number; name: string; employeeId: number | null }>> {
    const roleIds: number[] = await this.db('role_has_permissions as rp')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .where('p.name', permission)
      .pluck('rp.role_id');

    const ids = Array.from(new Set(roleIds.map(Number)));
    if (ids.length === 0) return [];

    const rows = await this.db('users').whereIn('role_id', ids).orderBy('name').select('id', 'name', 'employee_id');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), employeeId: nullableNum(r.employee_id) }));
  }

  async employeeIdsInDepartments(departmentIds: number[]): Promise<number[]> {
    if (departmentIds.length === 0) return [];

    const [primary, pivot] = await Promise.all([
      this.db('employees').whereIn('department_id', departmentIds).pluck('id'),
      this.db('department_employee').whereIn('department_id', departmentIds).pluck('employee_id'),
    ]);

    return Array.from(new Set([...primary, ...pivot].map(Number).filter(Boolean)));
  }

  async userIdForEmployee(employeeId: number): Promise<number | null> {
    const r = await this.db('users').where('employee_id', employeeId).orderBy('id').first('id');
    return r ? Number(r.id) : null;
  }
}
