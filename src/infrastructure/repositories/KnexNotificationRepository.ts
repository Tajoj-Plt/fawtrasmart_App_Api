import { Knex } from 'knex';
import { Notification } from '../../domain/entities';
import { NotificationListParams, NotificationRepository } from '../../domain/repositories';
import { bool, sqlNow } from '../db/knex';

function map(row: Record<string, unknown>): Notification {
  return {
    id: Number(row.id),
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    read: bool(row.read),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    receiverId: row.receiver_id === null || row.receiver_id === undefined ? null : Number(row.receiver_id),
    type: (row.type as string | null) ?? null,
    parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    createdAt: row.created_at ? String(row.created_at) : null,
    senderName: (row.sender_name as string | null) ?? null,
    receiverName: (row.receiver_name as string | null) ?? null,
  };
}

export class KnexNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Knex) {}

  /** نفس شروط الظهور في `getUnreadNotifications` (المجدولة والفورية) */
  private visible(qb: Knex.QueryBuilder, userId: number, seeAll: boolean, last24h: boolean) {
    const now = sqlNow();

    qb.where((q) => {
      q.where((s) => s.where('n.is_scheduled', 0).orWhereNull('n.is_scheduled'))
        .orWhere((s) => s.where('n.is_scheduled', 1).where((i) => i.where('n.is_sent', 1).orWhere('n.scheduled_at', '<=', now)))
        .orWhere((s) => s.where('n.is_scheduled', 1).where((t) => t.whereNot('n.type', 'general').orWhereNull('n.type')));
    });

    if (last24h) {
      qb.where('n.created_at', '>=', sqlNow(new Date(Date.now() - 24 * 3600 * 1000)));
    }

    if (!seeAll) {
      qb.where((q) => q.where('n.user_id', userId).orWhere('n.receiver_id', userId));
    }

    return qb;
  }

  async list(params: NotificationListParams) {
    const base = this.db('notifications as n');
    this.visible(base, params.userId, params.seeAll, params.last24hOnly);
    if (params.unreadOnly) base.where('n.read', 0);

    const countRow = await base.clone().count<{ c: number }[]>({ c: 'n.id' }).first();
    const total = Number((countRow as { c?: number } | undefined)?.c ?? 0);

    const rows = await base
      .clone()
      .leftJoin('users as s', 's.id', 'n.user_id')
      .leftJoin('users as r', 'r.id', 'n.receiver_id')
      .select('n.*', 's.name as sender_name', 'r.name as receiver_name')
      .orderBy('n.created_at', 'desc')
      .limit(params.perPage)
      .offset((params.page - 1) * params.perPage);

    return { items: rows.map(map), total };
  }

  async unreadCount(userId: number, seeAll: boolean): Promise<number> {
    const qb = this.db('notifications as n').where('n.read', 0);
    this.visible(qb, userId, seeAll, true);
    const row = await qb.count<{ c: number }[]>({ c: 'n.id' }).first();
    return Number((row as { c?: number } | undefined)?.c ?? 0);
  }

  async markRead(ids: number[], userId: number, seeAll: boolean): Promise<number> {
    if (ids.length === 0) return 0;
    const qb = this.db('notifications').whereIn('id', ids).where('read', 0);
    if (!seeAll) qb.where((q) => q.where('user_id', userId).orWhere('receiver_id', userId));
    return qb.update({ read: 1, updated_at: sqlNow() });
  }

  async markAllRead(userId: number, seeAll: boolean): Promise<number> {
    const qb = this.db('notifications').where('read', 0);
    if (!seeAll) qb.where((q) => q.where('user_id', userId).orWhere('receiver_id', userId));
    return qb.update({ read: 1, updated_at: sqlNow() });
  }
}
