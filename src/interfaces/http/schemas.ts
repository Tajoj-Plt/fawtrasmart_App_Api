import { z } from 'zod';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** تاريخٌ حقيقي بصيغة `YYYY-MM-DD` — قاعدة `date` في الويب: ٣٠ فبراير والشهر ١٣ مرفوضان */
export const calendarDate = z
  .string()
  .regex(DATE, 'التاريخ بصيغة YYYY-MM-DD.')
  .refine((v) => {
    // zod يُكمل الفحوص بعد فشل النمط — فالصيغة الخاطئة يُبلَّغ عنها هناك لا هنا
    const parts = DATE.exec(v);
    if (!parts) return true;
    const [, y, m, d] = parts.map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'التاريخ غير صالح.');
