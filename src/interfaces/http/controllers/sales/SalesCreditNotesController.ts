import { Request, Response } from 'express';
import { z } from 'zod';
import { CreditNoteUseCases } from '../../../../application/use-cases/sales/CreditNoteUseCases';
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
  number: z.string().trim().max(100).optional(),
  status: z.coerce.number().int().min(0).max(5, 'الحالة من 0 إلى 5.').optional(),
  branch: id.optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
});
const previewSchema = z.object({ clientId: id, amount: money, invoiceId: id.optional() });
const createDataSchema = z.object({ clientId: id });

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** الإشعارات الدائنة — `/sales/credit-notes/...` */
export class SalesCreditNotesController {
  constructor(private readonly notes: CreditNoteUseCases) {}

  createData = async (req: Request, res: Response) => {
    ok(res, await this.notes.createData(currentUserId(req), salesMeta(req, 'credit-notes.create-data'), parseQuery(createDataSchema, req.query).clientId));
  };

  preview = async (req: Request, res: Response) => {
    ok(res, await this.notes.settlementPreview(currentUserId(req), salesMeta(req, 'credit-notes.settlement-preview'), parseQuery(previewSchema, req.query)));
  };

  index = async (req: Request, res: Response) => {
    ok(res, await this.notes.list(currentUserId(req), salesMeta(req, 'credit-notes.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.notes.show(currentUserId(req), salesMeta(req, 'credit-notes.show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.notes.store(currentUserId(req), salesMeta(req, 'credit-notes.store'), body(req));
    okMessage(res, result.data, result.message, 201);
  };

  cancel = async (req: Request, res: Response) => {
    const result = await this.notes.cancel(currentUserId(req), salesMeta(req, 'credit-notes.cancel'), idParam(req, 'id'));
    okMessage(res, result.data, result.message);
  };
}
