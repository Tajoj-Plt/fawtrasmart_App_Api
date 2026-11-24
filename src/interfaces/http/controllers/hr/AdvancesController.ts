import { Request, Response } from 'express';
import { z } from 'zod';
import { AdvanceSource, AdvanceUseCases } from '../../../../application/use-cases/hr/AdvanceUseCases';
import { ADVANCE_STAGES } from '../../../../domain/services/hr/HrConstants';
import { currentUserId } from '../../middlewares/auth';
import { calendarDate } from '../../schemas';
import { ok, okMessage } from '../../respond';
import { idParam, parseQuery } from '../clients/ClientsController';
import { boolFlag, hrMeta, pageInt, perPageInt, searchText } from './HrController';

const listSchema = z.object({
  page: pageInt.optional(),
  perPage: perPageInt.optional(),
  stage: z.enum(ADVANCE_STAGES, { message: 'المرحلة غير صالحة.' }).optional(),
  search: searchText,
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  mine: boolFlag.optional(),
});

const showSchema = z.object({ source: z.enum(['request', 'legacy'], { message: 'المصدر request أو legacy.' }).optional() });

/** السلف — `/hr/advances` */
export class AdvancesController {
  constructor(private readonly advances: AdvanceUseCases) {}

  index = async (req: Request, res: Response) => {
    ok(res, await this.advances.list(currentUserId(req), hrMeta(req, 'advances.index'), parseQuery(listSchema, req.query)));
  };

  createData = async (req: Request, res: Response) => {
    ok(res, await this.advances.createData(currentUserId(req), hrMeta(req, 'advances.create')));
  };

  show = async (req: Request, res: Response) => {
    const source = (parseQuery(showSchema, req.query).source ?? 'request') as AdvanceSource;
    ok(res, await this.advances.show(currentUserId(req), hrMeta(req, 'advances.show'), idParam(req, 'id'), source));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.advances.store(currentUserId(req), hrMeta(req, 'advances.store'), (req.body ?? {}) as Record<string, unknown>);
    okMessage(res, result.data, result.message, 201);
  };

  withdraw = async (req: Request, res: Response) => {
    const result = await this.advances.withdraw(currentUserId(req), hrMeta(req, 'advances.withdraw'), idParam(req, 'id'));
    okMessage(res, result.data, result.message);
  };
}
