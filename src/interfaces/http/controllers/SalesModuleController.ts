import { Request, Response } from 'express';
import { z } from 'zod';
import { SalesUseCases } from '../../../application/use-cases/sales/SalesUseCases';
import { SalesSectionKey } from '../../../domain/services/SalesCatalog';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const salesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(32).optional(),
  period: z.string().trim().max(32).optional(),
});

/** مسار الـ API ← مفتاح القسم في الكتالوج */
export const SALES_SECTION_ROUTES: Record<string, SalesSectionKey> = {
  invoices: 'invoices',
  quotes: 'quotes',
  returns: 'returns',
  'credit-notes': 'credit_notes',
  payments: 'payments',
};

export class SalesModuleController {
  constructor(private readonly sales: SalesUseCases) {}

  sectionsHandler = async (req: Request, res: Response) => {
    ok(res, await this.sales.sections(currentUserId(req)));
  };

  overviewHandler = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof salesListQuerySchema>;
    ok(res, await this.sales.overview(currentUserId(req), q.period));
  };

  listHandler = (route: string) => async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof salesListQuerySchema>;
    ok(res, await this.sales.list(currentUserId(req), SALES_SECTION_ROUTES[route], q));
  };
}
