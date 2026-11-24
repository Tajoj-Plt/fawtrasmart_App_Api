import { Knex } from 'knex';
import {
  AccountRow,
  ChequeBookRow,
  ChequeRow,
  CostCenterRow,
  ExpenseRow,
  IncomeRow,
  JournalRow,
  ListQuery,
  OverviewFigures,
  RecordScope,
  TreasuryRow,
} from '../../domain/entities/accounting';
import {
  AccountingRepository,
  AccountQuery,
  ChequeQuery,
  ExpenseQuery,
  IncomeQuery,
  JournalQuery,
  ListResult,
  TreasuryQuery,
} from '../../domain/repositories/accounting';
import { bool } from '../db/knex';

const CASH_TREASURIES_PARENT = 13; // SystemAccountIds::CASH_TREASURIES_PARENT
const BANK_ACCOUNTS_PARENT = 15; // SystemAccountIds::BANK_ACCOUNTS_PARENT

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const day = (v: unknown): string => (v ? String(v).slice(0, 10) : '');

interface ScopeColumns {
  branch?: string;
  creator?: string;
  period?: string;
}

/** يطبّق الفرع + المنشئ + الفترة كما تفعل `forBranch` و`scopeToCreator` و`AccountingPeriodFilter::apply` */
function applyScope(qb: Knex.QueryBuilder, scope: RecordScope, cols: ScopeColumns): Knex.QueryBuilder {
  if (cols.branch && scope.branchIds) {
    const ids = scope.branchIds;
    qb.where((q) => q.whereIn(cols.branch as string, ids.length ? ids : [0]).orWhereNull(cols.branch as string));
  }

  if (cols.creator && scope.creatorIds) {
    qb.whereIn(cols.creator, scope.creatorIds.length ? scope.creatorIds : [0]);
  }

  if (cols.period && scope.periodIds) {
    if (scope.periodIds.length === 0) qb.whereNull(cols.period);
    else qb.whereIn(cols.period, scope.periodIds);
  }

  return qb;
}

