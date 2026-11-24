import { Request, Response } from 'express';
import { z } from 'zod';
import { calendarDate } from '../../schemas';
import { WarehouseUseCases } from '../../../../application/use-cases/stock/WarehouseUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok } from '../../respond';
import { idParam, parseQuery, requestMeta } from '../clients/ClientsController';

/** ما يُكتب في السجلّ عن طلبات المخزون — `api.stock.<route>` */
export const stockMeta = (req: Request, route: string) => requestMeta(req, route, 'stock');

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const date = calendarDate;

const listSchema = z.object({ page: id.optional(), perPage: id.optional(), keywords: z.string().trim().max(100).optional(), status: z.string().trim().max(20).optional() });
const movementsSchema = z.object({
  keywords: z.string().trim().max(100).optional(),
  category: id.optional(),
  operationType: z.enum(['incoming', 'outgoing', 'transfer'], { message: 'نوع العملية incoming أو outgoing أو transfer.' }).optional(),
});
const statementSchema = z.object({
  warehouse: id.optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  periodId: z.string().trim().max(30).optional(),
  product: id.optional(),
  category: id.optional(),
  brand: id.optional(),
  permissionSource: id.optional(),
});

/** المستودعات والكشف المخزني — `/stock/warehouses` و`/stock/statement` */
export class WarehousesController {
  constructor(private readonly warehouses: WarehouseUseCases) {}

  index = async (req: Request, res: Response) => {
    ok(res, await this.warehouses.list(currentUserId(req), stockMeta(req, 'warehouses.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.warehouses.show(currentUserId(req), stockMeta(req, 'warehouses.show'), idParam(req, 'id')));
  };

  movements = async (req: Request, res: Response) => {
    ok(res, await this.warehouses.movements(currentUserId(req), stockMeta(req, 'warehouses.movements'), idParam(req, 'id'), parseQuery(movementsSchema, req.query)));
  };

  statementWarehouses = async (req: Request, res: Response) => {
    ok(res, await this.warehouses.statementWarehouses(currentUserId(req), stockMeta(req, 'statement.warehouses')));
  };

  statement = async (req: Request, res: Response) => {
    ok(res, await this.warehouses.statement(currentUserId(req), stockMeta(req, 'statement.show'), parseQuery(statementSchema, req.query)));
  };
}
