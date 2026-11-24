import { Request, Response } from 'express';
import { z } from 'zod';
import { ClientFormsUseCases } from '../../../application/use-cases/client/ClientFormsUseCases';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export const CLIENT_FORM_OPTIONS_QUERY = z.object({ field: z.string().trim().min(1).max(60), q: z.string().trim().max(100).default('') });
export const CLIENT_NEXT_CODE_QUERY = z.object({ parent_id: z.coerce.number().int().positive().optional() });
export const CLIENT_CREATE_BODY = z.object({ values: z.record(z.string(), z.unknown()) });

const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');

export class ClientFormsController {
  constructor(private readonly forms: ClientFormsUseCases) {}

  definition = async (req: Request, res: Response) => {
    ok(res, await this.forms.definition(currentUserId(req), String(req.params.section), langOf(req)));
  };

  options = async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof CLIENT_FORM_OPTIONS_QUERY>;
    ok(res, await this.forms.searchOptions(currentUserId(req), String(req.params.section), q.field, q.q ?? '', langOf(req)));
  };

  create = async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof CLIENT_CREATE_BODY>;
    ok(res, await this.forms.create(currentUserId(req), String(req.params.section), body.values, langOf(req)), 201);
  };
}
