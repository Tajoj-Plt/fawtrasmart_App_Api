/**
 * شجرة الفروع (فروع، مناطق، مجموعات، منافذ) — منطق `App\Models\Branch` و
 * `App\Support\AffiliationTree` على قائمةٍ محمَّلة مرّةً واحدة، بدل استعلامٍ
 * لكل صعودٍ أو نزولٍ في الشجرة.
 */

export interface TreeNode {
  id: number;
  name: string;
  code: string | null;
  parentId: number | null;
  nodeType: string | null;
  isTerritory: boolean;
  territoryOfficeId: number | null;
  isMain: boolean;
  status: number | null;
}

export type NodeTypeKey = 'branch' | 'region' | 'group' | 'outlet';

const TYPE_LABELS: Record<string, string> = { branch: 'فرع', region: 'منطقة', group: 'مجموعة', outlet: 'منفذ' };

export class BranchTree {
  private readonly byId = new Map<number, TreeNode>();
  private readonly children = new Map<number, TreeNode[]>();

  constructor(private readonly nodes: TreeNode[]) {
    for (const n of nodes) this.byId.set(n.id, n);
    for (const n of [...nodes].sort((a, b) => a.id - b.id)) {
      const parent = n.parentId ?? 0;
      this.children.set(parent, [...(this.children.get(parent) ?? []), n]);
    }
  }

  all(): TreeNode[] {
    return this.nodes;
  }

  find(id: number | null | undefined): TreeNode | null {
    return id ? this.byId.get(Number(id)) ?? null : null;
  }

  childrenOf(id: number): TreeNode[] {
    return this.children.get(id) ?? [];
  }

