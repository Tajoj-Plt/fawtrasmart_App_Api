import { Request, Response } from 'express';
import { z } from 'zod';
import { ClientUseCases } from '../../../application/use-cases/client/ClientUseCases';
import { ClientSectionKey } from '../../../domain/services/ClientCatalog';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const clientListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(32).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
});

/** مسار الـ API ← مفتاح القسم في الكتالوج */
export const CLIENT_SECTION_ROUTES: Record<string, ClientSectionKey> = {
  clients: 'clients',
  competitors: 'competitors',
  itinerary: 'itinerary',
  'doubtful-debts': 'doubtful_debts',
};

export class ClientModuleController {
  constructor(private readonly client: ClientUseCases) {}

  sectionsHandler = async (req: Request, res: Response) => {
    ok(res, await this.client.sections(currentUserId(req)));
  };

  overviewHandler = async (req: Request, res: Response) => {
    ok(res, await this.client.overview(currentUserId(req)));
  };

  listHandler = (route: string) => async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof clientListQuerySchema>;
    ok(res, await this.client.list(currentUserId(req), CLIENT_SECTION_ROUTES[route], q));
  };
}
