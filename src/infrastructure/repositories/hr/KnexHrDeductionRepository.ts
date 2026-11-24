import { Knex } from 'knex';
import {
  DeductionFilters,
  DeductionHistoryRecord,
  DeductionRecord,
  DeductionRepository,
  DeductionStats,
  JournalRef,
} from '../../../domain/repositories/hr';
import { DEDUCTION_UNSETTLED_STATUSES } from '../../../domain/services/hr/HrConstants';
import { day, EMPLOYEE_NAME_COLUMNS, likeTerm, nullableNum, num, rowEmployeeName, stamp, str, whereEmployeeName } from './KnexHrRepository';

function map(r: Record<string, unknown>): DeductionRecord {
  return {
    id: Number(r.id),
    code: str(r.code),
    employeeId: nullableNum(r.employee_id),
    employeeName: rowEmployeeName(r),
    deductionType: str(r.deduction_type),
    amount: num(r.amount),
    settledAmount: num(r.settled_amount),
    status: str(r.status),
    date: day(r.date),
    reason: str(r.reason),
    notes: str(r.notes),
    approvedAt: stamp(r.approved_at),
    rejectedAt: stamp(r.rejected_at),
    rejectionReason: str(r.rejection_reason),
    cancelledAt: stamp(r.cancelled_at),
    cancellationReason: str(r.cancellation_reason),
    settledAt: stamp(r.settled_at),
    postedAmount: num(r.posted_amount),
  };
}

const COLUMNS = ['d.*', ...EMPLOYEE_NAME_COLUMNS];

/** خصمياتُ الموظفين — `deductions` وسجلُّ عملياتها `deduction_histories` */
export class KnexHrDeductionRepository implements DeductionRepository {
  constructor(private readonly db: Knex) {}

  /** النطاقُ وحده — إحصاءاتُ الشاشة في الويب تُحسب قبل الفلاتر */
  private scoped(employeeIds: number[] | null) {
    const q = this.db('deductions');
    if (employeeIds !== null) q.whereIn('employee_id', employeeIds.length ? employeeIds : [0]);
    return q;
  }

  private filtered(f: DeductionFilters) {
    const q = this.db('deductions as d').leftJoin('employees as e', 'e.id', 'd.employee_id');

    if (f.employeeIds !== null) q.whereIn('d.employee_id', f.employeeIds.length ? f.employeeIds : [0]);
    if (f.status) q.where('d.status', f.status);
    if (f.type) q.where('d.deduction_type', f.type);
    if (f.from) q.where('d.date', '>=', f.from);
    if (f.to) q.where('d.date', '<=', f.to);
    if (f.search) {
      const term = f.search;
      const like = likeTerm(term);
      q.where((w) => {
        whereEmployeeName(w, 'e', term);
        w.orWhere('d.code', 'like', like).orWhere('d.reason', 'like', like);
        if (/^\d+$/.test(term)) w.orWhere('d.id', Number(term));
      });
    }

    return q;
  }

  async page(f: DeductionFilters, page: number, perPage: number) {
    const base = this.filtered(f);

    const [countRow, totalsRow, rows] = await Promise.all([
      base.clone().count<{ c: number }[]>({ c: 'd.id' }).first(),
      base.clone().sum({ amount: 'd.amount' }).sum({ settled: 'd.settled_amount' }).first(),
      base.clone().orderBy('d.id', 'desc').limit(perPage).offset((page - 1) * perPage).select(...COLUMNS),
    ]);

    const amount = Math.round(num((totalsRow as Record<string, unknown> | undefined)?.amount) * 100) / 100;
    const settled = Math.round(num((totalsRow as Record<string, unknown> | undefined)?.settled) * 100) / 100;

    return {
      rows: rows.map(map),
      total: num((countRow as { c?: number } | undefined)?.c),
      totals: { amount, remaining: Math.max(0, Math.round((amount - settled) * 100) / 100) },
    };
  }

  async stats(f: DeductionFilters): Promise<DeductionStats> {
    const [pending, approved, settled, cancelled, unsettled] = await Promise.all([
      this.scoped(f.employeeIds).where('status', 'pending').count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(f.employeeIds).whereIn('status', DEDUCTION_UNSETTLED_STATUSES).count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(f.employeeIds).where('status', 'settled').count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(f.employeeIds).where('status', 'cancelled').count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(f.employeeIds).whereIn('status', DEDUCTION_UNSETTLED_STATUSES).sum({ amount: 'amount' }).sum({ settled: 'settled_amount' }).first(),
    ]);

    const count = (r: unknown) => num((r as { c?: number } | undefined)?.c);
    const row = unsettled as Record<string, unknown> | undefined;

    return {
      pending: count(pending),
      approved: count(approved),
      settled: count(settled),
      cancelled: count(cancelled),
      unsettledTotal: Math.max(0, Math.round((num(row?.amount) - num(row?.settled)) * 100) / 100),
    };
  }

  async find(id: number): Promise<DeductionRecord | null> {
    const r = await this.db('deductions as d').leftJoin('employees as e', 'e.id', 'd.employee_id').where('d.id', id).first(...COLUMNS);
    return r ? map(r as Record<string, unknown>) : null;
  }

  async history(id: number): Promise<DeductionHistoryRecord[]> {
    const rows = await this.db('deduction_histories as h')
      .leftJoin('users as u', 'u.id', 'h.user_id')
      .where('h.deduction_id', id)
      .orderBy('h.id', 'desc')
      .select('h.id', 'h.action', 'h.description', 'h.notes', 'h.amount', 'h.created_at', 'h.user_id', 'u.name as user_name');

    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      action: str(r.action),
      description: str(r.description),
      notes: str(r.notes),
      amount: nullableNum(r.amount),
      at: stamp(r.created_at),
      userId: nullableNum(r.user_id),
      userName: str(r.user_name),
    }));
  }

  async journals(id: number, prefixes: string[]): Promise<JournalRef[]> {
    const rows = await this.db('journal_entries')
      .where('reference_id', id)
      .where((w: Knex.QueryBuilder) => {
        for (const prefix of prefixes) {
          w.orWhere('reference_number', `${prefix}${id}`).orWhere('reference_number', 'like', `${prefix}${id}-%`);
        }
      })
      .orderBy('id')
      .select('id', 'reference_number', 'date');

    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), referenceNumber: str(r.reference_number), date: day(r.date) }));
  }

  async overview(employeeIds: number[] | null) {
    const [countRow, pendingRow, unsettled] = await Promise.all([
      this.scoped(employeeIds).count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(employeeIds).where('status', 'pending').count<{ c: number }[]>({ c: 'id' }).first(),
      this.scoped(employeeIds).whereIn('status', DEDUCTION_UNSETTLED_STATUSES).sum({ amount: 'amount' }).sum({ settled: 'settled_amount' }).first(),
    ]);

    const row = unsettled as Record<string, unknown> | undefined;

    return {
      count: num((countRow as { c?: number } | undefined)?.c),
      pending: num((pendingRow as { c?: number } | undefined)?.c),
      unsettledTotal: Math.max(0, Math.round((num(row?.amount) - num(row?.settled)) * 100) / 100),
    };
  }
}
