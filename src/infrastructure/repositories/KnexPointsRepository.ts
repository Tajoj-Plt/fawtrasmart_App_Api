import { Knex } from 'knex';
import { PointsSummary, PointsTier, PointsTransaction } from '../../domain/entities';
import { PointsRepository } from '../../domain/repositories';

/** نقاط الموظف — نفس استعلامات `EmployeeProfileController::index` */
export class KnexPointsRepository implements PointsRepository {
  constructor(private readonly db: Knex) {}

  private base(employeeId: number) {
    return this.db('points_transactions').where('user_type', 'employee').where('employee_id', employeeId);
  }

  private async sum(qb: Knex.QueryBuilder): Promise<number> {
    const row = await qb.sum<{ s: number | string | null }[]>({ s: 'points' }).first();
    return Math.abs(Number((row as { s?: number | string | null } | undefined)?.s ?? 0));
  }

  async summary(employeeId: number, month: number, year: number): Promise<PointsSummary> {
    try {
      const [monthEarned, monthSpent, totalEarned, totalSpent] = await Promise.all([
        this.sum(this.base(employeeId).where('points_month', month).where('points_year', year).where('points', '>', 0).where('status', 'completed')),
        this.sum(this.base(employeeId).where('points_month', month).where('points_year', year).where('points', '<', 0)),
        this.sum(this.base(employeeId).where('points', '>', 0).where('status', 'completed')),
        this.sum(this.base(employeeId).where('points', '<', 0).where('status', 'completed')),
      ]);
      return { monthEarned, monthSpent, monthNet: Math.max(0, monthEarned - monthSpent), totalEarned, totalSpent };
    } catch {
      return { monthEarned: 0, monthSpent: 0, monthNet: 0, totalEarned: 0, totalSpent: 0 };
    }
  }

  async tiers(): Promise<PointsTier[]> {
    try {
      const rows = await this.db('points_tiers').where('is_active', 1).where('user_type', 'employee').orderBy('sort_order').orderBy('min_points');
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        nameEn: (r.name_en as string | null) ?? null,
        minPoints: Number(r.min_points ?? 0),
        maxPoints: r.max_points === null || r.max_points === undefined ? null : Number(r.max_points),
        color: (r.color as string | null) ?? null,
        icon: (r.icon as string | null) ?? null,
        sortOrder: Number(r.sort_order ?? 0),
      }));
    } catch {
      return [];
    }
  }

  async recent(employeeId: number, month: number, year: number, limit: number): Promise<PointsTransaction[]> {
    try {
      const rows = await this.base(employeeId).where('points_month', month).where('points_year', year).orderBy('created_at', 'desc').limit(limit);
      return rows.map((r) => ({
        id: Number(r.id),
        actionType: String(r.action_type ?? ''),
        points: Number(r.points ?? 0),
        balanceAfter: Number(r.balance_after ?? 0),
        description: (r.description as string | null) ?? null,
        status: String(r.status ?? 'completed'),
        createdAt: r.created_at ? String(r.created_at) : null,
      }));
    } catch {
      return [];
    }
  }
}
