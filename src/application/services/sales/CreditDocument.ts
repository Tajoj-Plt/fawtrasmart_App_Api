import { InvoiceItemRow, InvoiceRow } from '../../../domain/repositories/sales';
import { allocateDocumentDiscount, round2, TaxBook, taxLine } from '../../../domain/services/sales/SalesMath';

/** بندُ مستند ردٍّ (مرتجع أو إشعار دائن) جاهزٌ للكتابة */
export interface CreditLine {
  source: InvoiceItemRow | null;
  productId: number;
  name: string;
  productUnitId: number | null;
  unitName: string | null;
  conversionFactor: number;
  quantity: number;
  baseQuantity: number;
  unitPrice: number;
  /** خصم البند مبلغاً */
  discount: number;
  tax1Id: number | null;
  tax2Id: number | null;
  warehouseId: number | null;
  description: string | null;
  /** تكلفة الوحدة الأساسية المجمَّدة في البيع — `null` = متوسّط التكلفة الآن */
  unitCost: number | null;
}

export interface CreditTotals {
  subtotal: number;
  totalDiscount: number;
  documentDiscount: number;
  itemsTax: number;
  shippingCost: number;
  shippingTax: number;
  taxTotal: number;
  grandTotal: number;
  /** إجمالي البند = الكمية × السعر − خصمه */
  lineTotals: number[];
  /** ضرائب كل بندٍ بعد حصّته من الخصم العامّ — لـ`taxs_invoice` */
  lineTaxes: Array<Array<{ id: number | null; rate: number; amount: number }>>;
}

/** الخصم العامّ للفاتورة (مع الكوبون) = `discount_amount` − خصوم البنود */
export function documentDiscountOf(invoice: Pick<InvoiceRow, 'discountAmount'>, items: InvoiceItemRow[]) {
  return round2(Math.max(0, invoice.discountAmount - items.reduce((s, i) => s + i.discount, 0)));
}

/** البند من الفاتورة بالكمية المردودة — السعر والضرائب منها، وخصمُه بنسبة الكمية */
export function lineFromInvoice(item: InvoiceItemRow, quantity: number, warehouseId: number | null): CreditLine {
  const factor = item.conversionFactor > 0 ? item.conversionFactor : item.quantity > 0 && item.quantityInBaseUnit ? item.quantityInBaseUnit / item.quantity : 1;
  return {
    source: item,
    productId: item.productId as number,
    name: item.item,
    productUnitId: item.productUnitId,
    unitName: item.unitName,
    conversionFactor: factor,
    quantity,
    baseQuantity: quantity * factor,
    unitPrice: item.unitPrice,
    discount: item.quantity > 0 ? (item.discount * quantity) / item.quantity : 0,
    tax1Id: item.tax1Id,
    tax2Id: item.tax2Id,
    warehouseId: item.storeHouseId ?? warehouseId,
    description: item.description,
    unitCost: item.unitCostAtSale,
  };
}

/**
 * مجاميع مستند الردّ بترتيب الفاتورة نفسه (`DocumentTaxCalculator`): صافي البنود،
 * ثمّ الخصم العامّ موزَّعاً عليها، ثمّ الضريبة على وعاء كلٍّ بعده، ثمّ الشحن.
 * `documentDiscount` مبلغٌ جاهز — للمرتجع: حصّتُه من خصم الفاتورة العامّ.
 */
export function creditTotals(book: TaxBook, lines: CreditLine[], documentDiscount: number, shipping: { cost: number; tax: number }): CreditTotals {
  const gross = lines.map((l) => l.quantity * l.unitPrice);
  const nets = lines.map((l, i) => Math.max(0, gross[i] - l.discount));
  const docDiscount = round2(Math.min(documentDiscount, Math.max(0, round2(nets.reduce((s, n) => s + n, 0)))));
  const shares = allocateDocumentDiscount(nets, docDiscount);

  let tax = 0;
  let included = 0;
  const lineTaxes: CreditTotals['lineTaxes'] = [];
  lines.forEach((l, i) => {
    const r = taxLine(book, 1, Math.max(0, nets[i] - (shares[i] ?? 0)), 0, [l.tax1Id, l.tax2Id]);
    tax += r.tax;
    included += r.base - r.net;
    lineTaxes.push(r.taxes.map((t) => ({ id: t.id, rate: t.rate, amount: t.amount })));
  });

  const itemsTax = round2(tax);
  const subtotal = round2(gross.reduce((s, g) => s + g, 0) - round2(included));
  const totalDiscount = round2(lines.reduce((s, l) => s + l.discount, 0) + docDiscount);
  const shippingCost = round2(shipping.cost);
  const shippingTax = round2(shipping.tax);
  return {
    subtotal,
    totalDiscount,
    documentDiscount: docDiscount,
    itemsTax,
    shippingCost,
    shippingTax,
    taxTotal: round2(itemsTax + shippingTax),
    grandTotal: round2(round2(subtotal - totalDiscount) + itemsTax + shippingCost + shippingTax),
    lineTotals: lines.map((l, i) => round2(gross[i] - l.discount)),
    lineTaxes,
  };
}
