import { Knex } from 'knex';
import { Employee, EmployeeDetails } from '../../domain/entities';
import { EmployeeRepository } from '../../domain/repositories';
import { bool } from '../db/knex';

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function map(row: Record<string, unknown>): Employee {
  return {
    id: Number(row.id),
    firstName: String(row.first_name ?? ''),
    middleName: (row.middle_name as string | null) ?? null,
    nickname: (row.nickname as string | null) ?? null,
    photo: (row.employee_photo as string | null) ?? null,
    code: (row.employee_code as string | null) ?? null,
    email: String(row.email ?? ''),
    mobile: (row.mobile_number as string | null) ?? null,
    allowSystemAccess: bool(row.allow_system_access),
    status: Number(row.status ?? 1),
    branchId: num(row.branch_id),
    departmentId: num(row.department_id),
    jobTitleId: num(row.job_title_id),
    directManagerId: num(row.direct_manager_id),
    hireDate: row.hire_date ? String(row.hire_date).slice(0, 10) : null,
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

export class KnexEmployeeRepository implements EmployeeRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: number): Promise<Employee | null> {
    const row = await this.db('employees').where('id', id).first();
    return row ? map(row) : null;
  }

  async findDetails(id: number): Promise<EmployeeDetails | null> {
    const row = await this.db('employees as e')
      .leftJoin('departments as d', 'd.id', 'e.department_id')
      .leftJoin('jop_titles as j', 'j.id', 'e.job_title_id')
      .select('e.*', 'd.name as department_name', 'j.name as job_title_name')
      .where('e.id', id)
      .first();

    if (!row) return null;
    return { ...map(row), departmentName: (row.department_name as string | null) ?? null, jobTitleName: (row.job_title_name as string | null) ?? null };
  }

  async assignedBranchIds(employeeId: number): Promise<number[]> {
    const rows = await this.db('employee_branch').where('employee_id', employeeId).pluck('branch_id');
    return Array.from(new Set(rows.map(Number).filter(Boolean)));
  }

  async descendantIds(employeeId: number): Promise<number[]> {
    const result: number[] = [];
    let frontier = [employeeId];
    const seen = new Set<number>([employeeId]);

    // الشجرة الإدارية نادراً ما تتجاوز بضعة مستويات؛ استعلام لكل مستوى
    while (frontier.length > 0) {
      const rows: number[] = await this.db('employees').whereIn('direct_manager_id', frontier).whereNull('deleted_at').pluck('id');
      frontier = rows.map(Number).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
      result.push(...frontier);
    }

    return result;
  }

  async idsByBranchIds(branchIds: number[]): Promise<number[]> {
    if (branchIds.length === 0) return [];
    const rows = await this.db('employees').whereIn('branch_id', branchIds).whereNull('deleted_at').pluck('id');
    return rows.map(Number);
  }

  async idsByDepartment(departmentId: number): Promise<number[]> {
    const rows = await this.db('employees').where('department_id', departmentId).whereNull('deleted_at').pluck('id');
    return rows.map(Number);
  }

  async branchIdsOf(employeeIds: number[]): Promise<number[]> {
    if (employeeIds.length === 0) return [];
    const rows = await this.db('employees').whereIn('id', employeeIds).whereNotNull('branch_id').distinct('branch_id').pluck('branch_id');
    return rows.map(Number);
  }
}
