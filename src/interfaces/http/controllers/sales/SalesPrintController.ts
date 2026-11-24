import { Request, Response } from 'express';
import { PrintTemplateUseCases } from '../../../../application/use-cases/sales/PrintTemplateUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok } from '../../respond';
import { idParam } from '../clients/ClientsController';
import { salesMeta } from './SalesInvoicesController';

const flag = (v: unknown) => v === '1' || v === 'true';
const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');

/** `GET /sales/print/:kind/:id?builtin=1&thermal=1` — مطبوعة المستند بقالب الويب */
export class SalesPrintController {
  constructor(private readonly prints: PrintTemplateUseCases) {}

  html = async (req: Request, res: Response) => {
    const template = Number(req.query.template);
    const visit = Number(req.query.visit);
    ok(
      res,
      await this.prints.html(currentUserId(req), salesMeta(req, 'print'), String(req.params.kind), idParam(req, 'id'), {
        builtin: flag(req.query.builtin),
        thermal: flag(req.query.thermal),
        templateId: Number.isInteger(template) && template > 0 ? template : null,
        visitId: Number.isInteger(visit) && visit > 0 ? visit : null,
        lang: langOf(req),
      }),
    );
  };

  templates = async (req: Request, res: Response) => {
    ok(res, await this.prints.templates(currentUserId(req), salesMeta(req, 'print.templates'), String(req.params.kind), langOf(req)));
  };
}
