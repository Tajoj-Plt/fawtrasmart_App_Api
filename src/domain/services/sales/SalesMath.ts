/**
 * حساب مستندات المبيعات — `App\Services\Tax\DocumentTaxCalculator` حرفياً، مع
 * `round()` كما يحسبها PHP (نصفٌ بعيداً عن الصفر بعد تقريبٍ مسبق إلى ١٥ رقماً
 * معنوياً)، فلا يختلف قرشٌ واحد بين فاتورةٍ من الويب وأخرى من التطبيق.
 */

/** `round($value, $places)` في PHP 8 — مُطابَقةٌ على ٣٠ ألف قيمة */
export function phpRound(value: number, places = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, places);
  const pre = Number((value * factor).toPrecision(15));
  const rounded = Math.sign(pre) * Math.round(Math.abs(pre));
  return rounded / factor + 0; // `+ 0` يمحو ‎-0
}

export const round2 = (n: number) => phpRound(n, 2);

/** ضريبةٌ مضبوطة في «إعدادات الضريبة» (`tax_sittings`) */
export interface TaxSetting {
  id: number;
  name: string;
  rate: number;
  type: 'included' | 'excluded';
}

export type TaxBook = Map<number, TaxSetting>;

export interface LineTaxDetail {
  id: number | null;
  rate: number;
  included: boolean;
  amount: number;
}

export interface LineResult {
  gross: number;
  discount: number;
  base: number;
  net: number;
  tax: number;
  total: number;
  taxes: LineTaxDetail[];
}

const findTax = (book: TaxBook, id: unknown): TaxSetting | null => {
  if (id === null || id === undefined || id === '' || id === 0) return null;
  return book.get(Number(id)) ?? null;
};

/** `amount()` — المتضمَّنة تُستخرَج من المبلغ، والمضافة فوقه */
export function taxAmount(base: number, rate: number, included: boolean): number {
  if (base <= 0 || rate <= 0) return 0;
  return round2(included ? base - base / (1 + rate / 100) : (base * rate) / 100);
}

/** `line()` — بندٌ كامل: الوعاء بعد الخصم ثم ضرائبه (واحدة أو اثنتان) */
export function taxLine(book: TaxBook, quantity: number, unitPrice: number, discount: number, taxIds: unknown[] = [], rates: number[] = []): LineResult {
  const gross = round2(quantity * unitPrice);
  const disc = Math.max(0, discount);
  const base = Math.max(0, round2(gross - disc));

  let tax = 0;
  let includedTax = 0;
  const details: LineTaxDetail[] = [];

  taxIds.forEach((taxId, index) => {
    const setting = findTax(book, taxId);
    // الإعداد هو المرجع حين يوجد؛ النسبة المرسلة لا تُعتمد إلا بلا معرّف
    const rate = setting ? setting.rate : Number(rates[index] ?? 0);
    const included = setting ? setting.type === 'included' : false;
    if (rate <= 0) return;

    const amount = taxAmount(base, rate, included);
    tax += amount;
    includedTax += included ? amount : 0;
    details.push({ id: setting?.id ?? null, rate, included, amount });
  });

  tax = round2(tax);
  includedTax = round2(includedTax);

  return {
    gross,
    discount: round2(disc),
    base,
    net: round2(base - includedTax),
    tax,
    total: round2(base + (tax - includedTax)),
    taxes: details,
  };
}

/** `shippingTaxIds()` — «بلا ضريبة» اختيارٌ لا سكوت */
export function shippingTaxIds(hasSelector: boolean, chosenId: unknown, documentTaxIds: unknown[]): unknown[] {
  if (hasSelector) return chosenId ? [chosenId] : [];
  return documentTaxIds;
}

/** `shippingTax()` — مضافةٌ دائماً فوق تكلفة الشحن بنسبة أوّل ضريبةٍ مضبوطة */
export function shippingTax(book: TaxBook, shippingCost: number, taxIds: unknown[], legacyRate: number | null = null): number {
  if (shippingCost <= 0) return 0;
  for (const id of taxIds) {
    const setting = findTax(book, id);
    if (setting) return taxAmount(shippingCost, setting.rate, false);
  }
  return taxAmount(shippingCost, Number(legacyRate ?? 0), false);
}

/**
 * `allocateDocumentDiscount()` — حصّة كل بندٍ من الخصم العامّ بنسبة صافيه،
 * والكسر الباقي على آخر بند فلا يضيع قرش.
 */
export function allocateDocumentDiscount(lineNets: number[], documentDiscount: number): number[] {
  const shares = lineNets.map(() => 0);
  if (documentDiscount <= 0 || lineNets.length === 0) return shares;

  const base = lineNets.reduce((s, n) => s + Math.max(0, n), 0);
  if (base <= 0) return shares;

  const discount = Math.min(documentDiscount, base);
  let remaining = discount;
  const last = lineNets.length - 1;

  lineNets.forEach((raw, key) => {
    const net = Math.max(0, raw);
    const share = key === last ? remaining : round2((discount * net) / base);
    shares[key] = Math.max(0, Math.min(share, net));
    remaining = round2(remaining - shares[key]);
  });

  return shares;
}

/** `normalizeAmountInput()` — الأرقام العربية والفاصلة العربية، والسالب صفر عند المستدعي */
export function normalizeAmount(value: unknown): number {
  const map: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.', '٬': '' };
  const text = String(value ?? '').replace(/[٠-٩٫٬]/g, (c) => map[c] ?? c).replace(/[^\d.-]/g, '');
  const n = parseFloat(text);
  return round2(Number.isFinite(n) ? n : 0);
}

/** `rtrim(rtrim(number_format($x, 4, '.', ''), '0'), '.')` — الكميات في الرسائل */
export const fmtQty = (n: number) => {
  const s = phpRound(n, 4).toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** `number_format($x, 2)` — فاصل الآلاف وخانتان */
export const fmtMoney = (n: number) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
