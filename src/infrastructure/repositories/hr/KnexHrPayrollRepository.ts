import { Knex } from 'knex';
import { PayrollRepository, RunFilters, RunItem, RunRecord, SlipComponent, SlipFilters, SlipRecord } from '../../../domain/repositories/hr';
import { PAYROLL_STATUS } from '../../../domain/services/hr/HrConstants';
import { day, EMPLOYEE_NAME_COLUMNS, flag, likeTerm, nullableNum, num, rowEmployeeName, stamp, str, whereEmployeeName } from './KnexHrRepository';

function mapSlip(r: Record<string, unknown>): SlipRecord {
  return {
    id: Number(r.id),
    code: str(r.code),
    employeeId: nullableNum(r.employee_id),
    employeeName: rowEmployeeName(r),
    basicAmount: num(r.basic_amount),
    currency: str(r.currency),
    frequency: str(r.frequency),
    scheduledPaymentDay: nullableNum(r.scheduled_payment_day),
    startDate: day(r.start_date),
    endDate: day(r.end_date),
    status: str(r.status),
    notes: str(r.notes),
    approvedAt: stamp(r.approved_at),
    stoppedAt: stamp(r.stopped_at),
    stopReason: str(r.stop_reason),
  };
}

function mapRun(r: Record<string, unknown>): RunRecord {
  return {
    id: Number(r.id),
    employeeId: nullableNum(r.employee_id),
    employeeName: rowEmployeeName(r),
    salarySlipId: nullableNum(r.salary_slip_id),
    currency: str(r.slip_currency),
    periodFrom: day(r.period_from),
    periodTo: day(r.period_to),
    scheduledDate: day(r.scheduled_date),
    basicAmount: num(r.basic_amount),
    totalAdditions: num(r.total_additions),
    totalDeductions: num(r.total_deductions),
    totalAdvancesDeducted: num(r.total_advances_deducted),
    netSalary: num(r.net_salary),
    status: str(r.status),
    heldAt: stamp(r.held_at),
    disbursedAt: stamp(r.disbursed_at),
    notes: str(r.notes),
    treasuryId: nullableNum(r.treasury_id),
    treasuryName: str(r.treasury_name),
    hasSlip: r.slip_id !== null && r.slip_id !== undefined,
    slipPayrollId: nullableNum(r.slip_payroll_id),
    payrollExists: r.payroll_id !== null && r.payroll_id !== undefined,
    payrollStatus: str(r.payroll_status),
  };
}

const SLIP_COLUMNS = ['s.*', ...EMPLOYEE_NAME_COLUMNS];

const RUN_COLUMNS = [
  'r.*',
  ...EMPLOYEE_NAME_COLUMNS,
  't.name as treasury_name',
  's.id as slip_id',
  's.currency as slip_currency',
  's.payroll_id as slip_payroll_id',
  'p.id as payroll_id',
  'p.status as payroll_status',
];

/**
 * اتفاقُ الراتب وصرفاتُه الشهرية — جدولان لا واحد:
 *   `salary_slips`  اتفاقُ راتبٍ مستمرّ (مبلغٌ أساسيٌّ وبنودٌ ودوريّة)، لا شهرٌ بعينه.
 *   `payroll_runs`  صرفةُ شهرٍ واحدةٍ مولَّدةٌ من ذلك الاتفاق، وفيها المبالغُ المصروفة.
 * فـ«قسيمة الراتب» في الويب هي الأولى، و«سجلّ الصرف» هو الثانية.
 */
export class KnexHrPayrollRepository implements PayrollRepository {
  constructor(private readonly db: Knex) {}

  private slipQuery(f: SlipFilters) {
    const q = this.db('salary_slips as s').leftJoin('employees as e', 'e.id', 's.employee_id');

    if (f.employeeIds !== null) q.whereIn('s.employee_id', f.employeeIds.length ? f.employeeIds : [0]);
    if (f.status) q.where('s.status', f.status);
    if (f.search) {
      const term = f.search;
      const like = likeTerm(term);
      q.where((w) => {
        whereEmployeeName(w, 'e', term);
        w.orWhere('e.employee_code', 'like', like).orWhere('s.code', 'like', like);
        if (/^\d+$/.test(term)) w.orWhere('s.id', Number(term));
      });
    }

    return q;
  }

  async slipPage(f: SlipFilters, page: number, perPage: number) {
    const base = this.slipQuery(f);
    const [countRow, rows] = await Promise.all([
      base.clone().count<{ c: number }[]>({ c: 's.id' }).first(),
      base.clone().orderBy('s.id', 'desc').limit(perPage).offset((page - 1) * perPage).select(...SLIP_COLUMNS),
    ]);

    return { rows: rows.map(mapSlip), total: num((countRow as { c?: number } | undefined)?.c) };
  }

  async findSlip(id: number): Promise<SlipRecord | null> {
    const r = await this.db('salary_slips as s').leftJoin('employees as e', 'e.id', 's.employee_id').where('s.id', id).first(...SLIP_COLUMNS);
    return r ? mapSlip(r as Record<string, unknown>) : null;
  }

