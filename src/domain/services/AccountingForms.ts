import { LocalizedText } from './ModuleCatalog';
import { AccountingSectionKey } from './AccountingCatalog';
import { Choice, compact, FormDef as GenericFormDef, num, today, validateDebitCreditLines } from './formsKit';

export type { Choice, FieldCondition, FieldErrors, FieldType, FormField, FormValues } from './formsKit';
export { validateForm } from './formsKit';

/**
 * نماذج الإنشاء في وحدة الحسابات — يصفها الخادم ويرسمها التطبيق بشاشة نموذج واحدة عامة (فوق
 * `formsKit.ts` العام لكل الوحدات). التحقق النهائي وكل القواعد المحاسبية (الترقيم، القيود، الأرصدة،
 * الفترات، حدود الباقة) في الويب نفسه (Laravel) الذي يُستدعى لتنفيذ الإنشاء؛ ما هنا وصفٌ للحقول
 * وتحقّقٌ مبدئي سريع يوفّر رحلة الشبكة.
 */

export type FormDef = GenericFormDef<AccountingSectionKey>;

const t = (ar: string, en: string): LocalizedText => ({ ar, en });

const ACCOUNT_TYPES: Choice[] = [
  { value: 'assets', label: t('أصول', 'Assets') },
  { value: 'liabilities', label: t('خصوم', 'Liabilities') },
  { value: 'equity', label: t('حقوق ملكية', 'Equity') },
  { value: 'revenues', label: t('إيرادات', 'Revenues') },
  { value: 'expenses', label: t('مصروفات', 'Expenses') },
];

const SCOPES: Choice[] = [
  { value: '0', label: t('الكل', 'Everyone') },
  { value: '1', label: t('موظف', 'Employee') },
  { value: '2', label: t('دور', 'Role') },
  { value: '3', label: t('فرع', 'Branch') },
];

