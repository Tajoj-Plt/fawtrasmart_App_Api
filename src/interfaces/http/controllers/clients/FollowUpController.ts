import { Request, Response } from 'express';
import { z } from 'zod';
import { calendarDate } from '../../schemas';
import { FollowUpUseCases } from '../../../../application/use-cases/clients/FollowUpUseCases';
import { NotificationDetailUseCases } from '../../../../application/use-cases/clients/NotificationDetailUseCases';
import { TrackingUseCases } from '../../../../application/use-cases/clients/TrackingUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { idParam, parseQuery, requestMeta } from './ClientsController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const forgottenSchema = z.object({ scope: z.enum(['own', 'all'], { message: 'النطاق own أو all.' }).optional() });
const pageSchema = z.object({ page: id.optional(), perPage: id.max(100, 'يجب ألّا يزيد على 100.').optional() });
const pathSchema = z.object({ employeeId: id.optional(), date: calendarDate.optional() });

/** الزيارات المنسيّة وتبريرات الزيارات وتفاصيل الإشعار وتتبّع الموقع */
export class FollowUpController {
  constructor(
    private readonly followUp: FollowUpUseCases,
    private readonly notifications: NotificationDetailUseCases,
    private readonly tracking: TrackingUseCases,
  ) {}

  // ── الزيارات المنسيّة ──
  forgotten = async (req: Request, res: Response) => {
    const q = parseQuery(forgottenSchema, req.query);
    ok(res, await this.followUp.forgottenList(currentUserId(req), requestMeta(req, 'visits.forgotten.index'), q.scope));
  };

  closeForgotten = async (req: Request, res: Response) => {
    const result = await this.followUp.closeForgotten(currentUserId(req), requestMeta(req, 'visits.forgotten.close'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  cancelForgotten = async (req: Request, res: Response) => {
    const result = await this.followUp.cancelForgotten(currentUserId(req), requestMeta(req, 'visits.forgotten.cancel'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  // ── التبريرات ──
  pendingJustifications = async (req: Request, res: Response) => {
    ok(res, await this.followUp.pending(currentUserId(req), requestMeta(req, 'visit-justifications.pending')));
  };

  submitJustifications = async (req: Request, res: Response) => {
    const result = await this.followUp.submit(currentUserId(req), requestMeta(req, 'visit-justifications.submit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  justifications = async (req: Request, res: Response) => {
    const q = parseQuery(pageSchema, req.query);
    ok(res, await this.followUp.index(currentUserId(req), requestMeta(req, 'visit-justifications.index'), q.page, q.perPage));
  };

  justification = async (req: Request, res: Response) => {
    ok(res, await this.followUp.show(currentUserId(req), requestMeta(req, 'visit-justifications.show'), idParam(req, 'visit')));
  };

  updateJustification = async (req: Request, res: Response) => {
    const result = await this.followUp.update(currentUserId(req), requestMeta(req, 'visit-justifications.update'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  // ── الإشعار ──
  notification = async (req: Request, res: Response) => {
    ok(res, await this.notifications.show(currentUserId(req), requestMeta(req, 'notifications.show'), idParam(req, 'notification')));
  };

  replyNotification = async (req: Request, res: Response) => {
    const result = await this.notifications.reply(currentUserId(req), requestMeta(req, 'notifications.reply'), idParam(req, 'notification'), req.body ?? {});
    okMessage(res, result.data, result.message, 201);
  };

  // ── التتبّع ──
  sendLocation = async (req: Request, res: Response) => {
    ok(res, await this.tracking.store(currentUserId(req), requestMeta(req, 'tracking.location'), req.body ?? {}));
  };

  path = async (req: Request, res: Response) => {
    ok(res, await this.tracking.path(currentUserId(req), requestMeta(req, 'tracking.path'), parseQuery(pathSchema, req.query)));
  };

  team = async (req: Request, res: Response) => {
    ok(res, await this.tracking.team(currentUserId(req), requestMeta(req, 'tracking.team')));
  };
}