  async slipComponents(slipIds: number[]): Promise<Map<number, SlipComponent[]>> {
    const map = new Map<number, SlipComponent[]>();
    if (slipIds.length === 0) return map;

    const rows = await this.db('salary_items')
      .whereIn('salary_slips_id', slipIds)
      .orderBy('id')
      .select('id', 'salary_slips_id', 'name', 'amount', 'type', 'is_insurable');

    for (const r of rows as Array<Record<string, unknown>>) {
      const slipId = Number(r.salary_slips_id);
      const list = map.get(slipId) ?? [];
      list.push({ id: Number(r.id), name: str(r.name), amount: num(r.amount), type: num(r.type), isInsurable: flag(r.is_insurable) });
      map.set(slipId, list);
    }

    return map;
  }

  private runQuery() {
    return this.db('payroll_runs as r')
      .leftJoin('employees as e', 'e.id', 'r.employee_id')
      .leftJoin('accounts as t', 't.id', 'r.treasury_id')
      .leftJoin('salary_slips as s', 's.id', 'r.salary_slip_id')
      .leftJoin('payrolls as p', 'p.id', 's.payroll_id');
  }

  /** `PayrollRun::scopePayrollApproved()` — قسيمةُ الصرفة ضمن مسيرٍ نشط (والفارغُ نشط) */
  private whereApprovedPayroll(q: Knex.QueryBuilder) {
    q.whereNotNull('s.id')
      .whereNotNull('s.payroll_id')
      .whereNotNull('p.id')
      .where((w) => w.where('p.status', PAYROLL_STATUS.active).orWhereNull('p.status'));
  }

  /** `PayrollRun::scopeStage()` — المرحلةُ مشتقّةٌ، فتُترجَم إلى شروط الأعمدة */
  private applyStage(q: Knex.QueryBuilder, stage: string, today: string, requiresApproval: boolean) {
    switch (stage) {
      case 'paid':
        q.where('r.status', 'disbursed');
        return;
      case 'cancelled':
        q.where('r.status', 'cancelled');
        return;
      case 'held':
        q.where('r.status', 'pending').whereNotNull('r.held_at');
        return;
      case 'awaiting_approval':
        q.where('r.status', 'pending').whereNull('r.held_at');
        // بلا اشتراط اعتمادٍ لا توجد هذه المرحلة أصلاً
        if (!requiresApproval) q.whereRaw('1 = 0');
        else q.where((w) => w.whereNull('s.id').orWhereNull('s.payroll_id').orWhereNull('p.id').orWhereIn('p.status', [PAYROLL_STATUS.draft, PAYROLL_STATUS.inactive]));
        return;
      case 'scheduled':
        q.where('r.status', 'pending').whereNull('r.held_at').where('r.scheduled_date', '>', today);
        if (requiresApproval) this.whereApprovedPayroll(q);
        return;
      case 'ready':
        q.where('r.status', 'pending').whereNull('r.held_at').where('r.scheduled_date', '<=', today);
        if (requiresApproval) this.whereApprovedPayroll(q);
        return;
      default:
    }
  }

  async runPage(f: RunFilters, page: number, perPage: number, today: string, requiresApproval: boolean) {
    const base = this.runQuery();

    if (f.employeeIds !== null) base.whereIn('r.employee_id', f.employeeIds.length ? f.employeeIds : [0]);
    if (f.from) base.where('r.period_from', '>=', f.from);
    if (f.to) base.where('r.period_to', '<=', f.to);
    if (f.stage) this.applyStage(base, f.stage, today, requiresApproval);
    if (f.search) {
      const term = f.search;
      const like = likeTerm(term);
      base.where((w) => {
        whereEmployeeName(w, 'e', term);
        w.orWhere('r.code', 'like', like);
        if (/^\d+$/.test(term)) w.orWhere('r.id', Number(term));
      });
    }

    const [countRow, rows] = await Promise.all([
      base.clone().count<{ c: number }[]>({ c: 'r.id' }).first(),
      base.clone().orderBy('r.id', 'desc').limit(perPage).offset((page - 1) * perPage).select(...RUN_COLUMNS),
    ]);

    return { rows: rows.map(mapRun), total: num((countRow as { c?: number } | undefined)?.c) };
  }

  async findRun(id: number): Promise<RunRecord | null> {
    const r = await this.runQuery().where('r.id', id).first(...RUN_COLUMNS);
    return r ? mapRun(r as Record<string, unknown>) : null;
  }

  async latestRunForEmployee(employeeId: number): Promise<RunRecord | null> {
    const r = await this.runQuery().where('r.employee_id', employeeId).orderBy('r.period_to', 'desc').orderBy('r.id', 'desc').first(...RUN_COLUMNS);
    return r ? mapRun(r as Record<string, unknown>) : null;
  }

  async runItems(runId: number): Promise<RunItem[]> {
    const rows = await this.db('payroll_run_items').where('payroll_run_id', runId).orderBy('id').select('id', 'item_type', 'name', 'amount', 'description', 'source_table', 'source_id');

    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      itemType: str(r.item_type),
      name: str(r.name),
      amount: num(r.amount),
      description: str(r.description),
      sourceTable: str(r.source_table),
      sourceId: nullableNum(r.source_id),
    }));
  }
}
