import { FieldErrors } from '../clients/FormInput';

/**
 * تحقّقُ «طلب سلفة» — قواعدُ `AdvanceRequestRequest` ورسائلُها حرفياً، ثمّ
 * فحصُ `AdvanceApprovers::allows()` بعدها (كما في الويب: المعتمِدُ يُفحص بعد
 * نجاح التحقّق لا معه، فلا يُخبر المستخدمَ بمن لا يجوز اختيارُه قبل أن يُكمل
 * الحقول).
 */

export interface AdvanceRequestInput {
  amount: number;
  reason: string;
  requestedDate: string;
  approverUserId: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const raw = (body: Record<string, unknown>, key: string): unknown => {
  const v = body?.[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return v === undefined ? null : v;
};

/** تاريخٌ حقيقيّ — ٣٠ فبراير والشهر ١٣ مرفوضان كقاعدة `date` في لارافل */
function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function validateAdvanceRequest(body: Record<string, unknown>, opts: { today: string; approverIds: number[] }): AdvanceRequestInput {
  const errors = new FieldErrors();

  // ── amount: required|numeric|min:1 ──
  const amountRaw = raw(body, 'amount');
  let amount = 0;
  if (amountRaw === null) {
    errors.add('amount', 'يرجى إدخال مبلغ السلفة');
  } else {
    const n = typeof amountRaw === 'number' ? amountRaw : /^[+-]?(\d+\.?\d*|\.\d+)$/.test(String(amountRaw)) ? Number(amountRaw) : NaN;
    if (!Number.isFinite(n)) errors.add('amount', 'مبلغ السلفة يجب أن يكون رقماً');
    else if (n < 1) errors.add('amount', 'مبلغ السلفة يجب أن يكون أكبر من صفر');
    else amount = n;
  }

  // ── reason: required|string|max:500 ──
  const reasonRaw = raw(body, 'reason');
  let reason = '';
  if (reasonRaw === null) {
    errors.add('reason', 'يرجى إدخال سبب طلب السلفة');
  } else if (typeof reasonRaw !== 'string' && typeof reasonRaw !== 'number') {
    errors.add('reason', 'يرجى إدخال سبب طلب السلفة');
  } else {
    reason = String(reasonRaw);
    if ([...reason].length > 500) errors.add('reason', 'سبب الطلب يجب ألا يتجاوز 500 حرف');
  }

  // ── requestedDate: required|date|after_or_equal:today ──
  const dateRaw = raw(body, 'requestedDate');
  let requestedDate = '';
  if (dateRaw === null) {
    errors.add('requestedDate', 'يرجى تحديد تاريخ الطلب');
  } else if (typeof dateRaw !== 'string' || !isRealDate(dateRaw)) {
    errors.add('requestedDate', 'التاريخ بصيغة YYYY-MM-DD.');
  } else if (dateRaw < opts.today) {
    errors.add('requestedDate', 'تاريخ الطلب يجب أن يكون اليوم أو بعده');
  } else {
    requestedDate = dateRaw;
  }

  // ── approverUserId: required|exists:users,id ──
  const approverRaw = raw(body, 'approverUserId');
  let approverUserId = 0;
  if (approverRaw === null) {
    errors.add('approverUserId', 'يرجى اختيار الموظف المعتمد');
  } else {
    const n = typeof approverRaw === 'number' ? approverRaw : /^\d+$/.test(String(approverRaw)) ? Number(approverRaw) : NaN;
    if (!Number.isInteger(n) || n < 1) errors.add('approverUserId', 'الموظف المعتمد المحدد غير موجود');
    else approverUserId = n;
  }

  errors.throwIfAny();

  // `AdvanceApprovers::allows()` — المعتمِدُ من القائمة المضبوطة نفسِها لا أيُّ مستخدمٍ يُرسَل رقمُه
  if (!opts.approverIds.includes(approverUserId)) {
    errors.add('approverUserId', 'الموظف المختار ليس من معتمِدي السلف المضبوطين في إعدادات السلف.');
    errors.throwIfAny();
  }

  return { amount, reason, requestedDate, approverUserId };
}
