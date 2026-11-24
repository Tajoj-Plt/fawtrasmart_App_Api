import { LocalizedText } from './ModuleCatalog';

/**
 * أقسام وحدة الحسابات — ترجمة القائمة الجانبية لوحدة الحسابات في الويب
 * (`Modules/Account/resources/views/layouts/sidebar.blade.php`)، بنفس شروطها الثلاثة:
 *
 *  ١. صلاحية الدور (`hasPermission`) على كل بند.
 *  ٢. مفتاح شاشة «إدارة التطبيقات» للمجموعة: finance / general_accounts_journal_entries / cheque_cycle.
 *  ٣. باقة فوترة: بند خارج الباقة يظهر مقفلاً (شارة القفل في الويب) ولا يُفتح.
 *
 * الأقسام المعروضة في التطبيق هي ما له شاشة عرض فيه؛ أما الإنشاء والتعديل والتقارير فتأتي لاحقاً.
 */

export type AccountingSectionKey =
  | 'overview'
  | 'expenses'
  | 'incomes'
  | 'treasuries'
  | 'journal'
  | 'chart'
  | 'cost_centers'
  | 'payable_cheques'
  | 'received_cheques'
  | 'cheque_books';

export interface AccountingItemDef {
  key: AccountingSectionKey;
  title: LocalizedText;
  /** أيقونة lucide/feather في التطبيق */
  icon: string;
  /** يكفي واحدة منها */
  permissions: string[];
  /** مفتاح ميزة الباقة (AccountPlanFeatures) */
  planFeature: string | null;
  /** صلاحية الإنشاء في هذا القسم؛ غيابها = القسم للعرض فقط */
  createPermission?: string;
}

export interface AccountingGroupDef {
  key: string;
  title: LocalizedText;
  /** مفتاح ApplicationRegistry للمجموعة؛ null = بلا مفتاح */
  registryKey: string | null;
  items: AccountingItemDef[];
}

export const ACCOUNTING_GROUPS: AccountingGroupDef[] = [
  {
    key: 'home',
    title: { ar: 'الرئيسية', en: 'Home' },
    registryKey: null,
    items: [
      {
        key: 'overview',
        title: { ar: 'نظرة عامة', en: 'Overview' },
        icon: 'layout-dashboard',
        // أي صلاحية في الوحدة تكفي (بوابة البطاقة في الويب: بادئة `account.`)
        permissions: ['account.'],
        planFeature: null,
      },
    ],
  },
  {
    key: 'finance',
    title: { ar: 'المالية', en: 'Finance' },
    registryKey: 'finance',
    items: [
      { key: 'expenses', title: { ar: 'سندات الصرف', en: 'Expenses' }, icon: 'file-minus', permissions: ['account.expenses.view'], planFeature: 'expenses', createPermission: 'account.expenses.create' },
      { key: 'incomes', title: { ar: 'سندات القبض', en: 'Receipts' }, icon: 'file-plus', permissions: ['account.incomes.view'], planFeature: 'incomes', createPermission: 'account.incomes.create' },
      { key: 'treasuries', title: { ar: 'الخزائن والحسابات البنكية', en: 'Cash & bank accounts' }, icon: 'landmark', permissions: ['account.treasury.view'], planFeature: 'treasury', createPermission: 'account.treasury.create' },
    ],
  },
  {
    key: 'general',
    title: { ar: 'الحسابات العامة', en: 'General accounts' },
    registryKey: 'general_accounts_journal_entries',
    items: [
      { key: 'journal', title: { ar: 'قيود اليومية', en: 'Journal entries' }, icon: 'book-open', permissions: ['account.journal.view'], planFeature: 'journal_entries', createPermission: 'account.journal.create' },
      { key: 'chart', title: { ar: 'شجرة الحسابات', en: 'Chart of accounts' }, icon: 'git-merge', permissions: ['account.chart.view'], planFeature: 'chart_of_accounts', createPermission: 'account.chart.create' },
      { key: 'cost_centers', title: { ar: 'مراكز التكلفة', en: 'Cost centers' }, icon: 'target', permissions: ['account.cost_centers.view'], planFeature: 'cost_centers', createPermission: 'account.cost_centers.create' },
    ],
  },
  {
    key: 'cheques',
    title: { ar: 'دورة الشيكات', en: 'Cheques' },
    registryKey: 'cheque_cycle',
    items: [
      { key: 'payable_cheques', title: { ar: 'الشيكات الصادرة', en: 'Payable cheques' }, icon: 'arrow-up-right', permissions: ['account.payable_cheques.view'], planFeature: 'payable_cheques', createPermission: 'account.payable_cheques.create' },
      { key: 'received_cheques', title: { ar: 'الشيكات المستلمة', en: 'Received cheques' }, icon: 'arrow-down-left', permissions: ['account.received_cheques.view'], planFeature: 'received_cheques', createPermission: 'account.received_cheques.create' },
      { key: 'cheque_books', title: { ar: 'دفاتر الشيكات', en: 'Cheque books' }, icon: 'book', permissions: ['account.cheque_books.view'], planFeature: 'check_books', createPermission: 'account.cheque_books.create' },
    ],
  },
];

