import { Request, Response } from 'express';
import { z } from 'zod';
import { InvoiceTransfersUseCases } from '../../../../application/use-cases/clients/InvoiceTransfersUseCases';
import { AppError } from '../../../../domain/errors/AppError';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { idParam, parseQuery } from './ClientsController';

const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');

const OVERVIEW_QUERY = z.object({
  q: z.string().max(100).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  direction: z.enum(['send', 'request']).optional(),
});

const SENDABLE_QUERY = z.object({ source: z.string().min(1).max(10), receiverId: z.coerce.number().int().positive().optional() });

const SEND_BODY = z.object({
  mode: z.enum(['balance', 'invoices']),
  toEmployeeId: z.coerce.number().int().positive(),
  clientIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  invoiceIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  notes: z.string().max(1000).nullable().optional(),
  visitId: z.coerce.number().int().positive().optional(),
});

const RECEIVE_ALL_BODY = z.object({ clientId: z.coerce.number().int().positive().optional() });

const RESPOND_BODY = z.object({ mode: z.enum(['accept', 'reject']), notes: z.string().max(1000).nullable().optional() });

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of r.error.issues) (errors[issue.path.join('.') || 'body'] ??= []).push(issue.message);
    throw AppError.validation(errors, 'بيانات غير صالحة.');
  }
  return r.data;
}

/** `/api/v1/invoice-transfers/...` — تسليم واستلام الفواتير والأرصدة (شاشة الويب) */
export class InvoiceTransfersController {
  constructor(private readonly transfers: InvoiceTransfersUseCases) {}

  overview = async (req: Request, res: Response) => {
    const q = parseQuery(OVERVIEW_QUERY, req.query);
    ok(res, await this.transfers.overview(currentUserId(req), { q: q.q, client_id: q.clientId, employee_id: q.employeeId, status: q.status, direction: q.direction }, langOf(req)));
  };

  sendable = async (req: Request, res: Response) => {
    const q = parseQuery(SENDABLE_QUERY, req.query);
    ok(res, await this.transfers.sendable(currentUserId(req), q.source, q.receiverId, langOf(req)));
  };

  send = async (req: Request, res: Response) => {
    const r = await this.transfers.send(currentUserId(req), parseBody(SEND_BODY, req.body), langOf(req));
    okMessage(res, null, r.message);
  };

  receiveAll = async (req: Request, res: Response) => {
    const b = parseBody(RECEIVE_ALL_BODY, req.body);
    okMessage(res, null, (await this.transfers.receiveAll(currentUserId(req), langOf(req), b.clientId)).message);
  };

  forClient = async (req: Request, res: Response) => {
    ok(res, await this.transfers.forClient(currentUserId(req), idParam(req, 'clientId'), langOf(req)));
  };

  respondBatch = async (req: Request, res: Response) => {
    const b = parseBody(RESPOND_BODY, req.body);
    okMessage(res, null, (await this.transfers.respondBatch(currentUserId(req), String(req.params.batch), b.mode, b.notes ?? null, langOf(req))).message);
  };

  respond = async (req: Request, res: Response) => {
    const b = parseBody(RESPOND_BODY, req.body);
    okMessage(res, null, (await this.transfers.respond(currentUserId(req), idParam(req, 'id'), b.mode, b.notes ?? null, langOf(req))).message);
  };

  cancel = async (req: Request, res: Response) => {
    okMessage(res, null, (await this.transfers.cancel(currentUserId(req), idParam(req, 'id'), langOf(req))).message);
  };
}
