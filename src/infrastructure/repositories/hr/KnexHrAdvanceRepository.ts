import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import {
  AdvanceFilters,
  AdvanceInstallment,
  AdvanceRepository,
  AdvanceRequestInsert,
  AdvanceRequestRecord,
  JournalRef,
  LegacyAdvanceRecord,
} from '../../../domain/repositories/hr';
import { conn } from '../../db/KnexUnitOfWork';
import { day, EMPLOYEE_NAME_COLUMNS, flag, likeTerm, nullableNum, num, rowEmployeeName, stamp, str, whereEmployeeName } from './KnexHrRepository';

const REQUEST_COLUMNS = [
  'r.*',
  ...EMPLOYEE_NAME_COLUMNS,
  't.name as treasury_name',
  'ab.name as approved_by_name',
  'ap.name as approver_name',
  'dbu.name as disbursed_by_name',
];

const LEGACY_COLUMNS = ['a.*', ...EMPLOYEE_NAME_COLUMNS, 't.name as treasury_name'];

function mapRequest(r: Record<string, unknown>): AdvanceRequestRecord {
  return {
    id: Number(r.id),
    employeeId: nullableNum(r.employee_id),
    employeeName: rowEmployeeName(r),
    amount: num(r.amount),
    advanceType: str(r.advance_type) ?? 'normal',
    installmentsCount: num(r.installments_count),
    installmentAmount: num(r.installment_amount),
    startMonth: str(r.start_month),
    paidInstallments: num(r.paid_installments),
    remainingInstallments: num(r.remaining_installments),
    reason: str(r.reason),
    status: str(r.status),
    requestedDate: day(r.requested_date),
    approvedDate: stamp(r.approved_date),
    approvedByName: str(r.approved_by_name),
    approverUserId: nullableNum(r.approver_user_id),
    approverName: str(r.approver_name),
    treasuryId: nullableNum(r.treasury_id),
    treasuryName: str(r.treasury_name),
    rejectionReason: str(r.rejection_reason),
    adminNotes: str(r.admin_notes),
    isSettled: flag(r.is_settled),
    settledAmount: nullableNum(r.settled_amount),
    disbursedAt: stamp(r.disbursed_at),
    disbursedByName: str(r.disbursed_by_name),
    cancelledAt: stamp(r.cancelled_at),
    cancellationReason: str(r.cancellation_reason),
    disbursementJournalId: nullableNum(r.disbursement_journal_id),
    cancellationJournalId: nullableNum(r.cancellation_journal_id),
    sortDate: day(r.requested_date) ?? stamp(r.created_at),
  };
}

function mapLegacy(r: Record<string, unknown>): LegacyAdvanceRecord {
  return {
    id: Number(r.id),
    employeeId: nullableNum(r.employee_id),
    employeeName: rowEmployeeName(r),
    amount: num(r.amount),
    currency: nullableNum(r.currency),
    installmentAmount: num(r.installment_amount),
    totalInstallments: num(r.total_installments),
    paidCount: num(r.paid_count),
    paidAmount: num(r.paid_amount),
    installmentStartDate: day(r.installment_start_date),
    submissionDate: day(r.submission_date),
    treasuryId: nullableNum(r.treasury_id),
    treasuryName: str(r.treasury_name),
    note: str(r.note),
    status: str(r.status),
    cancelledAt: stamp(r.cancelled_at),
    cancellationReason: str(r.cancellation_reason),
    cancellationJournalId: nullableNum(r.cancellation_journal_id),
    sortDate: day(r.submission_date) ?? stamp(r.created_at),
  };
}

/**
 * السلفُ — النظامان معاً: `salary_advance_requests` (الطلبات) و`salary_advances`
 * (القديمة بأقساطها في `installment_payments`). الصفوفُ تُقرأ كاملةً بفلاترها
 * ثمّ تُدمج وتُقطَّع في طبقة التطبيق، كما تفعل `unifiedRows()` في الويب — فمرحلةُ
 * السلفة محسوبةٌ من ثلاثة أعمدة، ولا يُقطَّع ما لم يُحسب.
 */
export class KnexHrAdvanceRepository implements AdvanceRepository {
  constructor(private readonly db: Knex) {}

