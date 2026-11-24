import { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

/** نجاحٌ مع رسالةٍ للمستخدم — عمليات الكتابة في وحدة العملاء */
export function okMessage<T>(res: Response, data: T, message: string, status = 200) {
  return res.status(status).json({ success: true, message, data });
}
