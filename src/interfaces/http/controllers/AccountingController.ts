import { Request, Response } from 'express';
import { z } from 'zod';
import { AccountingUseCases } from '../../../application/use-cases/accounting/AccountingUseCases';
import { AccountingSectionKey } from '../../../domain/services/AccountingCatalog';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
  search: z.string().trim().max(100).optional(),
  period: z.string().trim().max(32).optional(),
  status: z.string().trim().max(32).optional(),
  state: z.string().trim().max(16).optional(),
  kind: z.string().trim().max(16).optional(),
  type: z.string().trim().max(32).optional(),
  parentId: z.coerce.number().int().positive().optional(),
});

/** مسار الـ API ← مفتاح القسم في الكتالوج */
export const SECTION_ROUTES: Record<string, AccountingSectionKey> = {
  expenses: 'expenses',
  incomes: 'incomes',
  treasuries: 'treasuries',
  'journal-entries': 'journal',
  'chart-of-accounts': 'chart',
  'cost-centers': 'cost_centers',
  'payable-cheques': 'payable_cheques',
  'received-cheques': 'received_cheques',
  'cheque-books': 'cheque_books',
};

export class AccountingController {
  constructor(private readonly accounting: AccountingUseCases) {}

  sectionsHandler = async (req: Request, res: Response) => {
    ok(res, await this.accounting.sections(currentUserId(req)));
  };

  periodsHandler = async (_req: Request, res: Response) => {
    ok(res, await this.accounting.periodOptions());
  };

  overviewHandler = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    ok(res, await this.accounting.overview(currentUserId(req), q.period));
  };

  listHandler = (route: string) => async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    ok(res, await this.accounting.list(currentUserId(req), SECTION_ROUTES[route], q));
  };
}

/* ───────────────────────── الإنشاء ───────────────────────── */

import { AccountingFormsUseCases } from '../../../application/use-cases/accounting/AccountingFormsUseCases';

const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');

/** مسار الـ API ← قسم النموذج (نفس مفاتيح القسم عدا القوائم) */
export const FORM_SECTIONS = ['expenses', 'incomes', 'treasuries', 'journal', 'chart', 'cost_centers', 'cheque_books', 'payable_cheques', 'received_cheques'] as const;

export const formOptionsQuery = z.object({ field: z.string().trim().min(1).max(60), q: z.string().trim().max(100).default('') });
export const nextCodeQuery = z.object({ parent_id: z.coerce.number().int().positive().optional() });
export const createBodySchema = z.object({ values: z.record(z.string(), z.unknown()) });

export class AccountingFormsController {
  constructor(private readonly forms: AccountingFormsUseCases) {}

  definition = async (req: Request, res: Response) => {
    ok(res, await this.forms.definition(currentUserId(req), String(req.params.section), langOf(req)));
  };

  options = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof formOptionsQuery>;
    ok(res, await this.forms.searchOptions(currentUserId(req), String(req.params.section), q.field, q.q ?? '', langOf(req)));
  };

  nextCode = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof nextCodeQuery>;
    const kind = req.params.kind === 'chart' ? 'chart' : 'cost_center';
    ok(res, await this.forms.nextCode(currentUserId(req), kind, q.parent_id, langOf(req)));
  };

  checkbook = async (req: Request, res: Response) => {
    ok(res, await this.forms.checkbookInfo(currentUserId(req), Number(req.params.id), langOf(req)));
  };

  create = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof createBodySchema>;
    const result = await this.forms.create(currentUserId(req), String(req.params.section), body.values, langOf(req));
    ok(res, result, 201);
  };
}
