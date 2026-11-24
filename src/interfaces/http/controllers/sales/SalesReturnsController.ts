import { Request, Response } from 'express';
import { z } from 'zod';
import { ReturnUseCases } from '../../../../application/use-cases/sales/ReturnUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery } from '../clients/ClientsController';
import { salesMeta } from './SalesInvoicesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const money = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).min(0, 'لا يكون سالباً.').max(99_999_999.99, 'أكبر من المسموح.');

const listSchema = z.object({
  page: id.optional(),
  perPage: id.optional(),
  clientId: id.optional(),
  invoiceNumber: z.string().trim().max(100).optional(),
  branch: id.optional(),
  totalFrom: money.optional(),
  totalTo: money.optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
  createdBy: id.optional(),
  employeeId: id.optional(),
});

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** مرتجعات المبيعات — `/sales/returns/...` */
export class SalesReturnsController {
  constructor(private readonly returns: ReturnUseCases) {}

  createData = async (req: Request, res: Response) => {
    ok(res, await this.returns.createData(currentUserId(req), salesMeta(req, 'returns.create-data'), idParam(req, 'id')));
  };

  index = async (req: Request, res: Response) => {
    ok(res, await this.returns.list(currentUserId(req), salesMeta(req, 'returns.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.returns.show(currentUserId(req), salesMeta(req, 'returns.show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.returns.store(currentUserId(req), salesMeta(req, 'returns.store'), body(req));
    okMessage(res, result.data, result.message, 201);
  };
}
