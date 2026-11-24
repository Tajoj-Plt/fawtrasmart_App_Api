/**
 * دوام مسؤول العميل — `ClientEmployeeNote::parseShiftRange()` وأخواتها.
 *
 * قيمةٌ واحدة: `full` (دوام كامل) أو `HH:00|HH:00` بساعاتٍ كاملة والبداية ≠ النهاية.
 */

export const FULL_TIME_VALUE = 'full';
export const FULL_TIME_START = '00:00';
export const FULL_TIME_END = '24:00';
export const FULL_TIME_LABEL = 'دوام كامل (24 ساعة)';

export const SHIFT_HOURS: string[] = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

export function formatShiftTime(time: string | null | undefined): string {
  if (!time) return 'غير محدد';
  const hour = Number(time.slice(0, 2));
  const minute = time.slice(3, 5);
  const h = hour % 12 || 12;
  return `${h}:${minute} ${hour >= 12 ? 'مساءً' : 'صباحاً'}`;
}

/** خيارات قائمة الساعات — `shiftHourOptions()` */
export function shiftHourOptions(): Array<{ value: string; label: string }> {
  return SHIFT_HOURS.map((value, h) => {
    let label = formatShiftTime(value);
    if (h === 0) label += ' (منتصف الليل)';
    else if (h === 12) label += ' (الظهر)';
    return { value, label };
  });
}

export function parseShiftRange(value: unknown): [string, string] | null {
  if (typeof value !== 'string') return null;
  if (value === FULL_TIME_VALUE || value === `${FULL_TIME_START}|${FULL_TIME_END}`) return [FULL_TIME_START, FULL_TIME_END];
  if (!value.includes('|')) return null;

  const [start, end] = value.split('|', 2);
  if (!SHIFT_HOURS.includes(start) || !SHIFT_HOURS.includes(end) || start === end) return null;
  return [start, end];
}

export function isFullTimeRange(start: string | null | undefined, end: string | null | undefined): boolean {
  return start === FULL_TIME_START && end === FULL_TIME_END;
}

export function hasShift(start: string | null | undefined, end: string | null | undefined): boolean {
  return Boolean(start) && Boolean(end);
}

/** `shift_label` */
export function shiftLabel(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!hasShift(start, end)) return null;
  if (isFullTimeRange(start, end)) return FULL_TIME_LABEL;
  return `من ${formatShiftTime(start)} إلى ${formatShiftTime(end)}`;
}

/** `shift_range_value` — ما تختاره القائمة لهذا المسؤول */
export function shiftRangeValue(start: string | null | undefined, end: string | null | undefined): string {
  if (!hasShift(start, end)) return '';
  return isFullTimeRange(start, end) ? FULL_TIME_VALUE : `${start}|${end}`;
}

/** وصف الدوام داخل نصّ الملاحظة — كما يكتبه `addnotes()`: «8:00 صباحاً إلى 4:00 مساءً (صباحي)» */
export function noteShiftLabel(start: string, end: string): string {
  if (isFullTimeRange(start, end)) return FULL_TIME_LABEL;
  const period = Number(start.slice(0, 2)) >= 12 ? 'مسائي' : 'صباحي';
  return `${formatShiftTime(start)} إلى ${formatShiftTime(end)} (${period})`;
}
