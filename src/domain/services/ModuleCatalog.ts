/**
 * كتالوج وحدات النظام كما تظهر بطاقاتُها في ترويسة النسخة الويب
 * (`resources/views/layouts/header.blade.php` — نافذة «جميع الخدمات»)،
 * مع ربطها بمفاتيح شاشة «إدارة التطبيقات»
 * (`App\Services\Settings\ApplicationRegistry`) وخريطة باقة فوترة
 * (`App\Constants\planFeatures\ApplicationPlanFeatures`).
 *
 * الحارس ثلاثي كما في الويب: صلاحيةُ المستخدم، ومفتاحُ التطبيق، وباقةُ الاشتراك.
 */

export type ModuleColor = 'primary' | 'info' | 'success' | 'danger' | 'warning' | 'dark' | 'secondary';

export interface LocalizedText {
  ar: string;
  en: string;
}

/** قاعدة ظهور البطاقة — نفس الشروط المكتوبة في القالب */
export type PermissionGate =
  | { type: 'any'; permissions: string[] }
  | { type: 'prefix'; prefix: string; orAny?: string[] };

export interface ModuleDefinition {
  key: string;
  /** مفتاح شاشة «إدارة التطبيقات» — فارغ لبطاقةٍ لا تُعطَّل من هناك (الإعدادات) */
  registryKey: string | null;
  title: LocalizedText;
  subtitle: LocalizedText;
  /** اسم أيقونة feather كما في الويب */
  icon: string;
  color: ModuleColor;
  gate: PermissionGate;
  order: number;
}

export type LockReason = 'plan' | null;

export interface ModuleCard {
  key: string;
  registryKey: string | null;
  title: LocalizedText;
  subtitle: LocalizedText;
  icon: string;
  color: ModuleColor;
  locked: boolean;
  lockReason: LockReason;
  order: number;
}

