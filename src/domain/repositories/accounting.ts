import {
  AccountingPeriodRow,
  AccountRow,
  ChequeBookRow,
  ChequeRow,
  CostCenterRow,
  ExpenseRow,
  FiscalYearRow,
  IncomeRow,
  JournalRow,
  ListQuery,
  OverviewFigures,
  Paginated,
  RecordScope,
  TreasuryRow,
} from '../entities/accounting';

export type ListResult<T> = Paginated<T> & {
  /** إجماليات تخصّ القائمة المعروضة (كإجمالي المبالغ في الفترة) */
  totals?: Record<string, number>;
};

export interface FiscalRepository {
  yearContaining(date: string): Promise<FiscalYearRow | null>;
  markedCurrentYear(): Promise<FiscalYearRow | null>;
  yearById(id: number): Promise<FiscalYearRow | null>;
  periodById(id: number): Promise<AccountingPeriodRow | null>;
  periodIdsOfYear(yearId: number): Promise<number[]>;
  options(): Promise<{ years: FiscalYearRow[]; periods: AccountingPeriodRow[] }>;
}

export interface ExpenseQuery extends ListQuery {
  /** active = غير المعكوس (الافتراضي) */
  state?: 'active' | 'reversed' | 'all';
}

export interface IncomeQuery extends ListQuery {
  state?: 'active' | 'cancelled' | 'all';
  /** عملاءٌ مسنَدون للمستخدم (`account.incomes.view_assigned_clients`): سنداتهم تُضاف إلى قيد المنشئ */
  assignedClientIds?: number[];
}

export interface TreasuryQuery extends ListQuery {
  kind?: 'cash' | 'bank';
  active?: boolean;
  /** خزائن الموظف المسموحة؛ null = كل الخزائن والحسابات البنكية */
  treasuryIds: number[] | null;
}

export interface JournalQuery extends ListQuery {
  status?: 0 | 1;
}

export interface AccountQuery extends ListQuery {
  /** account_type: assets | liabilities | equity | revenues | expenses */
  type?: string;
  /** تصفّح الشجرة: أبناء هذا الحساب؛ غيابه = الجذور (إلا عند البحث فيُبحث في الشجرة كلها) */
  parentId?: number;
}

export interface ChequeQuery extends ListQuery {
  status?: string;
}

export interface AccountingRepository {
  expenses(scope: RecordScope, query: ExpenseQuery): Promise<ListResult<ExpenseRow>>;
  incomes(scope: RecordScope, query: IncomeQuery): Promise<ListResult<IncomeRow>>;
  treasuries(query: TreasuryQuery): Promise<ListResult<TreasuryRow>>;
  journalEntries(scope: RecordScope, query: JournalQuery): Promise<ListResult<JournalRow>>;
  chartAccounts(query: AccountQuery): Promise<ListResult<AccountRow>>;
  costCenters(query: ListQuery): Promise<ListResult<CostCenterRow>>;
  payableCheques(scope: RecordScope, query: ChequeQuery): Promise<ListResult<ChequeRow>>;
  receivedCheques(scope: RecordScope, query: ChequeQuery): Promise<ListResult<ChequeRow>>;
  chequeBooks(scope: RecordScope, query: ListQuery): Promise<ListResult<ChequeBookRow>>;
  /** `treasury_employees`: خزائن هؤلاء الموظفين */
  treasuryIdsForEmployees(employeeIds: number[]): Promise<number[]>;
  /** العملاء المسنَدون لموظفٍ في `client_employee` (`employees.id`) */
  assignedClientIds(employeeId: number): Promise<number[]>;
  overview(input: {
    scope: RecordScope;
    /** نطاق القيود (`created_by_employee`) */
    entryScope: RecordScope;
    treasuryIds: number[] | null;
    want: { expenses: boolean; incomes: boolean; entries: boolean; treasuries: boolean };
  }): Promise<OverviewFigures>;
}