export const ACCOUNTING_FORMS: Partial<Record<AccountingSectionKey, FormDef>> = {
  expenses: {
    section: 'expenses',
    title: t('سند صرف جديد', 'New expense voucher'),
    submitLabel: t('حفظ سند الصرف', 'Save expense'),
    createPermission: 'account.expenses.create',
    path: '/expenses',
    optionsForm: 'expenses',
    fields: [
      {
        key: 'expense_type',
        label: t('نوع السند', 'Voucher type'),
        type: 'segmented',
        required: true,
        default: 'general',
        choices: [
          { value: 'general', label: t('عام', 'General') },
          { value: 'client', label: t('لعميل', 'To client') },
          { value: 'supplier', label: t('لمورد', 'To supplier') },
        ],
      },
      { key: 'amount', label: t('المبلغ', 'Amount'), type: 'amount', required: true },
      { key: 'date', label: t('التاريخ', 'Date'), type: 'date', required: true, default: 'today' },
      {
        key: 'expenses_category_id',
        label: t('التصنيف', 'Category'),
        type: 'select',
        optionsKey: 'expenses_category_id',
        requiredWhen: { field: 'expense_type', in: ['general', 'supplier'] },
      },
      {
        key: 'account_id',
        label: t('الحساب', 'Account'),
        type: 'select',
        searchable: true,
        optionsKeyBy: { field: 'expense_type', map: { general: 'expense_account_id', client: 'client_account_id' } },
        visibleWhen: { field: 'expense_type', in: ['general', 'client'] },
        requiredWhen: { field: 'expense_type', in: ['general', 'client'] },
      },
      {
        key: 'supplier_id',
        label: t('المورد', 'Supplier'),
        type: 'select',
        optionsKey: 'supplier_id',
        visibleWhen: { field: 'expense_type', in: ['supplier'] },
        requiredWhen: { field: 'expense_type', in: ['supplier'] },
      },
      { key: 'treasury_id', label: t('الخزينة', 'Treasury'), type: 'select', required: true, optionsKey: 'treasury_id', default: 'defaults.treasury_id' },
      { key: 'seller', label: t('الجهة / البائع', 'Payee'), type: 'text', maxLength: 255 },
      { key: 'description', label: t('الوصف', 'Description'), type: 'multiline', maxLength: 500 },
    ],
    // سندٌ لمورد قد يكون غير مسموحٍ لهذا المستخدم (`can_expense_to_supplier`) — يُحذف الخيار لا يُترك مقفلاً بلا تفسير
    adjustField: (f, _options, _defaults, flags) => {
      if (f.key === 'expense_type' && f.choices && flags.can_expense_to_supplier === false) {
        return { ...f, choices: f.choices.filter((c) => c.value !== 'supplier') };
      }
      return f;
    },
    toPayload: (v) =>
      compact({
        expense_type: v.expense_type ?? 'general',
        amount: num(v.amount),
        date: v.date,
        expenses_category_id: v.expenses_category_id,
        account_id: v.expense_type === 'supplier' ? undefined : v.account_id,
        supplier_id: v.expense_type === 'supplier' ? v.supplier_id : undefined,
        treasury_id: v.treasury_id,
        seller: v.seller,
        description: v.description,
      }),
  },

  incomes: {
    section: 'incomes',
    title: t('سند قبض جديد', 'New receipt voucher'),
    submitLabel: t('حفظ سند القبض', 'Save receipt'),
    createPermission: 'account.incomes.create',
    path: '/incomes',
    optionsForm: 'incomes',
    fields: [
      {
        key: 'account_source',
        label: t('القبض من', 'Received from'),
        type: 'segmented',
        default: 'client',
        choices: [
          { value: 'client', label: t('عميل', 'Client') },
          { value: 'other', label: t('حساب آخر', 'Other account') },
        ],
      },
      { key: 'amount', label: t('المبلغ', 'Amount'), type: 'amount', required: true },
      { key: 'date', label: t('التاريخ', 'Date'), type: 'date', required: true, default: 'today' },
      {
        key: 'account_id',
        label: t('الحساب المقابل', 'Counter account'),
        type: 'select',
        required: true,
        searchable: true,
        optionsKeyBy: { field: 'account_source', map: { client: 'client_account_id', other: 'other_account_id' } },
      },
      { key: 'treasury_id', label: t('الخزينة', 'Treasury'), type: 'select', required: true, optionsKey: 'treasury_id', default: 'defaults.treasury_id' },
      { key: 'incomes_category_id', label: t('التصنيف', 'Category'), type: 'select', optionsKey: 'incomes_category_id' },
      { key: 'description', label: t('الوصف', 'Description'), type: 'multiline', maxLength: 500 },
    ],
    // «حساب آخر» يُخفى إن لم توجد حسابات كذلك، والعكس بالعكس — والافتراضي يتبع ما هو متاحٌ فعلاً
    adjustField: (f, options) => {
      if (f.key === 'account_source' && f.choices) {
        const hasOther = (options.other_account_id ?? []).length > 0;
        const hasClient = (options.client_account_id ?? []).length > 0;
        const choices = f.choices.filter((c) => (c.value === 'other' ? hasOther : hasClient || !hasOther));
        return { ...f, choices, default: !hasClient && hasOther ? 'other' : f.default };
      }
      return f;
    },
    toPayload: (v) =>
      compact({
        amount: num(v.amount),
        date: v.date,
        account_id: v.account_id,
        treasury_id: v.treasury_id,
        incomes_category_id: v.incomes_category_id,
        description: v.description,
      }),
  },

  journal: {
    section: 'journal',
    title: t('قيد يومية جديد', 'New journal entry'),
    submitLabel: t('حفظ القيد', 'Save entry'),
    createPermission: 'account.journal.create',
    path: '/journal-entries',
    optionsForm: 'journal',
    fields: [
      { key: 'date', label: t('التاريخ', 'Date'), type: 'date', required: true, default: 'today' },
      { key: 'description', label: t('وصف القيد', 'Description'), type: 'multiline', required: true, maxLength: 500 },
      {
        key: 'lines',
        label: t('أطراف القيد', 'Entry lines'),
        type: 'lines',
        required: true,
        lines: {
          min: 2,
          totals: 'debit_credit',
          columns: [
            { key: 'account_id', label: t('الحساب', 'Account'), type: 'select', optionsKey: 'account_id', searchable: true, required: true },
            { key: 'debit', label: t('مدين', 'Debit'), type: 'amount' },
            { key: 'credit', label: t('دائن', 'Credit'), type: 'amount' },
            { key: 'cost_center_id', label: t('مركز التكلفة', 'Cost center'), type: 'select', optionsKey: 'cost_center_id' },
            { key: 'description', label: t('الوصف', 'Description'), type: 'text' },
          ],
        },
      },
    ],
    toPayload: (v, defaults) => {
      const lines = Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [];
      return {
        journal_entry: compact({ date: v.date, description: v.description, reference_type: defaults.reference_type ?? 'JV' }),
        details: lines.map((l) =>
          compact({
            account_id: l.account_id,
            debit: num(l.debit) ?? 0,
            credit: num(l.credit) ?? 0,
            description: l.description,
            cost_center_id: l.cost_center_id,
          }),
        ),
      };
    },
    // توازن مدين/دائن — تحقّقٌ خاصٌّ بنماذج القيود، فوق الحدّ الأدنى العام لعدد الأسطر
    validate: (v, lang) => validateDebitCreditLines('lines', Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [], 2, lang),
    // أخطاء الويب على قيدٍ محاسبي: `journal_entry.date` ← `date`، وأي `details*` ← حقل الأسطر نفسه
    mapErrorKey: (key) => (key.startsWith('journal_entry.') ? key.slice('journal_entry.'.length) : key.startsWith('details') ? 'lines' : key),
  },

  treasuries: {
    section: 'treasuries',
    title: t('خزينة جديدة', 'New treasury'),
    submitLabel: t('حفظ الخزينة', 'Save treasury'),
    createPermission: 'account.treasury.create',
    path: '/treasuries',
    optionsForm: 'treasuries',
    fields: [
      { key: 'name', label: t('اسم الخزينة', 'Treasury name'), type: 'text', required: true, maxLength: 255 },
      { key: 'description', label: t('الوصف', 'Description'), type: 'multiline' },
      { key: 'is_active', label: t('نشطة', 'Active'), type: 'switch', default: true },
      { key: 'deposit_permissions', label: t('يُسمح بالإيداع لـ', 'Deposit allowed for'), type: 'segmented', required: true, default: '0', choices: SCOPES },
      { key: 'v_employee_id', label: t('الموظف (إيداع)', 'Employee (deposit)'), type: 'select', optionsKey: 'employee_id', visibleWhen: { field: 'deposit_permissions', in: ['1'] }, requiredWhen: { field: 'deposit_permissions', in: ['1'] } },
      { key: 'v_functional_role_id', label: t('الدور (إيداع)', 'Role (deposit)'), type: 'select', optionsKey: 'role_id', visibleWhen: { field: 'deposit_permissions', in: ['2'] }, requiredWhen: { field: 'deposit_permissions', in: ['2'] } },
      { key: 'v_branch_id', label: t('الفرع (إيداع)', 'Branch (deposit)'), type: 'select', optionsKey: 'branch_id', visibleWhen: { field: 'deposit_permissions', in: ['3'] }, requiredWhen: { field: 'deposit_permissions', in: ['3'] } },
      { key: 'withdraw_permissions', label: t('يُسمح بالسحب لـ', 'Withdrawal allowed for'), type: 'segmented', required: true, default: '0', choices: SCOPES },
      { key: 'c_employee_id', label: t('الموظف (سحب)', 'Employee (withdraw)'), type: 'select', optionsKey: 'employee_id', visibleWhen: { field: 'withdraw_permissions', in: ['1'] }, requiredWhen: { field: 'withdraw_permissions', in: ['1'] } },
      { key: 'c_functional_role_id', label: t('الدور (سحب)', 'Role (withdraw)'), type: 'select', optionsKey: 'role_id', visibleWhen: { field: 'withdraw_permissions', in: ['2'] }, requiredWhen: { field: 'withdraw_permissions', in: ['2'] } },
      { key: 'c_branch_id', label: t('الفرع (سحب)', 'Branch (withdraw)'), type: 'select', optionsKey: 'branch_id', visibleWhen: { field: 'withdraw_permissions', in: ['3'] }, requiredWhen: { field: 'withdraw_permissions', in: ['3'] } },
    ],
    toPayload: (v) =>
      compact({
        name: v.name,
        description: v.description,
        is_active: v.is_active === false || v.is_active === 'false' || v.is_active === 0 ? 0 : 1,
        deposit_permissions: Number(v.deposit_permissions ?? 0),
        withdraw_permissions: Number(v.withdraw_permissions ?? 0),
        v_employee_id: v.v_employee_id,
        v_functional_role_id: v.v_functional_role_id,
        v_branch_id: v.v_branch_id,
        c_employee_id: v.c_employee_id,
        c_functional_role_id: v.c_functional_role_id,
        c_branch_id: v.c_branch_id,
      }),
  },

  chart: {
    section: 'chart',
    title: t('حساب جديد', 'New account'),
    submitLabel: t('حفظ الحساب', 'Save account'),
    createPermission: 'account.chart.create',
    path: '/chart-accounts',
    optionsForm: 'chart',
    fields: [
      {
        key: 'type',
        label: t('نوع الحساب', 'Account kind'),
        type: 'segmented',
        required: true,
        default: 'sub',
        choices: [
          { value: 'sub', label: t('فرعي', 'Sub-account') },
          { value: 'main', label: t('رئيسي', 'Main account') },
        ],
      },
      { key: 'account_type', label: t('التصنيف المالي', 'Financial type'), type: 'select', choices: ACCOUNT_TYPES, visibleWhen: { field: 'type', in: ['main'] }, requiredWhen: { field: 'type', in: ['main'] } },
      { key: 'parent_id', label: t('الحساب الأب', 'Parent account'), type: 'select', optionsKey: 'parent_id', searchable: true, visibleWhen: { field: 'type', in: ['sub'] }, requiredWhen: { field: 'type', in: ['sub'] } },
      { key: 'code', label: t('الكود', 'Code'), type: 'text', required: true, maxLength: 10, suggestCode: { kind: 'chart', parentField: 'parent_id' } },
      { key: 'name', label: t('اسم الحساب', 'Account name'), type: 'text', required: true, maxLength: 255 },
      {
        key: 'balance_type',
        label: t('طبيعة الرصيد', 'Balance side'),
        type: 'segmented',
        required: true,
        default: 'debit',
        choices: [
          { value: 'debit', label: t('مدين', 'Debit') },
          { value: 'credit', label: t('دائن', 'Credit') },
        ],
      },
      { key: 'opening_balance', label: t('الرصيد الافتتاحي', 'Opening balance'), type: 'amount' },
    ],
    toPayload: (v) =>
      compact({
        type: v.type ?? 'sub',
        account_type: v.type === 'main' ? v.account_type : undefined,
        parent_id: v.type === 'sub' ? v.parent_id : undefined,
        code: v.code,
        name: v.name,
        balance_type: v.balance_type ?? 'debit',
        opening_balance: num(v.opening_balance),
        opening_balance_type: num(v.opening_balance) ? (v.balance_type ?? 'debit') : undefined,
      }),
  },

  cost_centers: {
    section: 'cost_centers',
    title: t('مركز تكلفة جديد', 'New cost center'),
    submitLabel: t('حفظ المركز', 'Save cost center'),
    createPermission: 'account.cost_centers.create',
    path: '/cost-centers',
    optionsForm: 'cost_centers',
    fields: [
      { key: 'parent_id', label: t('المركز الأب (اختياري)', 'Parent (optional)'), type: 'select', optionsKey: 'parent_id' },
      { key: 'code', label: t('الكود', 'Code'), type: 'text', required: true, maxLength: 10, suggestCode: { kind: 'cost_center', parentField: 'parent_id' } },
      { key: 'name', label: t('الاسم', 'Name'), type: 'text', required: true, maxLength: 255 },
    ],
    toPayload: (v) => compact({ parent_id: v.parent_id, code: v.code, name: v.name }),
  },

  cheque_books: {
    section: 'cheque_books',
    title: t('دفتر شيكات جديد', 'New cheque book'),
    submitLabel: t('حفظ الدفتر', 'Save cheque book'),
    createPermission: 'account.cheque_books.create',
    path: '/cheque-books',
    optionsForm: 'cheque_books',
    fields: [
      { key: 'bank_id', label: t('البنك', 'Bank'), type: 'select', required: true, optionsKey: 'bank_id' },
      { key: 'cheque_book_number', label: t('رقم الدفتر', 'Book number'), type: 'text', maxLength: 50, default: 'defaults.cheque_book_number' },
      { key: 'currency', label: t('العملة', 'Currency'), type: 'text', required: true, maxLength: 3, default: 'SAR' },
      { key: 'start_serial_number', label: t('من رقم', 'From no.'), type: 'number', required: true },
      { key: 'end_serial_number', label: t('إلى رقم', 'To no.'), type: 'number', required: true },
      {
        key: 'status',
        label: t('الحالة', 'Status'),
        type: 'segmented',
        required: true,
        default: '1',
        choices: [
          { value: '1', label: t('نشط', 'Active') },
          { value: '0', label: t('غير نشط', 'Inactive') },
        ],
      },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 1000 },
    ],
    toPayload: (v) =>
      compact({
        bank_id: v.bank_id,
        cheque_book_number: v.cheque_book_number,
        currency: typeof v.currency === 'string' ? v.currency.toUpperCase() : v.currency,
        start_serial_number: num(v.start_serial_number),
        end_serial_number: num(v.end_serial_number),
        status: Number(v.status ?? 1),
        notes: v.notes,
      }),
  },

  payable_cheques: {
    section: 'payable_cheques',
    title: t('شيك صادر جديد', 'New payable cheque'),
    submitLabel: t('إصدار الشيك', 'Issue cheque'),
    createPermission: 'account.payable_cheques.create',
    path: '/payable-cheques',
    optionsForm: 'payable_cheques',
    fields: [
      { key: 'cheque_book_id', label: t('دفتر الشيكات', 'Cheque book'), type: 'select', required: true, optionsKey: 'cheque_book_id', onSelectFill: { kind: 'checkbook', fill: { cheque_number: 'next_number' } } },
      { key: 'cheque_number', label: t('رقم الشيك', 'Cheque number'), type: 'number', required: true },
      { key: 'amount', label: t('المبلغ', 'Amount'), type: 'amount', required: true },
      { key: 'issue_date', label: t('تاريخ الإصدار', 'Issue date'), type: 'date', required: true, default: 'today' },
      { key: 'due_date', label: t('تاريخ الاستحقاق', 'Due date'), type: 'date' },
      { key: 'recipient_account_id', label: t('حساب المستفيد', 'Payee account'), type: 'select', required: true, optionsKey: 'recipient_account_id', searchable: true },
      { key: 'supplier_id', label: t('المورد (اختياري)', 'Supplier (optional)'), type: 'select', optionsKey: 'supplier_id' },
      { key: 'payee_name', label: t('اسم المستفيد', 'Payee name'), type: 'text', required: true, maxLength: 255 },
      { key: 'description', label: t('الوصف', 'Description'), type: 'multiline', maxLength: 500 },
    ],
    toPayload: (v) =>
      compact({
        cheque_book_id: v.cheque_book_id,
        cheque_number: num(v.cheque_number),
        amount: num(v.amount),
        issue_date: v.issue_date,
        due_date: v.due_date,
        recipient_account_id: v.recipient_account_id,
        supplier_id: v.supplier_id,
        payee_name: v.payee_name,
        description: v.description,
      }),
  },

  received_cheques: {
    section: 'received_cheques',
    title: t('شيك مستلم جديد', 'New received cheque'),
    submitLabel: t('تسجيل الشيك', 'Record cheque'),
    createPermission: 'account.received_cheques.create',
    path: '/received-cheques',
    optionsForm: 'received_cheques',
    fields: [
      { key: 'cheque_number', label: t('رقم الشيك', 'Cheque number'), type: 'number', required: true },
      { key: 'amount', label: t('المبلغ', 'Amount'), type: 'amount', required: true },
      { key: 'issue_date', label: t('تاريخ الإصدار', 'Issue date'), type: 'date', required: true, default: 'today' },
      { key: 'due_date', label: t('تاريخ الاستحقاق', 'Due date'), type: 'date' },
      { key: 'recipient_account_id', label: t('الحساب المستلَم منه', 'Received from account'), type: 'select', required: true, optionsKey: 'recipient_account_id', searchable: true },
      { key: 'payee_name', label: t('اسم الساحب', 'Drawer name'), type: 'text', required: true, maxLength: 255 },
      { key: 'drawer_bank', label: t('بنك الساحب', 'Drawer bank'), type: 'text', maxLength: 255 },
      { key: 'drawer_branch', label: t('فرع البنك', 'Bank branch'), type: 'text', maxLength: 255 },
      { key: 'bank_account_id', label: t('حساب الإيداع (اختياري)', 'Deposit bank (optional)'), type: 'select', optionsKey: 'bank_account_id' },
      { key: 'description', label: t('الوصف', 'Description'), type: 'multiline', maxLength: 500 },
    ],
    toPayload: (v) =>
      compact({
        cheque_number: num(v.cheque_number),
        amount: num(v.amount),
        issue_date: v.issue_date,
        due_date: v.due_date,
        recipient_account_id: v.recipient_account_id,
        payee_name: v.payee_name,
        drawer_bank: v.drawer_bank,
        drawer_branch: v.drawer_branch,
        bank_account_id: v.bank_account_id,
        description: v.description,
      }),
  },
};

export { today };