  private requestQuery(f: AdvanceFilters) {
    const q = this.db('salary_advance_requests as r')
      .leftJoin('employees as e', 'e.id', 'r.employee_id')
      .leftJoin('accounts as t', 't.id', 'r.treasury_id')
      .leftJoin('users as ab', 'ab.id', 'r.approved_by')
      .leftJoin('users as ap', 'ap.id', 'r.approver_user_id')
      .leftJoin('users as dbu', 'dbu.id', 'r.disbursed_by');

    if (f.employeeIds !== null) q.whereIn('r.employee_id', f.employeeIds.length ? f.employeeIds : [0]);
    if (f.from) q.where('r.requested_date', '>=', f.from);
    if (f.to) q.where('r.requested_date', '<=', f.to);
    if (f.search) {
      const term = f.search;
      q.where((w) => {
        whereEmployeeName(w, 'e', term);
        w.orWhere('r.amount', 'like', likeTerm(term));
      });
    }

    return q;
  }

  async requests(f: AdvanceFilters): Promise<AdvanceRequestRecord[]> {
    const rows = await this.requestQuery(f).orderBy('r.id', 'desc').select(...REQUEST_COLUMNS);
    return rows.map(mapRequest);
  }

  async legacy(f: AdvanceFilters): Promise<LegacyAdvanceRecord[]> {
    const q = this.db('salary_advances as a').leftJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('accounts as t', 't.id', 'a.treasury_id');

    if (f.employeeIds !== null) q.whereIn('a.employee_id', f.employeeIds.length ? f.employeeIds : [0]);
    if (f.from) q.where('a.submission_date', '>=', f.from);
    if (f.to) q.where('a.submission_date', '<=', f.to);
    if (f.search) {
      const term = f.search;
      q.where((w) => {
        whereEmployeeName(w, 'e', term);
        w.orWhere('a.amount', 'like', likeTerm(term));
      });
    }

    const rows = await q.orderBy('a.id', 'desc').select(...LEGACY_COLUMNS, ...this.paidAggregates());
    return rows.map(mapLegacy);
  }

  /** الأقساطُ المسدَّدة عدداً ومبلغاً — `payments->where('status','paid')` */
  private paidAggregates() {
    return [
      this.db.raw("(select count(*) from installment_payments ip where ip.salary_advance_id = a.id and ip.status = 'paid') as paid_count"),
      this.db.raw("(select coalesce(sum(ip.amount), 0) from installment_payments ip where ip.salary_advance_id = a.id and ip.status = 'paid') as paid_amount"),
    ];
  }

  async findRequest(id: number): Promise<AdvanceRequestRecord | null> {
    const r = await this.db('salary_advance_requests as r')
      .leftJoin('employees as e', 'e.id', 'r.employee_id')
      .leftJoin('accounts as t', 't.id', 'r.treasury_id')
      .leftJoin('users as ab', 'ab.id', 'r.approved_by')
      .leftJoin('users as ap', 'ap.id', 'r.approver_user_id')
      .leftJoin('users as dbu', 'dbu.id', 'r.disbursed_by')
      .where('r.id', id)
      .first(...REQUEST_COLUMNS);

    return r ? mapRequest(r as Record<string, unknown>) : null;
  }

  async findLegacy(id: number): Promise<LegacyAdvanceRecord | null> {
    const r = await this.db('salary_advances as a')
      .leftJoin('employees as e', 'e.id', 'a.employee_id')
      .leftJoin('accounts as t', 't.id', 'a.treasury_id')
      .where('a.id', id)
      .first(...LEGACY_COLUMNS, ...this.paidAggregates());

    return r ? mapLegacy(r as Record<string, unknown>) : null;
  }

  /**
   * أقساطُ الطلب: لا جدولَ أقساطٍ له (`installment_payments` تخصّ النظام القديم)،
   * فسدادُه يُقرأ من بنود مسيرات الرواتب التي اقتطعته.
   */
  async requestInstallments(id: number): Promise<AdvanceInstallment[]> {
    const rows = await this.db('payroll_run_items as i')
      .join('payroll_runs as pr', 'pr.id', 'i.payroll_run_id')
      .where('i.source_table', 'salary_advance_requests')
      .where('i.source_id', id)
      .orderBy('pr.period_from')
      .orderBy('i.id')
      .select('i.id', 'i.amount', 'pr.scheduled_date', 'pr.disbursed_at', 'pr.status');

    return rows.map((r: Record<string, unknown>, index: number) => ({
      id: Number(r.id),
      number: index + 1,
      amount: num(r.amount),
      dueDate: day(r.scheduled_date),
      paymentDate: stamp(r.disbursed_at),
      status: r.status === 'disbursed' ? 'paid' : r.status === 'cancelled' ? 'cancelled' : 'unpaid',
    }));
  }

