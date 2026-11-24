import { Request, Response } from 'express';
import { z } from 'zod';
import { AttendanceUseCases } from '../../../../application/use-cases/hr/AttendanceUseCases';
import { AppError } from '../../../../domain/errors/AppError';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';

const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');

const latitude = z.coerce.number({ message: 'خط العرض رقمٌ.' }).min(-90).max(90);
const longitude = z.coerce.number({ message: 'خط الطول رقمٌ.' }).min(-180).max(180);
const accuracy = z.coerce.number().min(0).nullable().optional();

/** الحضور والانصراف بالموقع دائماً — كشاشة الويب (`latitude`/`longitude` مطلوبان) */
const STAMP_BODY = z.object({ latitude, longitude, accuracy });
const BREAK_BODY = z.object({ action: z.enum(['start', 'end']), latitude: latitude.optional(), longitude: longitude.optional(), accuracy });

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of r.error.issues) (errors[issue.path.join('.') || 'body'] ??= []).push(issue.message);
    throw AppError.validation(errors, 'تعذّر تحديد موقعك — فعّل خدمة الموقع وحاول مجدداً.');
  }
  return r.data;
}

/** `/api/v1/hr/attendance/...` — «سجّل حضوري» (شاشة الويب) */
export class AttendanceController {
  constructor(private readonly attendance: AttendanceUseCases) {}

  state = async (req: Request, res: Response) => {
    ok(res, await this.attendance.state(currentUserId(req), langOf(req)));
  };

  checkIn = async (req: Request, res: Response) => {
    const r = await this.attendance.checkIn(currentUserId(req), parseBody(STAMP_BODY, req.body), langOf(req));
    okMessage(res, r.data, r.message);
  };

  checkOut = async (req: Request, res: Response) => {
    const r = await this.attendance.checkOut(currentUserId(req), parseBody(STAMP_BODY, req.body), langOf(req));
    okMessage(res, r.data, r.message);
  };

  toggleBreak = async (req: Request, res: Response) => {
    const { action, ...position } = parseBody(BREAK_BODY, req.body);
    const r = await this.attendance.toggleBreak(currentUserId(req), action, position, langOf(req));
    okMessage(res, r.data, r.message);
  };
}
