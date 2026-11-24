import { LocalizedText } from './ModuleCatalog';

/**
 * أساسٌ عام لكتالوج قائمة جانبية بحارسٍ ثلاثي — كما في `AccountingCatalog.ts` — كي لا تتكرّر
 * `evaluateItem`/`resolveSections`/`findItem` في كل وحدة (Accounting, Client, Stock, Sales).
 * كل وحدة تعرّف مفاتيحها الخاصة وتبني كتالوجها فوق هذه الدوال العامة.
 */

export interface AccessContext {
  permissions: Set<string>;
  applicationStatuses: Record<string, 'active' | 'inactive'>;
  subscriptionLinked: boolean;
  planPermissions: Record<string, boolean>;
}

export interface CatalogItemDef<K extends string> {
  key: K;
  title: LocalizedText;
  icon: string;
  /** يكفي واحدة منها؛ لاحقة بنقطة (`x.`) تعني أي صلاحية تبدأ بها */
  permissions: string[];
  /** مفتاح ميزة الباقة؛ null = بلا باقة (كوحدة العملاء التي لا حدود فوترة عليها) */
  planFeature: string | null;
  /** صلاحية الإنشاء؛ غيابها = القسم للعرض فقط. مصفوفةٌ = تكفي واحدةٌ منها (كأذون المخزون الأربعة) */
  createPermission?: string | string[];
}

export interface CatalogGroupDef<K extends string> {
  key: string;
  title: LocalizedText;
  /** مفتاح ApplicationRegistry للمجموعة؛ null = بلا مفتاح */
  registryKey: string | null;
  items: Array<CatalogItemDef<K>>;
}

export interface CatalogItem<K extends string> {
  key: K;
  title: LocalizedText;
  icon: string;
  locked: boolean;
  canCreate: boolean;
}

export interface CatalogGroup<K extends string> {
  key: string;
  title: LocalizedText;
  items: Array<CatalogItem<K>>;
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

export function findCatalogItem<K extends string>(groups: Array<CatalogGroupDef<K>>, key: string): { group: CatalogGroupDef<K>; item: CatalogItemDef<K> } | null {
  for (const group of groups) {
    const item = group.items.find((i) => i.key === key);
    if (item) return { group, item };
  }
  return null;
}

/** هل يُسمح بهذا البند؟ (`visible` = يظهر في القائمة، `locked` = خارج الباقة) */
export function evaluateCatalogItem<K extends string>(group: CatalogGroupDef<K>, item: CatalogItemDef<K>, ctx: AccessContext) {
  const visible = registryActive(ctx, group.registryKey) && hasAny(ctx.permissions, item.permissions);
  const locked = visible && !planAllows(ctx, item.planFeature);
  return { visible, locked };
}

/** القائمة الجانبية التي يراها هذا الدور — المجموعة الفارغة تُحذف كما تُخفى في الويب */
/** يملك صلاحية الإنشاء؟ (سلسلةٌ واحدة، أو أي واحدةٍ من مصفوفة) */
export function hasCreatePermission<K extends string>(item: CatalogItemDef<K>, ctx: AccessContext): boolean {
  if (!item.createPermission) return false;
  const wanted = Array.isArray(item.createPermission) ? item.createPermission : [item.createPermission];
  return wanted.some((p) => ctx.permissions.has(p));
}

export function resolveCatalogSections<K extends string>(groups: Array<CatalogGroupDef<K>>, ctx: AccessContext): Array<CatalogGroup<K>> {
  const result: Array<CatalogGroup<K>> = [];

  for (const group of groups) {
    const items: Array<CatalogItem<K>> = [];

    for (const item of group.items) {
      const { visible, locked } = evaluateCatalogItem(group, item, ctx);
      if (visible) {
        items.push({ key: item.key, title: item.title, icon: item.icon, locked, canCreate: !locked && hasCreatePermission(item, ctx) });
      }
    }

    if (items.length > 0) result.push({ key: group.key, title: group.title, items });
  }

  return result;
}
