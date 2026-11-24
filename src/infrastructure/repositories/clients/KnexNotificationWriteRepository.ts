import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { NotificationInput, NotificationWriteRepository } from '../../../domain/repositories/clients';
import { toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { conn } from '../../db/KnexUnitOfWork';

/** إدراج صفٍّ في `notifications` — الفحوص (إعدادات النوع وحدّ الباقة) في `NotificationGate` */
export class KnexNotificationWriteRepository implements NotificationWriteRepository {
  private parentColumn: boolean | null = null;

  constructor(private readonly db: Knex) {}

  async supportsParentLink(): Promise<boolean> {
    if (this.parentColumn === null) this.parentColumn = await this.db.schema.hasColumn('notifications', 'parent_id');
    return this.parentColumn;
  }

  async insert(input: NotificationInput, now: Date, tx?: Tx): Promise<number> {
    const stamp = toSqlDateTime(now);
    const row: Record<string, unknown> = {
      user_id: input.userId,
      receiver_id: input.receiverId,
      client_id: input.clientId ?? null,
      title: input.title,
      description: input.description,
      type: input.type,
      read: input.read ? 1 : 0,
      created_at: stamp,
      updated_at: stamp,
    };
    if (input.isSent !== undefined) row.is_sent = input.isSent ? 1 : 0;
    if (input.popupShown !== undefined) row.popup_shown = input.popupShown ? 1 : 0;
    if (input.parentId && (await this.supportsParentLink())) row.parent_id = input.parentId;

    const [id] = await conn(this.db, tx)('notifications').insert(row);
    return Number(id);
  }

  async countCreatedBetween(from: string, to: string): Promise<number> {
    const r = await this.db('notifications').whereBetween('created_at', [from, to]).count<{ c: number }[]>({ c: 'id' }).first();
    return Number((r as { c?: number } | undefined)?.c ?? 0);
  }
}
