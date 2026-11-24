import { Request, Response } from 'express';
import { z } from 'zod';
import { calendarDate } from '../../schemas';
import { RequestMeta } from '../../../../application/services/clients/ClientsContext';
import { labelOf, UploadedFile } from '../../../../application/services/clients/FormInput';
import { ClientNotesUseCases } from '../../../../application/use-cases/clients/ClientNotesUseCases';
import { ClientStatusUseCases } from '../../../../application/use-cases/clients/ClientStatusUseCases';
import { ClientUseCases, LIST_PERIODS } from '../../../../application/use-cases/clients/ClientUseCases';
import { AppError } from '../../../../domain/errors/AppError';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';

const int = (min = 1) => z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(min, `يجب ألّا يقلّ عن ${min}.`);
const date = calendarDate;
const flag = z.enum(['1', '0', 'true', 'false', 'on', 'off']).transform((v) => ['1', 'true', 'on'].includes(v));
const period = z.enum(LIST_PERIODS, { message: 'الفترة غير صالحة.' });

/** فلاتر شاشة العملاء — `validateListFilters()` في الويب */
export const clientListSchema = z
  .object({
    page: int().optional(),
    perPage: int().max(100, 'يجب ألّا يزيد على 100.').optional(),
    search: z.string().trim().max(100).optional(),
    branchId: int().optional(),
    includeDescendants: flag.optional(),
    region: int().optional(),
    client: int().optional(),
    name: z.string().trim().max(255).optional(),
    status: z.union([z.literal('no_status'), int(0)]).optional(),
    registrationStage: int(0).optional(),
    categoryId: int(0).optional(),
    type: z.coerce.number().int().refine((v) => v === 1 || v === 2, 'النوع 1 (فرد) أو 2 (تجاري).').optional(),
    neighborhood: z.string().trim().max(255).optional(),
    employee: int().optional(),
    overCreditLimit: flag.optional(),
    customerTargetId: z.union([z.literal('no_target'), int()]).optional(),
    dateFrom: date.optional(),
    dateTo: date.optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    sort: z.enum(['newest', 'name'], { message: 'الترتيب newest أو name.' }).optional(),
    lastInvoicePeriod: period.optional(),
    lastPaymentPeriod: period.optional(),
    lastActivityPeriod: period.optional(),
  })
  .refine((q) => (q.latitude === undefined) === (q.longitude === undefined), { message: 'أرسل خطّ العرض وخطّ الطول معاً.', path: ['latitude'] });

const pageSchema = z.object({ page: int().optional(), perPage: int().max(100, 'يجب ألّا يزيد على 100.').optional() });
const optionsSchema = z.object({ clientId: int().optional() });
const branchesSchema = z.object({ search: z.string().trim().max(100).optional() });

/** استعلامٌ بقيمٍ عربية الرسائل — القيم الفارغة تُعامل كغائبة (`ConvertEmptyStringsToNull`) */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> {
  const cleaned = Object.fromEntries(Object.entries((query ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v !== undefined));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const details: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.join('.') || '_';
      // رسائل zod الافتراضية إنجليزية — تُستبدل بعربيةٍ تسمّي الحقل
      const message = /[؀-ۿ]/.test(issue.message)
        ? issue.message
        : issue.code === 'too_big' && 'maximum' in issue
          ? `حقل «${labelOf(field)}» يجب ألّا يتجاوز ${issue.maximum}.`
          : `قيمة «${labelOf(field)}» غير صالحة.`;
      (details[field] ??= []).push(message);
    }
    throw AppError.validation(details, Object.values(details)[0]?.[0] ?? 'قيم الطلب غير صالحة.');
  }
  return result.data;
}

export function idParam(req: Request, name: string): number {
  const raw = req.params[name];
  if (!/^\d+$/.test(raw ?? '')) throw AppError.notFound('NOT_FOUND', 'المسار غير موجود.');
  return Number(raw);
}

/** ما يُكتب في السجلّ عن الطلب — IP والمتصفّح واسم المسار */
export function requestMeta(req: Request, route: string, module = 'clients'): RequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    route: `api.${module}.${route}`,
    url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
  };
}

