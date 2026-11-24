/** أنواع وحدة الحسابات — صفوف القوائم كما تُعرض في التطبيق (أرقام لا نصوص عشرية) */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export interface ExpenseRow {
  id: number;
  code: string | null;
  date: string;
  amount: number;
  totalAmount: number;
  description: string | null;
  category: string | null;
  seller: string | null;
  currency: string | null;
  reversed: boolean;
}

export interface IncomeRow {
  id: number;
  code: string | null;
  date: string;
  amount: number;
  totalAmount: number;
  description: string | null;
  seller: string | null;
  currency: string | null;
  cancelled: boolean;
}

export interface TreasuryRow {
  id: number;
  code: string | null;
  name: string;
  kind: 'cash' | 'bank';
  balance: number;
  active: boolean;
  currency: string | null;
}

export interface JournalRow {
  id: number;
  reference: string | null;
  date: string;
  description: string | null;
  /** 0 معلّق، 1 معتمد — كما في الويب */
  status: number;
  posted: boolean;
  reversed: boolean;
  totalDebit: number;
  totalCredit: number;
  currency: string | null;
}

/** حساب في شجرة الحسابات (جدول `accounts` كما في الويب) */
export interface AccountRow {
  id: number;
  code: string | null;
  name: string;
  /** assets | liabilities | equity | revenues | expenses */
  accountType: string | null;
  balance: number;
  /** debit | credit */
  balanceType: string | null;
  parentId: number | null;
  hasChildren: boolean;
  active: boolean;
}

export interface CostCenterRow {
  id: number;
  code: string | null;
  name: string;
  isMain: boolean;
  parentId: number | null;
  active: boolean;
}

export interface ChequeRow {
  id: number;
  number: string | null;
  amount: number;
  issueDate: string | null;
  dueDate: string | null;
  status: string | null;
  party: string | null;
  currency: string | null;
}

export interface ChequeBookRow {
  id: number;
  number: string | null;
  startSerial: number | null;
  endSerial: number | null;
  status: number;
  currency: string | null;
  notes: string | null;
}

export interface FiscalYearRow {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export interface AccountingPeriodRow {
  id: number;
  fiscalYearId: number;
  name: string;
  startDate: string;
  endDate: string;
}

/** ما يُقيَّد به كل استعلام قائمة: الفرع + المنشئ + الفترة — كما تفعل شاشات الويب */
export interface RecordScope {
  /** فرع الشريط وأبناؤه (والصفوف بلا فرع)؛ null = بلا قيد مكان */
  branchIds: number[] | null;
  /** معرّفات المنشئين المسموحة؛ null = بلا قيد */
  creatorIds: number[] | null;
  /** معرّفات الفترات المحاسبية؛ null = بلا قيد فترة */
  periodIds: number[] | null;
}

export interface ListQuery {
  page: number;
  perPage: number;
  search?: string;
}

export interface OverviewFigures {
  expensesTotal: number | null;
  incomesTotal: number | null;
  entriesPending: number | null;
  entriesApproved: number | null;
  treasuriesBalance: number | null;
  treasuriesCount: number | null;
}
