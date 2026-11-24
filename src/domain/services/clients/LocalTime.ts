/**
 * وقت النظام المحلّي — كما يكتبه لارافل ويقرؤه (`config('app.timezone')`، الرياض).
 *
 * القاعدة تخزّن أوقاتاً «ساذجة» بلا منطقة (`2026-09-26 14:05:00` بتوقيت الرياض).
 * فتُمثَّل هنا بكائن Date **حقولُه UTC هي الوقت المحلّي نفسه** («وقتٌ ساذج»):
 * يُقرأ من القاعدة ويُكتب إليها ويُقارَن ويُجمع بلا أي تحويل، فلا ينزاح يومٌ
 * بفرق التوقيت. `sqlNow()` العامّة في المشروع تكتب بتوقيت UTC — لا تُستعمل
 * في وحدة العملاء: زيارةٌ تُكتب بـUTC بعد منتصف الليل بالرياض تُحسب في اليوم السابق.
 */

const DAY_MS = 86_400_000;

/** الوقت الساذج الآن في منطقة معيّنة */
export function localNow(timeZone: string, at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')));
}

/** نصّ القاعدة (`Y-m-d H:i:s` أو `Y-m-d`) ← وقت ساذج */
export function parseLocal(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value).trim());
  if (!m) return null;

  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** تاريخ مدخلٍ من المستخدم `YYYY-MM-DD` بلا ترحيل — ٣٠ فبراير `null` لا ٢ مارس */
export function parseInputDate(value: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** وقت ساذج ← `Y-m-d H:i:s` كما يكتبه لارافل */
export function toSqlDateTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** وقت ساذج ← `Y-m-d` */
export function toSqlDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `H:i` */
export function toTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
}

export function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** `Carbon::subYears()/addYears()` — 29 فبراير يرجع إلى آخر فبراير (بلا فيضان) */
export function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** فرق الأيام بالكسر — `Carbon::diffInDays()` في Carbon 3 (موجبٌ إن كان `to` بعد `from`) */
export function diffInDaysFloat(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

/** فرق الثواني المطلق */
export function diffInSecondsAbs(a: Date, b: Date): number {
  return Math.abs(Math.floor((b.getTime() - a.getTime()) / 1000));
}

export function sameDay(a: Date, b: Date): boolean {
  return toSqlDate(a) === toSqlDate(b);
}

/** الوقت الساذج ← ISO بإزاحة المنطقة (للردود) */
export function toIsoLocal(d: Date | null): string | null {
  return d ? toSqlDateTime(d) : null;
}