export interface AccessContext {
  permissions: Set<string>;
  applicationStatuses: Record<string, 'active' | 'inactive'>;
  subscriptionLinked: boolean;
  planPermissions: Record<string, boolean>;
}

export interface AccountingItem {
  key: AccountingSectionKey;
  title: LocalizedText;
  icon: string;
  locked: boolean;
  /** يملك الدور صلاحية الإنشاء هنا (فيظهر زرّ الإضافة العائم) */
  canCreate: boolean;
}

export interface AccountingGroup {
  key: string;
  title: LocalizedText;
  items: AccountingItem[];
}

function hasAny(permissions: Set<string>, wanted: string[]): boolean {
  return wanted.some((w) => {
    if (w.endsWith('.')) {
      for (const p of permissions) if (p.startsWith(w)) return true;
      return false;
    }
    return permissions.has(w);
  });
}

function planAllows(ctx: AccessContext, feature: string | null): boolean {
  if (!feature || !ctx.subscriptionLinked) return true;
  if (!(feature in ctx.planPermissions)) return true;
  return Boolean(ctx.planPermissions[feature]);
}

function registryActive(ctx: AccessContext, key: string | null): boolean {
  return !key || (ctx.applicationStatuses[key] ?? 'active') === 'active';
}

export function findAccountingItem(key: string): { group: AccountingGroupDef; item: AccountingItemDef } | null {
  for (const group of ACCOUNTING_GROUPS) {
    const item = group.items.find((i) => i.key === key);
    if (item) return { group, item };
  }
  return null;
}

/** هل يُسمح بهذا البند؟ (`visible` = يظهر في القائمة، `locked` = خارج الباقة) */
export function evaluateItem(group: AccountingGroupDef, item: AccountingItemDef, ctx: AccessContext) {
  const visible = registryActive(ctx, group.registryKey) && hasAny(ctx.permissions, item.permissions);
  const locked = visible && !planAllows(ctx, item.planFeature);
  return { visible, locked };
}

/** القائمة الجانبية التي يراها هذا الدور — المجموعة الفارغة تُحذف كما تُخفى في الويب */
export function resolveAccountingSections(ctx: AccessContext): AccountingGroup[] {
  const groups: AccountingGroup[] = [];

  for (const group of ACCOUNTING_GROUPS) {
    const items: AccountingItem[] = [];

    for (const item of group.items) {
      const { visible, locked } = evaluateItem(group, item, ctx);
      if (visible) {
        const canCreate = !locked && Boolean(item.createPermission) && ctx.permissions.has(item.createPermission as string);
        items.push({ key: item.key, title: item.title, icon: item.icon, locked, canCreate });
      }
    }

    if (items.length > 0) groups.push({ key: group.key, title: group.title, items });
  }

  return groups;
}
