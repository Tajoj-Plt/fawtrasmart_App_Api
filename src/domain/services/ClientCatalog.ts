import { CatalogGroupDef, CatalogItem, findCatalogItem, resolveCatalogSections } from './catalogKit';
export type { AccessContext } from './catalogKit';

/**
 * أقسام وحدة العملاء — ترجمة القائمة الجانبية في الويب (`Modules/Client/resources/views/layouts/sidebar.blade.php`)
 * لما له شاشةٌ في التطبيق: دليل العملاء وخريطتهم، خطّ السير اليومي، الزيارات المنسيّة، التبريرات،
 * تتبّع الفريق، والمنافسون والديون المشكوك فيها (عرضاً). الحجوزات والمحفظة والتقارير خارج هذه النسخة.
 *
 * الحارس في كل بند هو صلاحية بند الويب المقابل، مقصورةً على ما تقبله واجهة `/api/v1` نفسها
 * (كي لا يظهر بندٌ يردّ ضاغطَه بـ403). مفاتيح `client_module_settings` (خطّ السير، التتبّع،
 * الديون المشكوك فيها) تُفحص في `ClientAccess` وفي `GET clients/settings` لا هنا.
 *
 * لا حدود باقة على وحدة العملاء في الويب (`ClientsPlanFeatures::hasPlanLimit()` ثابتة `false`)،
 * فكل بند هنا `planFeature: null` — الحارس صلاحيةٌ + مفتاح تطبيقٍ فقط، لا باقة.
 */

export type ClientSectionKey =
  | 'overview'
  | 'clients'
  | 'clients_map'
  | 'itinerary'
  | 'forgotten_visits'
  | 'visit_justifications'
  | 'team_tracking'
  | 'competitors'
  | 'invoice_transfers'
  | 'doubtful_debts';

/** صلاحيات عرض العملاء كما يفحصها `GET clients` و`GET clients/map` */
const VIEW_CLIENTS = ['clients_view_all_clients', 'clients_view_own_clients', 'clients_view_by_employee_groups', 'clients_view_by_daily_itinerary'];

const CLIENT_GROUPS: Array<CatalogGroupDef<ClientSectionKey>> = [
  {
    key: 'home',
    title: { ar: 'الرئيسية', en: 'Home' },
    registryKey: null,
    // «لوحة العملاء» — hasPermission('clients_dashboard_view|clients_view_all_clients')
    items: [{ key: 'overview', title: { ar: 'نظرة عامة', en: 'Overview' }, icon: 'layout-dashboard', permissions: ['clients_dashboard_view', 'clients_view_all_clients'], planFeature: null }],
  },
  {
    key: 'clients',
    title: { ar: 'العملاء', en: 'Clients' },
    registryKey: 'customers',
    items: [
      // «إدارة العملاء» + «أضف عميل جديد» (`clients_add_client`)
      { key: 'clients', title: { ar: 'إدارة العملاء', en: 'Customer directory' }, icon: 'users', permissions: VIEW_CLIENTS, planFeature: null, createPermission: 'clients_add_client' },
      // خريطة العملاء جزءٌ من شاشة «إدارة العملاء» في الويب — بصلاحيتها نفسها
      { key: 'clients_map', title: { ar: 'خريطة العملاء', en: 'Clients map' }, icon: 'map', permissions: VIEW_CLIENTS, planFeature: null },
      { key: 'competitors', title: { ar: 'المنافسون', en: 'Competitors' }, icon: 'swords', permissions: ['clients_competitors_view'], planFeature: null, createPermission: 'clients_competitors_add' },
      // «تحويلات الفواتير» — `invoice-transfers.index` بصلاحية `clients_invoice_transfer_view`
      { key: 'invoice_transfers', title: { ar: 'تسليم واستلام الفواتير', en: 'Invoice & balance handovers' }, icon: 'repeat', permissions: ['clients_invoice_transfer_view'], planFeature: null },
    ],
  },
  {
    key: 'itinerary',
    title: { ar: 'خط السير والزيارات', en: 'Itinerary & visits' },
    registryKey: 'customers',
    items: [
      // «خط سيري اليومي» — hasPermission('clients_daily_itinerary_view|clients_daily_itinerary_add_for_others')
      { key: 'itinerary', title: { ar: 'خط سيري اليومي', en: 'My daily itinerary' }, icon: 'target', permissions: ['clients_daily_itinerary_view', 'clients_daily_itinerary_add_for_others'], planFeature: null },
      // «خط السير» (خريطة الفريق ومساراته) — can('clients_itinerary_view')
      { key: 'team_tracking', title: { ar: 'تتبّع الفريق على الخريطة', en: 'Team tracking' }, icon: 'arrow-up-right', permissions: ['clients_itinerary_view'], planFeature: null },
      // «الزيارات الجارية» — صلاحيتا العرض اللتان تقبلهما `GET visits/forgotten`
      { key: 'forgotten_visits', title: { ar: 'الزيارات المنسيّة', en: 'Forgotten visits' }, icon: 'file-minus', permissions: ['clients_view_forgotten_visits_own', 'clients_view_forgotten_visits_all'], planFeature: null },
      // «تبريراتي» — hasPermission('clients_visit_justifications_view_own|clients_visit_justifications_view_all')
      {
        key: 'visit_justifications',
        title: { ar: 'تبريراتي', en: 'My justifications' },
        icon: 'book-open',
        permissions: ['clients_visit_justifications_view_own', 'clients_visit_justifications_view_all'],
        planFeature: null,
      },
    ],
  },
  {
    key: 'financial',
    title: { ar: 'الديون المشكوك فيها', en: 'Doubtful debts' },
    registryKey: 'customers',
    items: [{ key: 'doubtful_debts', title: { ar: 'الديون المشكوك فيها', en: 'Doubtful debts' }, icon: 'alert-triangle', permissions: ['doubtful_debts_view'], planFeature: null }],
  },
];

export function findClientItem(key: string) {
  return findCatalogItem(CLIENT_GROUPS, key);
}

export function resolveClientSections(ctx: import('./catalogKit').AccessContext) {
  return resolveCatalogSections(CLIENT_GROUPS, ctx);
}

export type ClientGroup = ReturnType<typeof resolveClientSections>[number];
export type { CatalogItem };