export const MODULES: ModuleDefinition[] = [
  {
    key: 'sales',
    registryKey: 'sales',
    title: { ar: 'إدارة المبيعات', en: 'Sales' },
    subtitle: { ar: 'مبيعات - فواتير', en: 'Sales · Invoices' },
    icon: 'shopping-cart',
    color: 'primary',
    order: 10,
    gate: {
      type: 'any',
      permissions: [
        'sales.invoices.view', 'sales.invoices.create', 'sales.invoices.edit', 'sales.invoices.delete',
        'sales.payments.view', 'sales.payments.create', 'sales.payments.edit', 'sales.payments.delete',
        'sales.credit_notes.view', 'sales.credit_notes.create', 'sales.credit_notes.edit', 'sales.credit_notes.delete',
        'sales.quotes.view', 'sales.quotes.create', 'sales.quotes.edit', 'sales.quotes.delete',
        'sales.dashboard.view',
      ],
    },
  },
  {
    key: 'customers',
    registryKey: 'customers',
    title: { ar: 'إدارة العملاء', en: 'Customers' },
    subtitle: { ar: 'عملاء - ولاء', en: 'Clients · Loyalty' },
    icon: 'users',
    color: 'info',
    order: 20,
    gate: {
      type: 'any',
      permissions: [
        'clients_view_all_clients', 'clients_add_client',
        'client_follow_up_add_notes_attachments_appointments_all',
        'clients_edit_client_settings', 'customer_attendance_display',
      ],
    },
  },
  {
    key: 'online_store',
    registryKey: 'ecommerce',
    title: { ar: 'المتجر الإلكتروني', en: 'Online store' },
    subtitle: { ar: 'طلبات أونلاين', en: 'Online orders' },
    icon: 'globe',
    color: 'success',
    order: 30,
    gate: { type: 'any', permissions: ['online_store_content_management'] },
  },
  {
    key: 'real_estate',
    registryKey: 'rental_management',
    title: { ar: 'إدارة العقارات', en: 'Real estate' },
    subtitle: { ar: 'مبانٍ - وحدات - عقود - دفعات - صيانة', en: 'Buildings · Units · Contracts' },
    icon: 'home',
    color: 'primary',
    order: 40,
    gate: {
      type: 'prefix',
      prefix: 'realestate.',
      orAny: ['rental_unit_view_booking_orders', 'rental_unit_manage_booking_orders', 'rental_unit_manage_rental_settings'],
    },
  },
  {
    key: 'stock',
    registryKey: 'inventory_management',
    title: { ar: 'إدارة المخزون', en: 'Inventory' },
    subtitle: { ar: 'مخزون - حركة', en: 'Stock · Movements' },
    icon: 'package',
    color: 'danger',
    order: 50,
    gate: { type: 'prefix', prefix: 'stock.', orAny: ['online_store_content_management'] },
  },
  {
    key: 'manufacturing',
    registryKey: 'manufacturing',
    title: { ar: 'التصنيع', en: 'Manufacturing' },
    subtitle: { ar: 'أوامر إنتاج - قوائم مواد', en: 'Production orders · BOM' },
    icon: 'layers',
    color: 'warning',
    order: 60,
    gate: { type: 'any', permissions: ['stock.manufacturing_orders.view', 'stock.bom.view', 'stock.workstations.view'] },
  },
  {
    key: 'pos',
    registryKey: 'pos',
    title: { ar: 'نقاط البيع', en: 'Point of sale' },
    subtitle: { ar: 'جلسات - أجهزة - ورديات', en: 'Sessions · Devices · Shifts' },
    icon: 'monitor',
    color: 'success',
    order: 70,
    gate: { type: 'any', permissions: ['pos_manage_settings', 'pos_view_reports'] },
  },
  {
    key: 'branches',
    registryKey: 'branches',
    title: { ar: 'الهيكل التنظيمي', en: 'Organization' },
    subtitle: { ar: 'المناطق والفروع والمجموعات والمنافذ', en: 'Regions · Branches · Outlets' },
    icon: 'git-branch',
    color: 'primary',
    order: 80,
    gate: { type: 'any', permissions: ['branches.view', 'branches'] },
  },
  {
    key: 'purchases',
    registryKey: 'purchase_cycle',
    title: { ar: 'إدارة المشتريات', en: 'Purchases' },
    subtitle: { ar: 'فواتير شراء', en: 'Purchase invoices' },
    icon: 'shopping-bag',
    color: 'info',
    order: 90,
    gate: { type: 'prefix', prefix: 'purchases.' },
  },
  {
    key: 'accounts',
    registryKey: 'finance',
    title: { ar: 'المالية والحسابات', en: 'Finance' },
    subtitle: { ar: 'قيود - حسابات', en: 'Journals · Accounts' },
    icon: 'dollar-sign',
    color: 'info',
    order: 100,
    gate: { type: 'prefix', prefix: 'account.' },
  },
  {
    key: 'tasks',
    registryKey: 'tasks',
    title: { ar: 'إدارة المهام', en: 'Tasks' },
    subtitle: { ar: 'المتابعة - الإنجاز', en: 'Follow-up · Delivery' },
    icon: 'check-square',
    color: 'secondary',
    order: 110,
    gate: { type: 'any', permissions: ['tasks_view_tasks'] },
  },
  {
    key: 'hr',
    /*
        المفتاحُ `salaries` لا `employees`: ما يفتحه التطبيقُ من الموارد البشرية
        هو شاشاتُ «المرتّبات» (السلف والخصميات والقسائم والصرفات) وحدها، وهي
        محروسةٌ بـ`module:salaries` في الويب. فتعطيلُ «المرتّبات» يجعل كلَّ منافذ
        `/hr/...` تردّ 403، فلا تُعرض بطاقةٌ تؤدّي إلى بابٍ مغلق — وخريطةُ
        الباقة لـ`salaries` هي ميزاتُ هذه الشاشات نفسِها.
    */
    registryKey: 'salaries',
    title: { ar: 'إدارة الموارد البشرية', en: 'Human resources' },
    subtitle: { ar: 'موظفين - رواتب', en: 'Employees · Payroll' },
    icon: 'users',
    color: 'success',
    order: 120,
    /*
        `hr_dashboard.index` صحيحةٌ كما هي (المجموعة `hr_dashboard` في
        `HrPermissions`)، لكنها كانت الشرطَ الوحيد — فمن يملك صلاحيات السلف أو
        الخصميات أو القسائم بلا صلاحية لوحةِ الوحدة لا يرى البطاقة أصلاً ولا
        يبلغ شاشاتِه. فوُسِّع الحارسُ إلى صلاحيات الأقسام التي يخدمها التطبيق.
    */
    gate: {
      type: 'any',
      permissions: ['hr_dashboard.index', 'loans.create', 'loans.show', 'loans.index', 'deductions.index', 'payslips.index', 'disbursements.index'],
    },
  },
  {
    key: 'attendance',
    /*
        «سجّل حضوري»: بطاقةٌ مستقلّة بمفتاح تطبيق الحضور وصلاحيته — المندوبُ الذي لا يملك من
        الموارد البشرية إلا تسجيلَ حضوره لا يرى بطاقة «الموارد البشرية» (مفتاحها `salaries`
        وصلاحياتها المرتّبات)، فلا يبلغ شاشتَه بدونها. تفتح قسم الحضور مباشرةً.
    */
    registryKey: 'employee_attendance',
    title: { ar: 'الحضور والانصراف', en: 'Attendance' },
    subtitle: { ar: 'سجّل حضورك وانصرافك', en: 'Check in · Check out' },
    icon: 'clock',
    color: 'info',
    order: 121,
    gate: { type: 'any', permissions: ['attendance_registration.mobile'] },
  },
  {
    key: 'settings',
    registryKey: null,
    title: { ar: 'الإعدادات العامة', en: 'Settings' },
    subtitle: { ar: 'المستخدمين - النظام', en: 'Users · System' },
    icon: 'settings',
    color: 'dark',
    order: 130,
    gate: { type: 'any', permissions: ['settings_edit_general_settings', 'settings_edit_tax_settings'] },
  },
];

/**
 * خريطة شاشة التطبيقات على صلاحيات باقة فوترة — نسخة حرفية من
 * `ApplicationPlanFeatures::map()`. الوحدة الغائبة عن الخريطة مشمولة دائماً.
 */
