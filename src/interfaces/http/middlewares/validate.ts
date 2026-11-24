import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';

/** يتحقّق من الجسم/الاستعلام بـ zod ويستبدله بالقيم المنظَّفة */
export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(result.error);
    if (source === 'query') {
      Object.assign(req.query, result.data);
    } else {
      (req as unknown as Record<string, unknown>)[source] = result.data;
    }
    next();
  };
}