function like(term: string) {
  return `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export class KnexAccountingRepository implements AccountingRepository {
  constructor(private readonly db: Knex) {}

  private async paginate<T>(base: Knex.QueryBuilder, q: ListQuery, map: (row: Record<string, unknown>) => T, order: (qb: Knex.QueryBuilder) => Knex.QueryBuilder): Promise<ListResult<T>> {
    const countRow = await base.clone().clearSelect().clearOrder().count<{ c: number | string }[]>({ c: '*' }).first();
    const total = num((countRow as { c?: number | string } | undefined)?.c);

    const rows = await order(base.clone()).limit(q.perPage).offset((q.page - 1) * q.perPage);

    return { items: rows.map(map), total, page: q.page, perPage: q.perPage };
  }

  /* ───────────── سندات الصرف ───────────── */

  async expenses(scope: RecordScope, query: ExpenseQuery): Promise<ListResult<ExpenseRow>> {
    const base = this.db('expenses as e').leftJoin('expenses_categories as c', 'c.id', 'e.expenses_category_id').select('e.*', 'c.name as category_name');
    applyScope(base, scope, { branch: 'e.branch_id', creator: 'e.created_by', period: 'e.accounting_period_id' });

    const state = query.state ?? 'active';
    if (state === 'active') base.whereNull('e.reversed_at');
    if (state === 'reversed') base.whereNotNull('e.reversed_at');

    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('e.code', 'like', t).orWhere('e.description', 'like', t).orWhere('e.seller', 'like', t).orWhere('c.name', 'like', t));
    }

    const result = await this.paginate<ExpenseRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        code: str(r.code),
        date: day(r.date),
        amount: num(r.amount),
        totalAmount: num(r.total_amount) || num(r.amount),
        description: str(r.description),
        category: str(r.category_name),
        seller: str(r.seller),
        currency: str(r.currency),
        reversed: r.reversed_at !== null && r.reversed_at !== undefined,
      }),
      (qb) => qb.orderBy('e.id', 'desc'),
    );

    // إجمالي الفترة على غير المعكوس (كما في الويب) — بعيداً عن البحث
    const sumQ = this.db('expenses as e').whereNull('e.reversed_at');
    applyScope(sumQ, scope, { branch: 'e.branch_id', creator: 'e.created_by', period: 'e.accounting_period_id' });
    const sum = await sumQ.sum<{ s: number | string | null }[]>({ s: this.db.raw('coalesce(e.total_amount, e.amount)') }).first();
    result.totals = { period: num((sum as { s?: unknown } | undefined)?.s) };

    return result;
  }

  /* ───────────── سندات القبض ───────────── */

  /**
   * قيد المنشئ لسندات القبض، موسَّعاً بسندات العملاء المسنَدين متى مُنحت `account.incomes.view_assigned_clients`:
   * سندٌ بعميله (`client_id`) أو بحسابه (`account_id`) — كما تجمع قائمة مستندات العميل سنداتِه.
   */
  private incomeCreatorScope(qb: Knex.QueryBuilder, scope: RecordScope, assigned: number[] | undefined) {
    if (!scope.creatorIds || !assigned?.length) {
      applyScope(qb, scope, { branch: 'r.branch_id', creator: 'r.created_by' });
      return;
    }
    const creators = scope.creatorIds.length ? scope.creatorIds : [0];
    // سنداتُه وفريقه بفرعه، أو سندُ عميلٍ مسنَدٍ إليه من أيّ فرعٍ قُبض فيه
    qb.where((w) =>
      w
        .where((own) => applyScope(own.whereIn('r.created_by', creators), { ...scope, creatorIds: null, periodIds: null }, { branch: 'r.branch_id' }))
        .orWhereIn('r.client_id', assigned)
        .orWhereIn('r.account_id', this.db('accounts').whereIn('client_id', assigned).select('id')),
    );
  }

  async assignedClientIds(employeeId: number): Promise<number[]> {
    return (await this.db('client_employee').where('employee_id', employeeId).distinct().pluck('client_id')).map(Number);
  }

  async incomes(scope: RecordScope, query: IncomeQuery): Promise<ListResult<IncomeRow>> {
    const base = this.db('receipts as r').select('r.*');
    applyScope(base, scope, { period: 'r.accounting_period_id' });
    this.incomeCreatorScope(base, scope, query.assignedClientIds);

    const state = query.state ?? 'active';
    if (state === 'active') base.whereNull('r.cancelled_at');
    if (state === 'cancelled') base.whereNotNull('r.cancelled_at');

    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('r.code', 'like', t).orWhere('r.description', 'like', t).orWhere('r.seller', 'like', t));
    }

    const result = await this.paginate<IncomeRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        code: str(r.code),
        date: day(r.date),
        amount: num(r.amount),
        totalAmount: num(r.total_amount) || num(r.amount),
        description: str(r.description),
        seller: str(r.seller),
        currency: str(r.currency),
        cancelled: r.cancelled_at !== null && r.cancelled_at !== undefined,
      }),
      (qb) => qb.orderBy('r.id', 'desc'),
    );

    const sumQ = this.db('receipts as r').whereNull('r.cancelled_at');
    applyScope(sumQ, scope, { period: 'r.accounting_period_id' });
    this.incomeCreatorScope(sumQ, scope, query.assignedClientIds);
    const sum = await sumQ.sum<{ s: number | string | null }[]>({ s: this.db.raw('coalesce(r.total_amount, r.amount)') }).first();
    result.totals = { period: num((sum as { s?: unknown } | undefined)?.s) };

    return result;
  }

  /* ───────────── الخزائن والحسابات البنكية ───────────── */

  private async treasuryParents(): Promise<{ cash: number; bank: number }> {
    try {
      const rows = await this.db('accounting_settings').whereIn('key', ['cash_treasuries_parent', 'bank_accounts_parent']).whereNotNull('account_id').select('key', 'account_id');
      const map = new Map(rows.map((r) => [String(r.key), Number(r.account_id)]));
      return { cash: map.get('cash_treasuries_parent') ?? CASH_TREASURIES_PARENT, bank: map.get('bank_accounts_parent') ?? BANK_ACCOUNTS_PARENT };
    } catch {
      return { cash: CASH_TREASURIES_PARENT, bank: BANK_ACCOUNTS_PARENT };
    }
  }

  private async treasuryBase(treasuryIds: number[] | null) {
    const parents = await this.treasuryParents();
    const base = this.db('accounts as a').leftJoin('treasuries as t', 't.account_id', 'a.id').select('a.*', 't.currency as t_currency');

    // الموظف المقيَّد يرى خزائنه وحدها؛ وغيره الخزائن والحسابات البنكية كلها
    if (treasuryIds !== null) base.whereIn('a.id', treasuryIds.length ? treasuryIds : [0]);
    else base.whereIn('a.parent_id', [parents.cash, parents.bank]);

    return { base, parents };
  }

  async treasuries(query: TreasuryQuery): Promise<ListResult<TreasuryRow>> {
    const { base, parents } = await this.treasuryBase(query.treasuryIds);

    if (query.kind === 'bank') base.where('a.parent_id', parents.bank);
    if (query.kind === 'cash') base.where((w) => w.whereNot('a.parent_id', parents.bank).orWhereNull('a.parent_id'));
    if (query.active !== undefined) base.where('a.is_active', query.active ? 1 : 0);
    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('a.name', 'like', t).orWhere('a.code', 'like', t));
    }

    const result = await this.paginate<TreasuryRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        code: str(r.code),
        name: String(r.name ?? ''),
        kind: Number(r.parent_id) === parents.bank ? 'bank' : 'cash',
        balance: num(r.balance),
        active: bool(r.is_active),
        currency: str(r.t_currency),
      }),
      (qb) => qb.orderBy('a.id', 'desc'),
    );

    const totalQ = (await this.treasuryBase(query.treasuryIds)).base.clearSelect();
    const sum = await totalQ.sum<{ s: number | string | null }[]>({ s: 'a.balance' }).first();
    result.totals = { balance: num((sum as { s?: unknown } | undefined)?.s) };

    return result;
  }

  async treasuryIdsForEmployees(employeeIds: number[]): Promise<number[]> {
    if (employeeIds.length === 0) return [];
    const rows = await this.db('treasury_employees').whereIn('employee_id', employeeIds).distinct('treasury_id').pluck('treasury_id');
    return rows.map(Number);
  }

  /* ───────────── قيود اليومية ───────────── */

  async journalEntries(scope: RecordScope, query: JournalQuery): Promise<ListResult<JournalRow>> {
    const totals = this.db('journal_entry_details').select('journal_entry_id').sum({ d: 'debit' }).sum({ c: 'credit' }).groupBy('journal_entry_id').as('t');

    const base = this.db('journal_entries as j')
      .leftJoin(totals, 't.journal_entry_id', 'j.id')
      .select('j.*', this.db.raw('t.d as total_debit'), this.db.raw('t.c as total_credit'));
    applyScope(base, scope, { branch: 'j.branch_id', creator: 'j.created_by_employee', period: 'j.accounting_period_id' });

    if (query.status !== undefined) base.where('j.status', query.status);
    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('j.reference_number', 'like', t).orWhere('j.description', 'like', t));
    }

    return this.paginate<JournalRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        reference: str(r.reference_number),
        date: day(r.date),
        description: str(r.description),
        status: num(r.status),
        posted: bool(r.is_posted),
        reversed: bool(r.is_reversed),
        totalDebit: num(r.total_debit),
        totalCredit: num(r.total_credit),
        currency: str(r.currency),
      }),
      (qb) => qb.orderBy('j.id', 'desc'),
    );
  }

  /* ───────────── شجرة الحسابات ومراكز التكلفة ───────────── */

  /** شجرة الحسابات: جدول `accounts` (وليس `chart_of_accounts` القديم) كما تعرضها شاشة الويب */
  async chartAccounts(query: AccountQuery): Promise<ListResult<AccountRow>> {
    const hasChildren = this.db('accounts as c').select(this.db.raw('1')).whereRaw('c.parent_id = a.id').limit(1);
    const base = this.db('accounts as a').select('a.*', this.db.raw('exists (?) as has_children', [hasChildren]));

    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('a.name', 'like', t).orWhere('a.code', 'like', t));
    } else if (query.parentId) {
      base.where('a.parent_id', query.parentId);
    } else {
      base.whereNull('a.parent_id');
    }
    if (query.type) base.where('a.account_type', query.type);

    return this.paginate<AccountRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        code: str(r.code),
        name: String(r.name ?? ''),
        accountType: str(r.account_type),
        balance: num(r.balance),
        balanceType: str(r.balance_type),
        parentId: r.parent_id === null || r.parent_id === undefined ? null : num(r.parent_id),
        hasChildren: bool(r.has_children),
        active: r.is_active === null || r.is_active === undefined ? true : bool(r.is_active),
      }),
      (qb) => qb.orderByRaw(this.db.client.config.client === 'mysql2' ? 'CAST(a.code AS UNSIGNED), a.code' : 'CAST(a.code AS INTEGER), a.code'),
    );
  }

  async costCenters(query: ListQuery): Promise<ListResult<CostCenterRow>> {
    const base = this.db('cost_centers as c').select('c.*');
    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('c.name', 'like', t).orWhere('c.code', 'like', t));
    }

    return this.paginate<CostCenterRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        code: str(r.code),
        name: String(r.name ?? ''),
        isMain: bool(r.is_main),
        parentId: r.parent_id === null || r.parent_id === undefined ? null : num(r.parent_id),
        active: bool(r.is_active),
      }),
      (qb) => qb.orderBy('c.code').orderBy('c.id'),
    );
  }

  /* ───────────── الشيكات ───────────── */

  async payableCheques(scope: RecordScope, query: ChequeQuery): Promise<ListResult<ChequeRow>> {
    const base = this.db('payable_cheques as p').leftJoin('accounts as a', 'a.id', 'p.recipient_account_id').select('p.*', 'a.name as account_name');
    applyScope(base, scope, { branch: 'p.branch_id', creator: 'p.created_by', period: 'p.accounting_period_id' });
    if (query.status) base.where('p.status', query.status);
    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('p.cheque_number', 'like', t).orWhere('p.payee_name', 'like', t).orWhere('a.name', 'like', t));
    }

    return this.paginate<ChequeRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        number: str(r.cheque_number),
        amount: num(r.amount),
        issueDate: r.issue_date ? day(r.issue_date) : null,
        dueDate: r.due_date ? day(r.due_date) : null,
        status: str(r.status),
        party: str(r.payee_name) ?? str(r.account_name),
        currency: str(r.currency),
      }),
      (qb) => qb.orderBy('p.id', 'desc'),
    );
  }

  async receivedCheques(scope: RecordScope, query: ChequeQuery): Promise<ListResult<ChequeRow>> {
    const base = this.db('received_cheques as r').leftJoin('accounts as a', 'a.id', 'r.recipient_account_id').select('r.*', 'a.name as account_name');
    applyScope(base, scope, { branch: 'r.branch_id', creator: 'r.created_by', period: 'r.accounting_period_id' });
    if (query.status) base.where('r.status', query.status);
    if (query.search) {
      const t = like(query.search);
      base.where((w) => w.where('r.cheque_number', 'like', t).orWhere('r.payee_name', 'like', t).orWhere('r.name', 'like', t).orWhere('a.name', 'like', t));
    }

    return this.paginate<ChequeRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        number: str(r.cheque_number),
        amount: num(r.amount),
        issueDate: r.issue_date ? day(r.issue_date) : null,
        dueDate: r.due_date ? day(r.due_date) : null,
        status: str(r.status),
        party: str(r.name) ?? str(r.payee_name) ?? str(r.account_name),
        currency: str(r.currency),
      }),
      (qb) => qb.orderBy('r.id', 'desc'),
    );
  }

  async chequeBooks(scope: RecordScope, query: ListQuery): Promise<ListResult<ChequeBookRow>> {
    const base = this.db('cheque_books as b').select('b.*');
    applyScope(base, scope, { branch: 'b.branch_id', creator: 'b.created_by', period: 'b.accounting_period_id' });
    if (query.search) base.where('b.cheque_book_number', 'like', like(query.search));

    return this.paginate<ChequeBookRow>(
      base,
      query,
      (r) => ({
        id: num(r.id),
        number: str(r.cheque_book_number),
        startSerial: r.start_serial_number === null || r.start_serial_number === undefined ? null : num(r.start_serial_number),
        endSerial: r.end_serial_number === null || r.end_serial_number === undefined ? null : num(r.end_serial_number),
        status: num(r.status),
        currency: str(r.currency),
        notes: str(r.notes),
      }),
      (qb) => qb.orderBy('b.id', 'desc'),
    );
  }

  /* ───────────── نظرة عامة ───────────── */

  async overview(input: Parameters<AccountingRepository['overview']>[0]): Promise<OverviewFigures> {
    const { scope, entryScope, treasuryIds, want } = input;

    const total = async (table: string, alias: string, cols: ScopeColumns, notNull: string, scopeToUse: RecordScope) => {
      const q = this.db(`${table} as ${alias}`).whereNull(`${alias}.${notNull}`);
      applyScope(q, scopeToUse, cols);
      const row = await q.sum<{ s: number | string | null }[]>({ s: this.db.raw(`coalesce(${alias}.total_amount, ${alias}.amount)`) }).first();
      return num((row as { s?: unknown } | undefined)?.s);
    };

    const entries = async (status: number) => {
      const q = this.db('journal_entries as j').where('j.status', status);
      applyScope(q, entryScope, { branch: 'j.branch_id', creator: 'j.created_by_employee', period: 'j.accounting_period_id' });
      const row = await q.count<{ c: number | string }[]>({ c: '*' }).first();
      return num((row as { c?: unknown } | undefined)?.c);
    };

    let treasuriesBalance: number | null = null;
    let treasuriesCount: number | null = null;
    if (want.treasuries) {
      const { base } = await this.treasuryBase(treasuryIds);
      const row = await base.clearSelect().sum<{ s: number | string | null }[]>({ s: 'a.balance' }).count({ c: '*' }).first();
      treasuriesBalance = num((row as { s?: unknown } | undefined)?.s);
      treasuriesCount = num((row as { c?: unknown } | undefined)?.c);
    }

    return {
      expensesTotal: want.expenses ? await total('expenses', 'e', { branch: 'e.branch_id', creator: 'e.created_by', period: 'e.accounting_period_id' }, 'reversed_at', scope) : null,
      incomesTotal: want.incomes ? await total('receipts', 'r', { branch: 'r.branch_id', creator: 'r.created_by', period: 'r.accounting_period_id' }, 'cancelled_at', scope) : null,
      entriesPending: want.entries ? await entries(0) : null,
      entriesApproved: want.entries ? await entries(1) : null,
      treasuriesBalance,
      treasuriesCount,
    };
  }
}
