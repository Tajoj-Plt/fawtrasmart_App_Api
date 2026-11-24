import { Request, Response } from 'express';
import { z } from 'zod';
import { PriceListUseCases } from '../../../../application/use-cases/stock/PriceListUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { idParam, parseQuery } from '../clients/ClientsController';
import { stockMeta } from './WarehousesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');

const listSchema = z.object({
  page: id.optional(),
  keywords: z.string().trim().max(100).optional(),
  product: id.optional(),
  category: id.optional(),
  brand: id.optional(),
  status: z.coerce.number({ message: 'الحالة 0 أو 1.' }).int().min(0).max(1, 'الحالة 0 أو 1.').optional(),
});

/** قوائم الأسعار — `/stock/price-lists` */
export class PriceListsController {
  constructor(private readonly lists: PriceListUseCases) {}

  index = async (req: Request, res: Response) => {
    ok(res, await this.lists.list(currentUserId(req), stockMeta(req, 'price-lists.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.lists.show(currentUserId(req), stockMeta(req, 'price-lists.show'), idParam(req, 'id')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.lists.store(currentUserId(req), stockMeta(req, 'price-lists.store'), req.body ?? {});
    okMessage(res, result.data, result.message, 201);
  };

  update = async (req: Request, res: Response) => {
    const result = await this.lists.update(currentUserId(req), stockMeta(req, 'price-lists.update'), idParam(req, 'id'), req.body ?? {});
    okMessage(res, null, result.message);
  };

  destroy = async (req: Request, res: Response) => {
    const result = await this.lists.destroy(currentUserId(req), stockMeta(req, 'price-lists.delete'), idParam(req, 'id'));
    okMessage(res, null, result.message);
  };

  addProduct = async (req: Request, res: Response) => {
    const result = await this.lists.addProduct(currentUserId(req), stockMeta(req, 'price-lists.products.store'), idParam(req, 'id'), req.body ?? {});
    okMessage(res, result.data, result.message, 201);
  };

  removeProduct = async (req: Request, res: Response) => {
    const result = await this.lists.removeProduct(currentUserId(req), stockMeta(req, 'price-lists.products.delete'), idParam(req, 'itemId'));
    okMessage(res, null, result.message);
  };
}
