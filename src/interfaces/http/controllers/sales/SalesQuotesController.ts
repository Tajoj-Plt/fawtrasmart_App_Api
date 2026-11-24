import { Request, Response } from 'express';
import { z } from 'zod';
import { QuoteKind, QuoteUseCases } from '../../../../application/use-cases/sales/QuoteUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery } from '../clients/ClientsController';
import { salesMeta } from './SalesInvoicesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const listSchema = z.object({
  page: id.optional(),
  perPage: id.optional(),
  clientId: id.optional(),
  number: z.string().trim().max(100).optional(),
  status: z.enum(['Draft', 'Pending', 'Approved', 'Converted_to_Invoice', 'Cancelled', 'Expired'], { message: 'الحالة غير معروفة.' }).optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
});
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** عروض الأسعار (`/sales/quotes`) وأوامر البيع (`/sales/sales-orders`) — متحكّمٌ واحد بنوع المستند */
export class SalesQuotesController {
  constructor(
    private readonly quotes: QuoteUseCases,
    private readonly kind: QuoteKind,
  ) {}

  private route(req: Request, action: string) {
    return salesMeta(req, `${this.kind === 'quote' ? 'quotes' : 'sales-orders'}.${action}`);
  }

  index = async (req: Request, res: Response) => {
    ok(res, await this.quotes.list(this.kind, currentUserId(req), this.route(req, 'index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.quotes.show(this.kind, currentUserId(req), this.route(req, 'show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const r = await this.quotes.store(this.kind, currentUserId(req), this.route(req, 'store'), body(req));
    okMessage(res, r.data, r.message, 201);
  };

  update = async (req: Request, res: Response) => {
    const r = await this.quotes.update(this.kind, currentUserId(req), this.route(req, 'update'), idParam(req, 'id'), body(req));
    okMessage(res, r.data, r.message);
  };

  destroy = async (req: Request, res: Response) => {
    const r = await this.quotes.destroy(this.kind, currentUserId(req), this.route(req, 'delete'), idParam(req, 'id'));
    okMessage(res, null, r.message);
  };

  convert = async (req: Request, res: Response) => {
    const r = await this.quotes.convert(this.kind, currentUserId(req), this.route(req, 'convert'), idParam(req, 'id'), body(req));
    okMessage(res, r.data, r.message, 201);
  };
}
