/**
 * ترجمة `App\Helpers\WeekHelper::getWeekAndYear()`/`getCurrentDayNameEn()` — الأسبوع يبدأ سبتاً
 * وينتهي جمعة، ويلزم مطابقة الحساب حرفياً لأن `employee_client_visits` تُخزَّن بهذا الترقيم بالضبط.
 *
 * انحرافٌ متعمَّد: النسخة الويب تستعمل `Carbon::diffInDays()` بفارق كسريٍّ (يحمل جزء اليوم من وقت
 * `now()`)، فتنزلق رقم الأسبوع أحياناً بحسب ساعة الاستدعاء قرب حدّ /7 — أثرٌ جانبي لا قصدٌ. هنا
 * الفرق بالأيام الكاملة (منتصف الليل لكلا الطرفين) وهو الحساب الصحيح تقويمياً.
 */

const ENGLISH_DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const startOfDayUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const diffInDays = (a: Date, b: Date) => Math.floor((startOfDayUTC(b).getTime() - startOfDayUTC(a).getTime()) / 86_400_000);
/** (Carbon dayOfWeek + 1) % 7 — الأحد=0..السبت=6 عند JS مطابقٌ لـCarbon، فتحويل السبت=0 واحد */
const adjustedDayIndex = (d: Date) => (d.getUTCDay() + 1) % 7;

export interface WeekInfo {
  dayOfWeek: string;
  year: number;
  week: number;
}

export function currentWeekInfo(date: Date = new Date()): WeekInfo {
  const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const startOfYearDay = adjustedDayIndex(startOfYear);
  const daysSinceStart = diffInDays(startOfYear, date);
  let week = Math.ceil((daysSinceStart + startOfYearDay + 1) / 7);
  let year = date.getUTCFullYear();

  if (week > 52 && date.getUTCMonth() === 0 && date.getUTCDate() <= 2) {
    const prevYearEnd = new Date(Date.UTC(date.getUTCFullYear() - 1, 11, 31));
    const prevYearStart = new Date(Date.UTC(date.getUTCFullYear() - 1, 0, 1));
    const prevStartDay = adjustedDayIndex(prevYearStart);
    const daysSincePrevStart = diffInDays(prevYearStart, prevYearEnd) + 1;
    const prevYearLastWeek = Math.ceil((daysSincePrevStart + prevStartDay + 1) / 7);

    if (prevYearLastWeek >= 53) {
      const week53Start = new Date(Date.UTC(date.getUTCFullYear() - 1, 11, 27));
      if (Math.abs(diffInDays(date, week53Start)) <= 6) {
        week = 53;
        year = date.getUTCFullYear() - 1;
      }
    }
  }

  return { dayOfWeek: ENGLISH_DAYS[adjustedDayIndex(date)], year, week };
}
