import { Request, Response } from 'express';
import { z } from 'zod';
import { calendarDate } from '../../schemas';
import { ItineraryUseCases } from '../../../../application/use-cases/clients/ItineraryUseCases';
import { VisitUseCases } from '../../../../application/use-cases/clients/VisitUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { idParam, parseQuery, requestMeta, uploadedFiles } from './ClientsController';

const date = calendarDate;
const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');

const daySchema = z.object({ employeeId: id.optional(), date: date.optional() });
const pickerSchema = z.object({ employeeId: id.optional(), date: date.optional(), nodeId: id.optional(), q: z.string().trim().max(100).optional() });

/** خطّ السير اليومي — `/itinerary/*` و`/clients/:client/return-to-itinerary` */
export class ItineraryController {
  constructor(private readonly itinerary: ItineraryUseCases) {}

  day = async (req: Request, res: Response) => {
    ok(res, await this.itinerary.day(currentUserId(req), requestMeta(req, 'itinerary.day'), parseQuery(daySchema, req.query)));
  };

  employees = async (req: Request, res: Response) => {
    ok(res, await this.itinerary.employees(currentUserId(req), requestMeta(req, 'itinerary.employees')));
  };

  picker = async (req: Request, res: Response) => {
    ok(res, await this.itinerary.picker(currentUserId(req), requestMeta(req, 'itinerary.clients'), parseQuery(pickerSchema, req.query)));
  };

  add = async (req: Request, res: Response) => {
    const result = await this.itinerary.add(currentUserId(req), requestMeta(req, 'itinerary.store'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  postpone = async (req: Request, res: Response) => {
    const result = await this.itinerary.postpone(currentUserId(req), requestMeta(req, 'itinerary.postpone'), idParam(req, 'row'));
    okMessage(res, result.data, result.message);
  };

  returnClient = async (req: Request, res: Response) => {
    const result = await this.itinerary.returnClient(currentUserId(req), requestMeta(req, 'return-to-itinerary'), idParam(req, 'client'));
    okMessage(res, result.data, result.message);
  };
}

/** مساحة عمل الزيارة — `/clients/:client/visits/open` و`/visits/:visit/*` */
export class VisitsController {
  constructor(private readonly visits: VisitUseCases) {}

  open = async (req: Request, res: Response) => {
    const result = await this.visits.open(currentUserId(req), requestMeta(req, 'visits.open'), idParam(req, 'client'));
    if (result.message) okMessage(res, result.data, result.message, result.created ? 201 : 200);
    else ok(res, result.data);
  };

  current = async (req: Request, res: Response) => {
    ok(res, await this.visits.current(currentUserId(req), requestMeta(req, 'visits.current')));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.visits.show(currentUserId(req), requestMeta(req, 'visits.show'), idParam(req, 'visit')));
  };

  receipt = async (req: Request, res: Response) => {
    ok(res, await this.visits.receipt(currentUserId(req), requestMeta(req, 'visits.receipt'), idParam(req, 'visit'), idParam(req, 'receipt')));
  };

  start = async (req: Request, res: Response) => {
    const result = await this.visits.start(currentUserId(req), requestMeta(req, 'visits.start'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  togglePause = async (req: Request, res: Response) => {
    const result = await this.visits.togglePause(currentUserId(req), requestMeta(req, 'visits.toggle-pause'), idParam(req, 'visit'));
    okMessage(res, result.data, result.message);
  };

  contact = async (req: Request, res: Response) => {
    const result = await this.visits.storeContact(currentUserId(req), requestMeta(req, 'visits.contact'), idParam(req, 'visit'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.data, result.message, 201);
  };

  contactShift = async (req: Request, res: Response) => {
    const result = await this.visits.storeContactShift(currentUserId(req), requestMeta(req, 'visits.contact-shift'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  note = async (req: Request, res: Response) => {
    const result = await this.visits.storeNote(currentUserId(req), requestMeta(req, 'visits.notes'), idParam(req, 'visit'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.data, result.message, 201);
  };

  competitors = async (req: Request, res: Response) => {
    const result = await this.visits.storeCompetitors(currentUserId(req), requestMeta(req, 'visits.competitors'), idParam(req, 'visit'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.data, result.message);
  };

  quickCompetitor = async (req: Request, res: Response) => {
    const result = await this.visits.storeQuickCompetitor(currentUserId(req), requestMeta(req, 'visits.competitors.quick'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message, result.created ? 201 : 200);
  };

  readNotification = async (req: Request, res: Response) => {
    const result = await this.visits.readNotification(currentUserId(req), requestMeta(req, 'visits.notifications.read'), idParam(req, 'visit'), idParam(req, 'notification'));
    okMessage(res, result.data, result.message);
  };

  replyNotification = async (req: Request, res: Response) => {
    const result = await this.visits.replyNotification(currentUserId(req), requestMeta(req, 'visits.notifications.reply'), idParam(req, 'visit'), idParam(req, 'notification'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  complete = async (req: Request, res: Response) => {
    const result = await this.visits.complete(currentUserId(req), requestMeta(req, 'visits.complete'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  cancel = async (req: Request, res: Response) => {
    const result = await this.visits.cancel(currentUserId(req), requestMeta(req, 'visits.cancel'), idParam(req, 'visit'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };
}