  /** `descendantBranchIds()` — كل الأعماق، بلا العقدة نفسها */
  descendantIds(id: number): number[] {
    const out: number[] = [];
    let frontier = [id];
    const seen = new Set<number>([id]);
    while (frontier.length) {
      const next: number[] = [];
      for (const f of frontier) {
        for (const c of this.childrenOf(f)) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push(c.id);
            next.push(c.id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** `AffiliationTree::descendantIds()` — العقدة وما تحتها (أو العقدة وحدها إن لم توجد) */
  subtree(id: number): number[] {
    return this.find(id) ? [id, ...this.descendantIds(id)] : [id];
  }

  /** الأسلاف من الأب إلى الجذر */
  ancestors(id: number): TreeNode[] {
    const list: TreeNode[] = [];
    let cursor = this.find(id)?.parentId ?? null;
    let guard = 0;
    while (cursor && guard++ < 50) {
      const parent = this.find(cursor);
      if (!parent) break;
      list.push(parent);
      cursor = parent.parentId;
    }
    return list;
  }

  lineageFromRoot(id: number): TreeNode[] {
    const node = this.find(id);
    return node ? [...this.ancestors(id).reverse(), node] : [];
  }

  lineagePathLabel(id: number, separator = ' ← '): string | null {
    const lineage = this.lineageFromRoot(id);
    return lineage.length ? lineage.map((n) => n.name).join(separator) : null;
  }

  static nodeTypeKey(node: TreeNode): string {
    return node.nodeType || (node.isTerritory ? 'group' : 'branch');
  }

  static typeLabel(key: string | null | undefined): string {
    return TYPE_LABELS[key ?? 'branch'] ?? TYPE_LABELS.branch;
  }

  /** `Branch::displayNodeType()` — يصحّح «مجموعة» المخزَّنة وهي منطقةٌ أو منفذ */
  displayNodeType(node: TreeNode): string {
    const stored = BranchTree.nodeTypeKey(node);
    if (stored !== 'group') return stored;

    const name = node.name.replace(/\s+/gu, ' ').trim();
    if (name.startsWith('منطقة')) return 'region';
    if (name.startsWith('منفذ')) return 'outlet';
    if (node.parentId === null && this.childrenOf(node.id).some((c) => c.nodeType === 'branch')) return 'region';
    return 'group';
  }

  isAccountingBranch(node: TreeNode): boolean {
    return BranchTree.nodeTypeKey(node) === 'branch';
  }

  mainId(): number | null {
    return this.nodes.find((n) => n.isMain)?.id ?? null;
  }

  rootOf(id: number): TreeNode | null {
    const lineage = this.lineageFromRoot(id);
    return lineage[0] ?? null;
  }

  /** `Branch::resolveAccountingBranchId()` — الفرع المحاسبي للعقدة */
  resolveAccountingBranchId(id: number): number | null {
    const node = this.find(id);
    if (!node) return null;
    if (this.isAccountingBranch(node)) return node.id;
    for (const a of this.ancestors(id)) if (this.isAccountingBranch(a)) return a.id;
    if (node.territoryOfficeId) return node.territoryOfficeId;
    return this.mainId() ?? this.rootOf(id)?.id ?? null;
  }

  /** `Branch::resolveTerritoryBranchForNeighborhood()` — المنطقة التي يُنسب إليها حيّ العميل */
  resolveTerritoryForNeighborhood(id: number): number {
    const node = this.find(id);
    if (!node) return id;
    if (node.isTerritory) return node.id;
    for (const a of this.ancestors(id)) if (a.isTerritory) return a.id;

    const queue = [id];
    const visited = new Set<number>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of this.childrenOf(current)) {
        if (child.isTerritory) return child.id;
        queue.push(child.id);
      }
    }

    const fallback = [...this.nodes].sort((a, b) => a.id - b.id).find((n) => n.isTerritory && n.territoryOfficeId === id);
    return fallback ? fallback.id : id;
  }

  /** `AffiliationTree::withOrganisationalChildren()` — تُضمّ المجموعات والمنافذ لا الفروع المحاسبية */
  withOrganisationalChildren(ids: number[] | null): number[] | null {
    if (ids === null) return null;
    const result = ids.map(Number);
    let frontier = [...result];
    while (frontier.length) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const child of this.childrenOf(id)) {
          if (!this.isAccountingBranch(child) && !result.includes(child.id)) {
            result.push(child.id);
            next.push(child.id);
          }
        }
      }
      frontier = next;
    }
    return result;
  }

  /** `ItineraryWeekService::placeOf()` — المنطقة والفرع والوحدة التي تقع فيها العقدة */
  placeOf(id: number | null): { region: string | null; branch: string | null; unit: string | null } {
    let region: string | null = null;
    let branch: string | null = null;
    let unit: string | null = null;
    let cursor = id;
    let guard = 0;
    while (cursor && this.byId.has(cursor) && guard++ < 20) {
      const node = this.byId.get(cursor)!;
      const type = this.displayNodeType(node);
      if (branch === null && region === null && (type === 'outlet' || type === 'group')) unit ??= node.name;
      region ??= type === 'region' ? node.name : null;
      branch ??= type === 'branch' ? node.name : null;
      cursor = node.parentId;
    }
    return { region, branch, unit };
  }

  /** `AffiliationTree::pathOptions()` — المسار من الجذر ونوع العقدة المعروض */
  pathOptions(nodes: TreeNode[] = this.nodes): Array<{ id: number; name: string; label: string; nodeType: string; displayType: string; typeLabel: string; depth: number }> {
    return nodes
      .map((node) => {
        const labels = this.lineageFromRoot(node.id).map((n) => n.name);
        const shown = this.displayNodeType(node);
        const typeLabel = BranchTree.typeLabel(shown);
        return {
          id: node.id,
          name: node.name,
          label: `${labels.join(' ← ')} — ${typeLabel}`,
          nodeType: BranchTree.nodeTypeKey(node),
          displayType: shown,
          typeLabel,
          depth: labels.length - 1,
          sortKey: labels.join('\u0001'),
        };
      })
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
      .map(({ sortKey: _s, ...rest }) => rest);
  }
}
