import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../../domain/errors/AppError';
import { logger } from '../../../infrastructure/logger';
import { isProduction } from '../../../config/env';

/** شكل الخطأ الموحَّد: `{ success:false, error:{ code, message, details? } }` */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details ?? undefined } });
  }

  if (err instanceof ZodError) {
    return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.flatten().fieldErrors } });
  }

  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }

  if (anyErr?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'حجم الطلب أكبر من المسموح.' } });
  }

  logger.error({ err, url: req.originalUrl }, 'unhandled error');

  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: isProduction ? 'Internal server error' : anyErr?.message ?? 'Internal server error' },
  });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: 'المسار غير موجود.' } });
}
