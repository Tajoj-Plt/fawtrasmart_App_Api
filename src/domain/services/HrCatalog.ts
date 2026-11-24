import { CatalogGroupDef, findCatalogItem, resolveCatalogSections } from './catalogKit';
import { HR_PERMISSIONS, HR_PLAN, SALARIES_MODULE } from './hr/HrConstants';
export type { AccessContext } from './catalogKit';

/**
 * أقسام الموارد البشرية في التطبيق — ما تفتحه شاشاتُ «الرواتب والمستحقات» في
 * الويب بصلاحياتها نفسِها (`HrPermissions`) وميزات باقتها (`HrPlanFeatures`).
 * المجموعةُ كلُّها تحت مفتاح التطبيق `salaries`، فتعطيلُه من شاشة التطبيقات
 * يُخفيها كما يُخفيها الويب.
 *
 * و«سجّل حضوري» تحت مفتاح التطبيق `employee_attendance` وميزة الباقة `hr_attendance` وصلاحيته
 * `attendance_registration.mobile` — كمسار `hr.field-attendance.*` في الويب.
 *
 * ما لا منفذ له بعد (الإجازات والعقود والتأمينات ومكافأة نهاية الخدمة والتقارير) غيرُ مُدرج.
 */

export type HrSectionKey = 'overview' | 'attendance' | 'advanceRequests' | 'advances' | 'deductions' | 'salarySlips' | 'payslips';

/** «سجّل حضوري» — مفتاح التطبيق وميزة الباقة والصلاحية كما في الويب */
export const ATTENDANCE_ACCESS = { registryKey: 'employee_attendance', planFeature: 'hr_attendance', permission: 'attendance_registration.mobile' } as const;

/** حارسُ «نظرة عامة» — تكفي صلاحيةُ قسمٍ واحدٍ من الأقسام أدناه */
export const HR_OVERVIEW_PERMISSIONS = [
  HR_PERMISSIONS.advanceCreate,
  HR_PERMISSIONS.advancesIndex,
  HR_PERMISSIONS.deductionsIndex,
  HR_PERMISSIONS.salarySlipsIndex,
  HR_PERMISSIONS.payslipsIndex,
];

const HR_GROUPS: Array<CatalogGroupDef<HrSectionKey>> = [
  {
    key: 'home',
    title: { ar: 'الرئيسية', en: 'Home' },
    registryKey: null,
    items: [{ key: 'overview', title: { ar: 'نظرة عامة', en: 'Overview' }, icon: 'layout-dashboard', permissions: HR_OVERVIEW_PERMISSIONS, planFeature: null }],
  },
  {
    key: 'attendance',
    title: { ar: 'الحضور', en: 'Attendance' },
    registryKey: ATTENDANCE_ACCESS.registryKey,
    items: [{ key: 'attendance', title: { ar: 'سجّل حضوري', en: 'My attendance' }, icon: 'clock', permissions: [ATTENDANCE_ACCESS.permission], planFeature: ATTENDANCE_ACCESS.planFeature }],
  },
  {
    key: 'salaries',
    title: { ar: 'الرواتب والمستحقات', en: 'Payroll' },
    registryKey: SALARIES_MODULE.key,
    items: [
      {
        key: 'advanceRequests',
        title: { ar: 'طلبات السلف', en: 'Advance requests' },
        icon: 'arrow-up-circle',
        permissions: [HR_PERMISSIONS.advanceCreate],
        planFeature: HR_PLAN.advances,
        createPermission: HR_PERMISSIONS.advanceCreate,
      },
      { key: 'advances', title: { ar: 'إدارة السلف', en: 'Advances' }, icon: 'dollar-sign', permissions: [HR_PERMISSIONS.advancesIndex], planFeature: HR_PLAN.advances },
      { key: 'deductions', title: { ar: 'الخصومات والجزاءات', en: 'Deductions' }, icon: 'minus-circle', permissions: [HR_PERMISSIONS.deductionsIndex], planFeature: HR_PLAN.deductions },
      // «قسيمة الراتب» اتفاقُ راتبٍ مستمرّ لا شهرٌ بعينه — الشهرُ في «سجلات الصرف» أدناه
      { key: 'salarySlips', title: { ar: 'قسائم الرواتب', en: 'Salary agreements' }, icon: 'file-text', permissions: [HR_PERMISSIONS.salarySlipsIndex], planFeature: HR_PLAN.payslips },
      { key: 'payslips', title: { ar: 'سجلات الصرف', en: 'Monthly payslips' }, icon: 'credit-card', permissions: [HR_PERMISSIONS.payslipsIndex], planFeature: HR_PLAN.payroll },
    ],
  },
];

export function findHrItem(key: string) {
  return findCatalogItem(HR_GROUPS, key);
}

export function resolveHrSections(ctx: import('./catalogKit').AccessContext) {
  return resolveCatalogSections(HR_GROUPS, ctx);
}

export type HrGroup = ReturnType<typeof resolveHrSections>[number];