export const uploadedFiles = (req: Request): UploadedFile[] => ((req.files as Express.Multer.File[] | undefined) ?? []) as UploadedFile[];

export class ClientsController {
  constructor(
    private readonly clients: ClientUseCases,
    private readonly statuses: ClientStatusUseCases,
    private readonly notes: ClientNotesUseCases,
  ) {}

  // ── العملاء ──
  index = async (req: Request, res: Response) => {
    ok(res, await this.clients.list(currentUserId(req), requestMeta(req, 'index'), parseQuery(clientListSchema, req.query)));
  };

  map = async (req: Request, res: Response) => {
    ok(res, await this.clients.map(currentUserId(req), requestMeta(req, 'map'), parseQuery(clientListSchema, req.query)));
  };

  options = async (req: Request, res: Response) => {
    const q = parseQuery(optionsSchema, req.query);
    ok(res, await this.clients.options(currentUserId(req), requestMeta(req, 'options'), q.clientId));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.clients.show(currentUserId(req), requestMeta(req, 'show'), idParam(req, 'client')));
  };

  store = async (req: Request, res: Response) => {
    const result = await this.clients.store(currentUserId(req), requestMeta(req, 'store'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.client, result.message, 201);
  };

  update = async (req: Request, res: Response) => {
    const result = await this.clients.update(currentUserId(req), requestMeta(req, 'update'), idParam(req, 'client'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.client, result.message);
  };

  settings = async (req: Request, res: Response) => {
    ok(res, await this.clients.settings(currentUserId(req), requestMeta(req, 'settings')));
  };

  branches = async (req: Request, res: Response) => {
    const q = parseQuery(branchesSchema, req.query);
    ok(res, await this.clients.branches(currentUserId(req), requestMeta(req, 'branches'), q.search));
  };

  // ── الحالة والوضع ──
  statusOptions = async (req: Request, res: Response) => {
    ok(res, await this.statuses.options(currentUserId(req), requestMeta(req, 'status-options'), idParam(req, 'client')));
  };

  updateStatus = async (req: Request, res: Response) => {
    const result = await this.statuses.updateStatus(currentUserId(req), requestMeta(req, 'status'), idParam(req, 'client'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  updateStage = async (req: Request, res: Response) => {
    const result = await this.statuses.updateStage(currentUserId(req), requestMeta(req, 'stage'), idParam(req, 'client'), req.body ?? {});
    okMessage(res, result.data, result.message);
  };

  // ── مسؤولو العميل ──
  contacts = async (req: Request, res: Response) => {
    ok(res, await this.notes.contacts(currentUserId(req), requestMeta(req, 'contacts.index'), idParam(req, 'client')));
  };

  addContact = async (req: Request, res: Response) => {
    const result = await this.notes.addContact(currentUserId(req), requestMeta(req, 'contacts.store'), idParam(req, 'client'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.contact, result.message, 201);
  };

  // ── الملاحظات ──
  notesIndex = async (req: Request, res: Response) => {
    const q = parseQuery(pageSchema, req.query);
    ok(res, await this.notes.list(currentUserId(req), requestMeta(req, 'notes.index'), idParam(req, 'client'), q.page, q.perPage));
  };

  addNote = async (req: Request, res: Response) => {
    const result = await this.notes.add(currentUserId(req), requestMeta(req, 'notes.store'), idParam(req, 'client'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.note, result.message, 201);
  };

  updateNote = async (req: Request, res: Response) => {
    const result = await this.notes.update(currentUserId(req), requestMeta(req, 'notes.update'), idParam(req, 'note'), req.body ?? {}, uploadedFiles(req));
    okMessage(res, result.note, result.message);
  };

  destroyNote = async (req: Request, res: Response) => {
    const result = await this.notes.destroy(currentUserId(req), requestMeta(req, 'notes.destroy'), idParam(req, 'note'));
    okMessage(res, null, result.message);
  };

  destroyNoteAttachment = async (req: Request, res: Response) => {
    const result = await this.notes.destroyAttachment(currentUserId(req), requestMeta(req, 'notes.attachments.destroy'), idParam(req, 'note'), idParam(req, 'index'));
    okMessage(res, { remaining: result.remaining }, result.message);
  };
}
