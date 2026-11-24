import { Request, Response } from 'express';
import { z } from 'zod';
import { NotificationUseCases } from '../../../application/use-cases/notifications/NotificationUseCases';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const listSchema = z.object({
  unread: z.coerce.boolean().default(false),
  last24h: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export const markSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(200) });

export class NotificationsController {
  constructor(private readonly notifications: NotificationUseCases) {}

  listHandler = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    ok(res, await this.notifications.list(currentUserId(req), { unreadOnly: q.unread, last24h: q.last24h, page: q.page, perPage: q.perPage }));
  };

  unreadCountHandler = async (req: Request, res: Response) => {
    ok(res, { count: await this.notifications.unreadCount(currentUserId(req)) });
  };

  markReadHandler = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof markSchema>;
    ok(res, { updated: await this.notifications.markRead(currentUserId(req), body.ids) });
  };

  markAllReadHandler = async (req: Request, res: Response) => {
    ok(res, { updated: await this.notifications.markAllRead(currentUserId(req)) });
  };
}
