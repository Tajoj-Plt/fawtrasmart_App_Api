import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/** يحدّ محاولات الدخول: 20 محاولة لكل IP كل 15 دقيقة */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'محاولات كثيرة، حاول بعد قليل.' } },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'طلبات كثيرة، حاول بعد قليل.' } },
});

/** إرسال الموقع: 30 طلباً في الدقيقة لكل مستخدم — `throttle:30,1` في الويب (بعد `authenticate`) */
export const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.auth?.sub ? `tracking:${req.auth.sub}` : ipKeyGenerator(req.ip ?? '')),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'إرسالٌ كثير للموقع، حاول بعد دقيقة.' } },
});
