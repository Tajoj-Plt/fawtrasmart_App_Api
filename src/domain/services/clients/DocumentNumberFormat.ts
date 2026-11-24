import { toSqlDate } from './LocalTime';

/**
 * صيغة الأرقام المتسلسلة — `App\Services\DocumentNumberService::format()` وأخواتها،
 * كي يُنتج الجوال الرقم نفسه الذي كان الويب سيُنتجه من الإعداد نفسه.
 */

export interface SerialSetting {
  id?: number;
  section: string;
  currentNumber: number;
  numberOfDigits: number;
  prefix: string | null;
  separator: string | null;
  suffix: string | null;
  mode: number;
  resetYearly: boolean;
  resetPeriod: string | null;
  lastResetAt: Date | null;
}

/** الأقسام التي تستعملها وحدة العملاء — `DocumentSections::SECTIONS` */
/** `DocumentSections::SECTIONS` — `scope` يحصر الجدول المشترك بنوع المستند */
export const DOCUMENT_SECTIONS: Record<string, { table: string; column: string; prefix: string; scope?: Record<string, string> }> = {
  customer: { table: 'clients', column: 'code', prefix: 'C' },
  visit: { table: 'visits', column: 'visit_number', prefix: 'VIS' },
  'warehouse-add': { table: 'warehouse_permits', column: 'number', prefix: 'WIN' },
  'warehouse-dispose': { table: 'warehouse_permits', column: 'number', prefix: 'WOUT' },
  'transfer-request': { table: 'warehouse_permits', column: 'number', prefix: 'TRF' },
  entry: { table: 'journal_entries', column: 'reference_number', prefix: 'JE' },
  invoice: { table: 'invoices', column: 'code', prefix: 'INV' },
  'return-invoice': { table: 'invoices', column: 'code', prefix: 'RET' },
  quotation: { table: 'quotes', column: 'quote_number', prefix: 'QT', scope: { type: 'quote' } },
  'sales-order': { table: 'quotes', column: 'quote_number', prefix: 'SOR', scope: { type: 'sales_order' } },
  'credit-note': { table: 'credit_notifications', column: 'credit_number', prefix: 'CN' },
  'product-exchange': { table: 'product_exchanges', column: 'code', prefix: 'EX' },
};

const pad = (n: number, len: number) => String(n).padStart(len, '0');

function toLetters(number: number, minLength: number, uppercase: boolean): string {
  let letters = '';
  let n = Math.max(0, number);
  do {
    letters = String.fromCharCode(97 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  } while (n > 0);
  letters = letters.padStart(Math.max(1, minLength), 'a');
  return uppercase ? letters.toUpperCase() : letters;
}

function encode(number: number, digits: number, mode: number): string {
  switch (mode) {
    case 1:
      return number.toString(16).padStart(digits, '0');
    case 2:
      return number.toString(16).padStart(digits, '0').toUpperCase();
    case 3:
      return toLetters(number, digits, false);
    case 4:
      return toLetters(number, digits, true);
    case 5:
    case 6:
      return toLetters(Math.floor(number / 1000), 2, mode === 6) + String(number % 1000).padStart(Math.max(1, digits - 2), '0');
    default:
      return String(number).padStart(digits, '0');
  }
}

export function expandPlaceholders(text: string, now: Date): string {
  if (!text || !text.includes('{')) return text;
  const y = now.getUTCFullYear();
  return text
    .split('{YYYY}').join(String(y))
    .split('{YY}').join(pad(y % 100, 2))
    .split('{MM}').join(pad(now.getUTCMonth() + 1, 2))
    .split('{DD}').join(pad(now.getUTCDate(), 2));
}

export function formatNumber(setting: SerialSetting, number: number, now: Date): string {
  const digits = Math.max(1, Math.trunc(setting.numberOfDigits || 0));
  return expandPlaceholders(setting.prefix ?? '', now) + (setting.separator ?? '') + encode(number, digits, Math.trunc(setting.mode || 0)) + expandPlaceholders(setting.suffix ?? '', now);
}

export function isResetDue(setting: SerialSetting, now: Date): boolean {
  const period = setting.resetPeriod || (setting.resetYearly ? 'yearly' : 'never');
  if (period === 'never' || !setting.lastResetAt) return false;
  const last = setting.lastResetAt;
  switch (period) {
    case 'yearly':
      return last.getUTCFullYear() !== now.getUTCFullYear();
    case 'monthly':
      return last.getUTCFullYear() !== now.getUTCFullYear() || last.getUTCMonth() !== now.getUTCMonth();
    case 'daily':
      return toSqlDate(last) !== toSqlDate(now);
    default:
      return false;
  }
}

/** رقم المستند هو آخر مقطعٍ رقمي في الرمز: `PUR-00002` ← 2 */
export function trailingNumber(code: string): number {
  const m = /(\d+)\D*$/.exec(code);
  return m ? Number(m[1]) : 0;
}