export const PLAN_FEATURES: Record<string, string[]> = {
  sales: ['invoices', 'quotes', 'return_invoices', 'credit_notes', 'periodic_invoices', 'payments', 'dashboard', 'reports'],
  pos: ['pos_terminal', 'pos_sessions_mgmt', 'pos_settings', 'pos_reports'],
  installments_management: ['installments'],
  offers: ['offers', 'gift_offers'],
  inventory_management: ['stock_products', 'stock_categories', 'stock_storehouses', 'stock_warehouse_permits', 'stock_inventory_adjustment', 'stock_reports'],
  manufacturing: ['stock_manufacturing', 'stock_bom', 'stock_workstations'],
  purchase_cycle: ['purchases_invoices', 'purchases_orders', 'purchases_order_requests', 'purchases_quotations', 'purchases_returns', 'purchases_payments', 'purchases_suppliers', 'purchases_reports'],
  finance: ['treasury', 'expenses', 'incomes', 'assets', 'cost_centers', 'account_statement', 'account_reports'],
  general_accounts_journal_entries: ['journal_entries', 'chart_of_accounts'],
  cheque_cycle: ['check_books', 'payable_cheques', 'received_cheques'],
  employees: ['hr_employees', 'hr_employee_performance', 'hr_self_service'],
  organizational_structure: ['hr_departments', 'hr_job_titles', 'hr_functional_levels'],
  employee_attendance: ['hr_attendance', 'hr_attendance_devices', 'hr_shifts', 'hr_attendance_rules', 'hr_barcode_attendance'],
  salaries: ['hr_payroll', 'hr_payslips', 'hr_salary_items', 'hr_contracts', 'hr_advances', 'hr_deductions'],
  orders: ['hr_leaves', 'hr_leave_types', 'hr_leave_balances', 'hr_holidays', 'hr_leave_permissions', 'hr_advances'],
  branches: ['branches', 'branch_hierarchy', 'branch_switch', 'branch_settings', 'branch_dashboard'],
};

export interface ModuleResolutionContext {
  /** صلاحيات دور المستخدم (role_has_permissions) */
  permissions: Set<string>;
  /** حالات شاشة التطبيقات — المفتاح غير المحفوظ يُعتبر مفعَّلاً */
  applicationStatuses: Record<string, 'active' | 'inactive'>;
  /** هل الاشتراك مربوط؟ غير المربوط يعمل بلا قيد */
  subscriptionLinked: boolean;
  /** صلاحيات الباقة: مفتاح ← مسموح. غير المذكور مسموح. */
  planPermissions: Record<string, boolean>;
}

export function passesGate(gate: PermissionGate, permissions: Set<string>): boolean {
  if (gate.type === 'any') {
    return gate.permissions.some((p) => permissions.has(p));
  }

  for (const p of permissions) {
    if (p.startsWith(gate.prefix)) return true;
  }

  return (gate.orAny ?? []).some((p) => permissions.has(p));
}

/** `SubscriptionGate::allows()` — غير المذكور في الباقة مسموح */
export function planAllows(ctx: ModuleResolutionContext, feature: string): boolean {
  if (!ctx.subscriptionLinked) return true;
  if (!(feature in ctx.planPermissions)) return true;
  return Boolean(ctx.planPermissions[feature]);
}

/** `ApplicationRegistry::isPermitted()` — تكفي ميزة واحدة مسموحة */
export function planPermitsModule(ctx: ModuleResolutionContext, registryKey: string | null): boolean {
  if (!registryKey) return true;
  const features = PLAN_FEATURES[registryKey] ?? [];
  if (features.length === 0) return true;
  return features.some((f) => planAllows(ctx, f));
}

/** `ApplicationRegistry::isActive()` */
export function applicationActive(ctx: ModuleResolutionContext, registryKey: string | null): boolean {
  if (!registryKey) return true;
  return (ctx.applicationStatuses[registryKey] ?? 'active') === 'active';
}

/**
 * البطاقات التي يراها هذا المستخدم.
 *
 * - بلا صلاحية ⇒ لا تظهر (كالويب).
 * - معطَّلة من شاشة التطبيقات ⇒ لا تظهر (الويب يخفيها من القوائم).
 * - خارج الباقة ⇒ تظهر مقفلة، كما تعرضها شاشة التطبيقات «مغطّاةً بعلامة القفل».
 */
export function resolveModules(ctx: ModuleResolutionContext): ModuleCard[] {
  return MODULES
    .filter((m) => passesGate(m.gate, ctx.permissions))
    .filter((m) => applicationActive(ctx, m.registryKey))
    .map((m) => {
      const permitted = planPermitsModule(ctx, m.registryKey);
      return {
        key: m.key,
        registryKey: m.registryKey,
        title: m.title,
        subtitle: m.subtitle,
        icon: m.icon,
        color: m.color,
        locked: !permitted,
        lockReason: permitted ? null : 'plan',
        order: m.order,
      } satisfies ModuleCard;
    })
    .sort((a, b) => a.order - b.order);
}
