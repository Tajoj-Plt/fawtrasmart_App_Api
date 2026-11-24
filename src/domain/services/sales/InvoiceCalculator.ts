import { allocateDocumentDiscount, round2, shippingTax, shippingTaxIds, TaxBook, taxLine } from './SalesMath';

export interface CalcLine {
  quantity: number;
  unitPrice: number;
  /** خصم البند مبلغاً (يدوياً أو من عرض حسم) */
  discount: number;
  taxIds: [number | null, number | null];
}

export interface CalcDocument {
  lines: CalcLine[];
  /** الخصم العامّ كما أُدخل */
  discountValue: number;
  discountType: 'amount' | 'percentage';
  shippingCost: number;
  /** أحضرَ الطلبُ مُنتقي ضريبة الشحن؟ وما اختير فيه */
  shippingTaxSelector: boolean;
  shippingTaxId: number | null;
}

export interface CalcTotals {
  /** مجموع الأصناف قبل الخصم بلا الضريبة المتضمَّنة — `subtotal` */
  subtotal: number;
  lineDiscounts: number;
  invoiceDiscount: number;
  couponDiscount: number;
  /** خصوم البنود + الخصم العامّ + الكوبون — `discount_amount` */
  totalDiscount: number;
  amountAfterDiscount: number;
  itemsTax: number;
  shippingCost: number;
  shippingTax: number;
  /** ضريبة البنود + ضريبة الشحن — `tax_total` */
  taxTotal: number;
  grandTotal: number;
  /** وعاء الكوبون: صافي الأصناف بعد الخصم العامّ */
  couponBase: number;
  lineTotals: number[];
}

/**
 * ترتيبُ حساب فاتورة البيع كما في `InvoicesController::persistInvoice()`:
 *
 *   إجمالي الأصناف − خصومات الأصناف ⇒ صافي الأصناف
 *   − الخصم العامّ والكوبون (موزَّعَين على البنود) ⇒ صافي التوريد
 *   × ضريبة كل بندٍ على وعائه (متضمَّنة تُستخرج، مضافة تُضاف)
 *   + الشحن وضريبته (مضافةٌ دائماً) ⇒ الإجمالي
 *
 * `coupon` يُسأل عن خصمه بعد معرفة وعائه (صافي الأصناف بعد الخصم العامّ).
 */
export async function calculateInvoice(
  book: TaxBook,
  doc: CalcDocument,
  coupon: (base: number) => Promise<{ discount: number; freeShipping: boolean }>,
): Promise<CalcTotals> {
  let totalAmount = 0;
  let lineDiscounts = 0;
  const lineNets: number[] = [];
  const lineTotals: number[] = [];

  for (const line of doc.lines) {
    const itemTotal = line.quantity * line.unitPrice;
    totalAmount += itemTotal;
    lineDiscounts += line.discount;
    lineNets.push(Math.max(0, itemTotal - line.discount));
    lineTotals.push(itemTotal - line.discount);
  }

  const netItems = round2(lineNets.reduce((s, n) => s + n, 0));

  let invoiceDiscount = 0;
  if (doc.discountValue > 0) {
    invoiceDiscount = doc.discountType === 'percentage' ? (netItems * doc.discountValue) / 100 : doc.discountValue;
    invoiceDiscount = Math.min(invoiceDiscount, Math.max(0, netItems));
  }

  const couponBase = Math.max(0, round2(netItems - invoiceDiscount));
  const couponResult = await coupon(couponBase);
  const couponDiscount = couponResult.discount;

  const generalDiscount = Math.min(invoiceDiscount + couponDiscount, Math.max(0, netItems));
  const shares = allocateDocumentDiscount(lineNets, generalDiscount);

  let taxTotal = 0;
  let includedTax = 0;
  const documentTaxIds: unknown[] = [];

  doc.lines.forEach((line, key) => {
    const taxableBase = Math.max(0, lineNets[key] - (shares[key] ?? 0));
    const result = taxLine(book, 1, taxableBase, 0, line.taxIds);
    taxTotal += result.tax;
    includedTax += result.base - result.net;
    documentTaxIds.push(line.taxIds[0], line.taxIds[1]);
  });

  taxTotal = round2(taxTotal);
  includedTax = round2(includedTax);
  const subtotal = round2(totalAmount - includedTax);

  const totalDiscount = lineDiscounts + invoiceDiscount + couponDiscount;
  const amountAfterDiscount = round2(subtotal - totalDiscount);

  const shipping = couponResult.freeShipping ? 0 : doc.shippingCost;
  const shipTax = shippingTax(book, shipping, shippingTaxIds(doc.shippingTaxSelector, doc.shippingTaxId, documentTaxIds));
  const itemsTax = taxTotal;
  taxTotal = round2(taxTotal + shipTax);

  return {
    subtotal,
    lineDiscounts,
    invoiceDiscount,
    couponDiscount,
    totalDiscount,
    amountAfterDiscount,
    itemsTax: round2(itemsTax),
    shippingCost: shipping,
    shippingTax: shipTax,
    taxTotal,
    grandTotal: amountAfterDiscount + taxTotal + shipping,
    couponBase,
    lineTotals,
  };
}
