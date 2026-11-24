import { describe, expect, it } from 'vitest';
import { creditTotals, documentDiscountOf, lineFromInvoice } from '../src/application/services/sales/CreditDocument';
import { InvoiceItemRow } from '../src/domain/repositories/sales';
import { calculateInvoice } from '../src/domain/services/sales/InvoiceCalculator';
import { bestGift } from '../src/domain/services/sales/PromotionRules';
import { allocateDocumentDiscount, phpRound, round2, shippingTaxIds, TaxBook, taxAmount } from '../src/domain/services/sales/SalesMath';

const book: TaxBook = new Map([
  [1, { id: 1, name: 'صفرية', rate: 0, type: 'excluded' }],
  [2, { id: 2, name: 'القيمة المضافة', rate: 15, type: 'excluded' }],
  [3, { id: 3, name: 'متضمَّنة', rate: 15, type: 'included' }],
]);
const noCoupon = async () => ({ discount: 0, freeShipping: false });

const item = (over: Partial<InvoiceItemRow>): InvoiceItemRow => ({
  id: 1,
  productId: 3,
  item: 'X',
  description: null,
  unitName: null,
  productUnitId: null,
  storeHouseId: 1,
  storeHouseName: null,
  quantity: 3,
  quantityInBaseUnit: 3,
  conversionFactor: 1,
  unitPrice: 18,
  discount: 0,
  discountType: 1,
  tax1: 15,
  tax1Id: 2,
  tax2: 0,
  tax2Id: null,
  total: 54,
  unitCostAtSale: 5,
  ...over,
});

describe('SalesMath', () => {
  it('phpRound matches PHP half-away-from-zero and float noise', () => {
    expect(phpRound(1.005, 2)).toBe(1.01);
    expect(phpRound(-1.005, 2)).toBe(-1.01);
    expect(phpRound(2.675, 2)).toBe(2.68);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('taxAmount extracts included and adds excluded', () => {
    expect(taxAmount(115, 15, true)).toBe(15);
    expect(taxAmount(100, 15, false)).toBe(15);
    expect(taxAmount(0, 15, false)).toBe(0);
  });

  it('document discount is allocated proportionally with the remainder on the last line', () => {
    const shares = allocateDocumentDiscount([54, 3.6], 2.88);
    expect(round2(shares[0] + shares[1])).toBe(2.88);
    expect(shares[0]).toBeCloseTo(2.7, 2);
  });

  it('an empty shipping-tax selector means no tax, not the lines tax', () => {
    expect(shippingTaxIds(true, null, [2])).toEqual([]);
    expect(shippingTaxIds(false, null, [2])).toEqual([2]);
  });
});

describe('InvoiceCalculator', () => {
  it('discount, taxes after the document discount, shipping and its tax', async () => {
    const t = await calculateInvoice(
      book,
      {
        lines: [
          { quantity: 4, unitPrice: 18, discount: 3.6, taxIds: [2, null] },
          { quantity: 100, unitPrice: 0.4, discount: 0, taxIds: [2, null] },
        ],
        discountValue: 2,
        discountType: 'amount',
        shippingCost: 20,
        shippingTaxSelector: true,
        shippingTaxId: 2,
      },
      noCoupon,
    );
    expect(t.subtotal).toBe(112);
    expect(round2(t.totalDiscount)).toBe(5.6);
    expect(t.shippingTax).toBe(3);
    expect(t.taxTotal).toBe(18.96);
    expect(round2(t.grandTotal)).toBe(145.36);
  });

  it('included tax is taken out of the subtotal', async () => {
    const t = await calculateInvoice(book, { lines: [{ quantity: 1, unitPrice: 115, discount: 0, taxIds: [3, null] }], discountValue: 0, discountType: 'amount', shippingCost: 0, shippingTaxSelector: false, shippingTaxId: null }, noCoupon);
    expect(t.subtotal).toBe(100);
    expect(t.taxTotal).toBe(15);
    expect(round2(t.grandTotal)).toBe(115);
  });
});

describe('PromotionRules.bestGift', () => {
  const offers = [
    { id: 1, targetProductId: 3, minQuantity: 12, giftProductId: 3, giftQuantity: 1 },
    { id: 2, targetProductId: 3, minQuantity: 24, giftProductId: 3, giftQuantity: 2 },
    { id: 9, targetProductId: 3, minQuantity: 0, giftProductId: 3, giftQuantity: 5 },
  ];
  it('picks the highest gift quantity and multiplies by the base quantity', () => {
    expect(bestGift(offers, 3, 92)?.quantity).toBe(6);
    expect(bestGift(offers, 3, 12)?.quantity).toBe(1);
  });
  it('skips an offer with a zero minimum (web divides by zero)', () => {
    expect(bestGift(offers, 3, 5)).toBeNull();
  });
});

describe('CreditDocument', () => {
  it('a partial return takes a proportional share of the line and document discounts', () => {
    const lines = [item({ quantity: 3, discount: 3 })];
    const doc = documentDiscountOf({ discountAmount: 6 }, lines);
    expect(doc).toBe(3);
    const line = lineFromInvoice(lines[0], 1, null);
    expect(line.discount).toBe(1);
    expect(line.unitCost).toBe(5);
    const t = creditTotals(book, [line], round2((doc * (18 - 1)) / (54 - 3)), { cost: 0, tax: 0 });
    expect(t.subtotal).toBe(18);
    expect(t.totalDiscount).toBe(2);
    expect(t.taxTotal).toBe(2.4);
    expect(t.grandTotal).toBe(18.4);
    expect(t.lineTaxes[0][0].amount).toBe(2.4);
  });

  it('units convert to base quantity from the original line', () => {
    const line = lineFromInvoice(item({ quantity: 2, quantityInBaseUnit: 24, conversionFactor: 12 }), 1, null);
    expect(line.baseQuantity).toBe(12);
  });
});
