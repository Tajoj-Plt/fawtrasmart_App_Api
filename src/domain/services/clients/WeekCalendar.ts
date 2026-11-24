import { diffInDaysFloat, startOfDay, startOfYear } from './LocalTime';

/**
 * ترقيم أسابيع خطوط السير — نسخة `App\Helpers\WeekHelper` حرفاً بحرف.
 *
 * الأسبوع يبدأ السبت، ويُحسب من أوّل السنة بفرق الأيام **بالكسر** (Carbon 3 يعيد
 * `diffInDays()` عدداً عشرياً يشمل ساعات اليوم). لذا قد يتغيّر رقم أسبوع الجمعة
 * خلال اليوم نفسه — وهو سلوك الويب الذي تُخزَّن به صفوف `employee_client_visits`،
 * فيُنسخ كما هو كي تتطابق الصفوف بين الويب والجوال.
 *
 * كل التواريخ هنا «أوقات ساذجة» (انظر LocalTime).
 */

export const ENGLISH_DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;
export const ARABIC_DAYS = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'] as const;

/** `dayOfWeek` في Carbon (الأحد = 0) ← فهرسٌ يبدأ بالسبت */
const saturdayIndex = (d: Date) => (d.getUTCDay() + 1) % 7;

export function getWeekAndYear(date: Date): { week: number; year: number } {
  const start = startOfYear(date);
  const startDay = saturdayIndex(start);
  const days = diffInDaysFloat(start, date);
  const week = Math.ceil((days + startDay + 1) / 7);
  const year = date.getUTCFullYear();

  // الفرع الخاص بالأسبوع 53 في WeekHelper لا يُبلغ عملياً (أسبوع يناير ≤ 2)، ويُنسخ للأمانة
  if (week > 52 && date.getUTCMonth() === 0 && date.getUTCDate() <= 2) {
    const prevStart = new Date(Date.UTC(year - 1, 0, 1));
    const prevEnd = new Date(Date.UTC(year - 1, 11, 31, 23, 59, 59, 999));
    const prevWeeks = Math.ceil((diffInDaysFloat(prevStart, prevEnd) + 1 + saturdayIndex(prevStart) + 1) / 7);
    if (prevWeeks >= 53) {
      const week53Start = new Date(Date.UTC(year - 1, 11, 27));
      if (Math.abs(diffInDaysFloat(date, week53Start)) <= 6) return { week: 53, year: year - 1 };
    }
  }

  return { week, year };
}

export function dayNameEn(date: Date): string {
  return ENGLISH_DAYS[saturdayIndex(date)];
}

export function dayNameAr(date: Date): string {
  return ARABIC_DAYS[saturdayIndex(date)];
}

/** `ItineraryWeekService::partsFor()` — أجزاء صفّ خطّ السير ليومٍ ما */
export function partsFor(date: Date): { year: number; weekNumber: number; dayOfWeek: string } {
  const day = startOfDay(date);
  const { week, year } = getWeekAndYear(day);
  return { year, weekNumber: week, dayOfWeek: dayNameEn(day).toLowerCase() };
}

/** `ClientAccessService::todayItineraryContext()` — يُحسب من الآن بساعاته كما في الويب */
export function todayContext(now: Date): { dayNameEn: string; year: number; week: number } {
  const { week, year } = getWeekAndYear(now);
  return { dayNameEn: dayNameEn(now), year, week };
}
