import { Knex } from 'knex';
import { Branch } from '../../domain/entities';
import { BranchRepository } from '../../domain/repositories';
import { bool } from '../db/knex';

const COLUMNS = ['id', 'name', 'code', 'is_main', 'parent_id', 'status', 'city'];

function map(row: Record<string, unknown>): Branch {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    code: String(row.code ?? ''),
    isMain: bool(row.is_main),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    status: Number(row.status ?? 0),
    city: (row.city as string | null) ?? null,
  };
}

export class KnexBranchRepository implements BranchRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: number): Promise<Branch | null> {
    const row = await this.db('branches').select(COLUMNS).where('id', id).first();
    return row ? map(row) : null;
  }

  async active(): Promise<Branch[]> {
    const rows = await this.db('branches').select(COLUMNS).whereNot('status', 1).orderBy('name');
    return rows.map(map);
  }

  async activeByIds(ids: number[]): Promise<Branch[]> {
    if (ids.length === 0) return [];
    const rows = await this.db('branches').select(COLUMNS).whereIn('id', ids).whereNot('status', 1).orderBy('name');
    return rows.map(map);
  }

  async organisationalChildren(rootIds: number[]): Promise<number[]> {
    const all = await this.db('branches').select('id', 'parent_id', 'node_type', 'is_territory');
    const kind = (b: Record<string, unknown>) => (b.node_type as string | null) || (b.is_territory ? 'group' : 'branch');
    const childrenOf = new Map<number, Array<Record<string, unknown>>>();
    for (const b of all) {
      const parent = b.parent_id === null || b.parent_id === undefined ? 0 : Number(b.parent_id);
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), b]);
    }

    const result = rootIds.map(Number);
    let frontier = [...result];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const child of childrenOf.get(id) ?? []) {
          const cid = Number(child.id);
          // فرعٌ محاسبيّ (node_type = branch) لا يُضمّ؛ المجموعات والمنافذ تُضمّ
          if (kind(child) !== 'branch' && !result.includes(cid)) {
            result.push(cid);
            next.push(cid);
          }
        }
      }
      frontier = next;
    }
    return result;
  }

  async descendantIds(branchId: number): Promise<number[]> {
    const result: number[] = [];
    let frontier = [branchId];
    const seen = new Set<number>([branchId]);

    while (frontier.length > 0) {
      const rows: number[] = await this.db('branches').whereIn('parent_id', frontier).pluck('id');
      frontier = rows.map(Number).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
      result.push(...frontier);
    }

    return result;
  }
}
