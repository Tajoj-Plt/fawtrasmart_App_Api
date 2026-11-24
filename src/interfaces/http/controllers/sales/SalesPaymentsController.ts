import { Request, Response } from 'express';
import { z } from 'zod';
import { PaymentUseCases } from '../../../../application/use-cases/sales/PaymentUseCases';
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
  reference: z.string().trim().max(100).optional(),
  paymentStatus: z.coerce.number().int().min(1).max(5, 'حالة الدفع من 1 إلى 5.').optional(),
  amountFrom: money.optional(),
  amountTo: money.optional(),
  collectedBy: id.optional(),
  treasuryId: id.optional(),
  paymentMethod: id.optional(),
  branch: id.optional(),
  search: z.string().trim().max(100).optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
});

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** سندات القبض على الفواتير — `/sales/payments/...` */
export class SalesPaymentsController {
  constructor(private readonly payments: PaymentUseCases) {}

  createData = async (req: Request, res: Response) => {
    ok(res, await this.payments.createData(currentUserId(req), salesMeta(req, 'payments.create-data')));
  };

  unpaid = async (req: Request, res: Response) => {
    ok(res, await this.payments.unpaid(currentUserId(req), salesMeta(req, 'clients.unpaid-invoices'), idParam(req, 'id')));
  };

  index = async (req: Request, res: Response) => {
    ok(res, await this.payments.list(currentUserId(req), salesMeta(req, 'payments.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.payments.show(currentUserId(req), salesMeta(req, 'payments.show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.payments.store(currentUserId(req), salesMeta(req, 'payments.store'), body(req));
    okMessage(res, result.data, result.message, 201);
  };

  bulk = async (req: Request, res: Response) => {
    const result = await this.payments.bulk(currentUserId(req), salesMeta(req, 'payments.bulk'), body(req));
    okMessage(res, result.data, result.message, 201);
  };
}
