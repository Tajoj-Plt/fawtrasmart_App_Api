import { Request, Response } from 'express';
import { z } from 'zod';
import { PermitApprovalUseCases } from '../../../../application/use-cases/stock/PermitApprovalUseCases';
import { PermitUseCases } from '../../../../application/use-cases/stock/PermitUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery, uploadedFiles } from '../clients/ClientsController';
import { stockMeta } from './WarehousesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');

const listSchema = z.object({
  page: id.optional(),
  perPage: id.optional(),
  status: z.string().trim().max(20).optional(),
  keywords: z.string().trim().max(100).optional(),
  permissionType: id.optional(),
  permissionSource: id.optional(),
  warehouse: id.optional(),
  client: id.optional(),
  supplier: id.optional(),
  currency: z.string().trim().max(10).optional(),
  createdBy: id.optional(),
  product: id.optional(),
  periodId: z.string().trim().max(30).optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
  branch: id.optional(),
});
const createDataSchema = z.object({ type: id.optional() });
const rejectSchema = z.object({ reason: z.string().trim().max(5000, 'سبب الرفض أطول من المسموح.').optional() });

/** الأذون المخزنية — `/stock/permits` */
export class PermitsController {
  constructor(
    private readonly permits: PermitUseCases,
    private readonly approvals: PermitApprovalUseCases,
  ) {}

  index = async (req: Request, res: Response) => {
    const q = parseQuery(listSchema, req.query);
    // `filterCurrency()`: غياب الحقل = عملة النظام، وحضوره فارغاً = كل العملات
    if ('currency' in req.query && q.currency === undefined) q.currency = '';
    ok(res, await this.permits.list(currentUserId(req), stockMeta(req, 'permits.index'), q));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.permits.show(currentUserId(req), stockMeta(req, 'permits.show'), idParam(req, 'id')));
  };

  createData = async (req: Request, res: Response) => {
    ok(res, await this.permits.createData(currentUserId(req), stockMeta(req, 'permits.create-data'), parseQuery(createDataSchema, req.query).type));
  };

  productStock = async (req: Request, res: Response) => {
    ok(res, await this.permits.productStock(currentUserId(req), stockMeta(req, 'permits.product-stock'), idParam(req, 'warehouseId'), idParam(req, 'productId')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.permits.store(currentUserId(req), stockMeta(req, 'permits.store'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.data, result.message, 201);
  };

  update = async (req: Request, res: Response) => {
    const result = await this.permits.update(currentUserId(req), stockMeta(req, 'permits.update'), idParam(req, 'id'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, null, result.message);
  };

  destroy = async (req: Request, res: Response) => {
    const result = await this.permits.destroy(currentUserId(req), stockMeta(req, 'permits.delete'), idParam(req, 'id'));
    okMessage(res, null, result.message);
  };

  reject = async (req: Request, res: Response) => {
    // سبب الرفض من الجسم أو الاستعلام — والاسم القديم `rejectionReason` مقبول
    const source = { ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) ?? {}) };
    const { reason } = parseQuery(rejectSchema, { reason: source.reason ?? source.rejectionReason });
    const result = await this.permits.reject(currentUserId(req), stockMeta(req, 'permits.reject'), idParam(req, 'id'), reason ?? null);
    okMessage(res, null, result.message);
  };

  approve = async (req: Request, res: Response) => {
    const result = await this.approvals.approve(currentUserId(req), stockMeta(req, 'permits.approve'), idParam(req, 'id'));
    okMessage(res, result.data, result.message);
  };

  cancelApproval = async (req: Request, res: Response) => {
    const result = await this.approvals.cancelApproval(currentUserId(req), stockMeta(req, 'permits.cancel-approval'), idParam(req, 'id'));
    okMessage(res, result.data, result.message);
  };
}