  async legacyInstallments(id: number): Promise<AdvanceInstallment[]> {
    const rows = await this.db('installment_payments')
      .where('salary_advance_id', id)
      .orderBy('installment_number')
      .orderBy('id')
      .select('id', 'installment_number', 'amount', 'due_date', 'payment_date', 'status');

    return rows.map((r: Record<string, unknown>, index: number) => ({
      id: Number(r.id),
      number: num(r.installment_number) || index + 1,
      amount: num(r.amount),
      dueDate: day(r.due_date),
      paymentDate: day(r.payment_date),
      status: str(r.status),
    }));
  }

  /**
   * قيودُ السلفة: المعرّفاتُ المحفوظة على الصفّ (الصرف والعكس) ومعها ما يُلتقط
   * بمرجعه — التحصيلُ يكتب `ADV-SETTLE-{id}-{وقت}` ولا عمودَ له.
   */
  async journals(id: number, opts: { ids: Array<number | null>; prefixes: string[] }): Promise<JournalRef[]> {
    const ids = opts.ids.filter((v): v is number => Boolean(v));

    const rows = await this.db('journal_entries')
      .where((w: Knex.QueryBuilder) => {
        if (ids.length) w.orWhereIn('id', ids);
        for (const prefix of opts.prefixes) {
          w.orWhere('reference_number', `${prefix}${id}`).orWhere('reference_number', 'like', `${prefix}${id}-%`);
        }
      })
      .orderBy('id')
      .select('id', 'reference_number', 'date');

    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), referenceNumber: str(r.reference_number), date: day(r.date) }));
  }

  async counts(employeeIds: number[] | null): Promise<{ pending: number; active: number }> {
    const base = () => {
      const q = this.db('salary_advance_requests');
      if (employeeIds !== null) q.whereIn('employee_id', employeeIds.length ? employeeIds : [0]);
      return q;
    };

    const [pending, active] = await Promise.all([
      base().where('status', 'pending').count<{ c: number }[]>({ c: 'id' }).first(),
      base().where('status', 'approved').where('is_settled', false).count<{ c: number }[]>({ c: 'id' }).first(),
    ]);

    return { pending: num((pending as { c?: number } | undefined)?.c), active: num((active as { c?: number } | undefined)?.c) };
  }

  async insertRequest(row: AdvanceRequestInsert, now: string, tx: Tx): Promise<number> {
    const [id] = await conn(this.db, tx)('salary_advance_requests').insert({
      employee_id: row.employeeId,
      amount: row.amount,
      reason: row.reason,
      requested_date: row.requestedDate,
      status: 'pending',
      approver_user_id: row.approverUserId,
      created_at: now,
      updated_at: now,
    });

    return Number(id);
  }

  async log(typeId: number, description: string, userId: number, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('logs').insert({
      type: 'salary_advance_request_log',
      type_id: typeId,
      type_log: 'log',
      description,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
  }

  async notify(row: { userId: number; receiverId: number; title: string; description: string; type: string }, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('notifications').insert({
      user_id: row.userId,
      receiver_id: row.receiverId,
      title: row.title,
      description: row.description,
      type: row.type,
      read: 0,
      is_scheduled: 0,
      is_sent: 1,
      created_at: now,
      updated_at: now,
    });
  }

  async cancelRequest(id: number, row: { reason: string; userId: number }, now: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('salary_advance_requests').where('id', id).update({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: row.userId,
      cancellation_reason: row.reason,
      updated_at: now,
    });
  }

  /** «#12» في آخر الوصف — `%#1%` كان يطابق #10 و#11 أيضاً */
  async markRequestNotificationsRead(id: number, type: string, tx: Tx): Promise<void> {
    await conn(this.db, tx)('notifications').where('type', type).where('description', 'like', `%#${id}`).where('read', 0).update({ read: 1 });
  }
}
