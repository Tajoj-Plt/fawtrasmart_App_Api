import { Request, Response } from 'express';
import { z } from 'zod';
import { ExchangeUseCases } from '../../../../application/use-cases/sales/ExchangeUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery, uploadedFiles } from '../clients/ClientsController';
import { salesMeta } from './SalesInvoicesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const listSchema = z.object({
  page: id.optional(),
  perPage: id.optional(),
  clientId: id.optional(),
  code: z.string().trim().max(50).optional(),
  branch: id.optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
});

/** تبديل البضاعة — `/sales/exchanges/...` */
export class SalesExchangesController {
  constructor(private readonly exchanges: ExchangeUseCases) {}

  reasons = async (req: Request, res: Response) => {
    ok(res, await this.exchanges.reasons(currentUserId(req), salesMeta(req, 'exchange-reasons')));
  };

  createData = async (req: Request, res: Response) => {
    ok(res, await this.exchanges.createData(currentUserId(req), salesMeta(req, 'exchanges.create-data')));
  };

  index = async (req: Request, res: Response) => {
    ok(res, await this.exchanges.list(currentUserId(req), salesMeta(req, 'exchanges.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.exchanges.show(currentUserId(req), salesMeta(req, 'exchanges.show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.exchanges.store(currentUserId(req), salesMeta(req, 'exchanges.store'), (req.body ?? {}) as Record<string, unknown>, uploadedFiles(req));
    okMessage(res, result.data, result.message, 201);
  };
}
