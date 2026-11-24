import { Request, Response } from 'express';
import { z } from 'zod';
import { StockUseCases } from '../../../application/use-cases/stock/StockUseCases';
import { StockSectionKey } from '../../../domain/services/StockCatalog';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const stockListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(32).optional(),
});

/** مسار الـ API ← مفتاح القسم في الكتالوج */
export const STOCK_SECTION_ROUTES: Record<string, StockSectionKey> = {
  products: 'products',
  warehouses: 'warehouses',
  permits: 'permits',
  adjustments: 'adjustments',
};

export class StockModuleController {
  constructor(private readonly stock: StockUseCases) {}

  sectionsHandler = async (req: Request, res: Response) => {
    ok(res, await this.stock.sections(currentUserId(req)));
  };

  overviewHandler = async (req: Request, res: Response) => {
    ok(res, await this.stock.overview(currentUserId(req)));
  };

  listHandler = (route: string) => async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof stockListQuerySchema>;
    ok(res, await this.stock.list(currentUserId(req), STOCK_SECTION_ROUTES[route], q));
  };
}
