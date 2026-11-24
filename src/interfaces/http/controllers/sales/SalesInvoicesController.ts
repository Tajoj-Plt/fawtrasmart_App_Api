import { Request, Response } from 'express';
import { z } from 'zod';
import { InvoiceCreateUseCase } from '../../../../application/use-cases/sales/InvoiceCreateUseCase';
import { InvoiceQueryUseCases } from '../../../../application/use-cases/sales/InvoiceQueryUseCases';
import { SalesSetupUseCases } from '../../../../application/use-cases/sales/SalesSetupUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery, requestMeta } from '../clients/ClientsController';

/** ما يُكتب في السجلّ عن طلبات المبيعات — `api.sales.<route>` */
export const salesMeta = (req: Request, route: string) => requestMeta(req, route, 'sales');

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const money = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).min(0, 'لا يكون سالباً.').max(99_999_999.99, 'أكبر من المسموح.');
const idList = z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(',')), z.array(id).max(500)).optional();

const listSchema = z.object({
  page: id.optional(),
  perPage: id.optional(),
  clientId: id.optional(),
  invoiceNumber: z.string().trim().max(100).optional(),
  currency: z.string().trim().max(10).optional(),
  branch: id.optional(),
  paymentStatus: z.coerce.number().int().min(1).max(5, 'حالة الدفع من 1 إلى 5.').optional(),
  item: z.string().trim().max(100).optional(),
  totalFrom: money.optional(),
  totalTo: money.optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
  createdBy: id.optional(),
  employeeId: id.optional(),
  dueState: z.enum(['all', 'has_terms', 'overdue', 'due_soon'], { message: 'حالة الاستحقاق all أو has_terms أو overdue أو due_soon.' }).optional(),
});
const catalogSchema = z.object({
  warehouseId: id.optional(),
  search: z.string().trim().max(100).optional(),
  page: id.optional(),
  perPage: id.optional(),
  productIds: idList,
  includeOutOfStock: z.enum(['1', 'true']).optional().transform((v) => v !== undefined),
});
const priceSchema = z.object({ priceListId: id, productId: id });
const couponSchema = z.object({
  code: z.string({ message: 'رمز الكوبون مطلوب.' }).trim().min(1, 'رمز الكوبون مطلوب.').max(64),
  clientId: id.optional(),
  amount: money.optional(),
  productIds: idList,
  shippingCost: money.optional(),
});

/** شاشة فاتورة البيع وقراءة الفواتير — `/sales/...` */
export class SalesInvoicesController {
  constructor(
    private readonly setup: SalesSetupUseCases,
    private readonly invoices: InvoiceQueryUseCases,
    private readonly creator: InvoiceCreateUseCase,
  ) {}

  store = async (req: Request, res: Response) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const result = await this.creator.store(currentUserId(req), salesMeta(req, 'invoices.store'), body);
    okMessage(res, result.data, result.message, 201);
  };

  createData = async (req: Request, res: Response) => {
    ok(res, await this.setup.createData(currentUserId(req), salesMeta(req, 'invoices.create-data')));
  };

  catalog = async (req: Request, res: Response) => {
    ok(res, await this.setup.catalog(currentUserId(req), salesMeta(req, 'catalog'), parseQuery(catalogSchema, req.query)));
  };

  price = async (req: Request, res: Response) => {
    const q = parseQuery(priceSchema, req.query);
    ok(res, await this.setup.price(currentUserId(req), salesMeta(req, 'price'), q.priceListId, q.productId));
  };

  checkCoupon = async (req: Request, res: Response) => {
    ok(res, await this.setup.checkCoupon(currentUserId(req), salesMeta(req, 'coupons.check'), parseQuery(couponSchema, req.body ?? {})));
  };

  index = async (req: Request, res: Response) => {
    ok(res, await this.invoices.list(currentUserId(req), salesMeta(req, 'invoices.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.invoices.show(currentUserId(req), salesMeta(req, 'invoices.show'), idParam(req, 'id')));
  };

  business = async (req: Request, res: Response) => {
    ok(res, await this.invoices.business(currentUserId(req), salesMeta(req, 'business.show')));
  };

  print = async (req: Request, res: Response) => {
    ok(res, await this.invoices.print(currentUserId(req), salesMeta(req, 'invoices.print'), idParam(req, 'id')));
  };
}
