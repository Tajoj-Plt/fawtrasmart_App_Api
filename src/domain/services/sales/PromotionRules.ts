import { phpRound, round2 } from './SalesMath';

// ═══════════════════════ عروض الحسم ═══════════════════════

/** صفّ `offers` بمحاوره — `OfferDiscountService` */
export interface DiscountOffer {
  id: number;
  name: string | null;
  /** 1 لكل وحدة · 2 لكل مضاعف كمية */
  type: number;
  quantity: number | null;
  /** 1 مبلغ · 2 نسبة */
  discountType: number;
  discountValue: number;
  /** 1 كل المنتجات · 2 تصنيفات · 3 منتجات */
  unitType: number;
  productIds: number[];
  categoryIds: number[];
  clientIds: number[];
}

/** `coversClient()` — القائمة الفارغة تعني كل العملاء */
export function offerCoversClient(offer: DiscountOffer, clientId: number | null): boolean {
  if (offer.clientIds.length === 0) return true;
  return clientId !== null && offer.clientIds.includes(clientId);
}

function coversProduct(offer: DiscountOffer, productId: number, categoryId: number | null): boolean {
  if (offer.unitType === 3) return offer.productIds.includes(productId);
  if (offer.unitType === 2) return categoryId !== null && offer.categoryIds.includes(categoryId);
  return true;
}

function offerAmount(offer: DiscountOffer, quantity: number, lineTotal: number): number {
  const value = offer.discountValue;
  if (value <= 0) return 0;
  const threshold = Math.max(1, Number(offer.quantity ?? 0));
  if (offer.type === 2 && quantity < threshold) return 0;

  let amount: number;
  if (offer.discountType === 2) amount = (lineTotal * value) / 100;
  else if (offer.type === 1) amount = value * quantity;
  else amount = value * Math.floor(quantity / threshold);

  return round2(Math.min(amount, lineTotal));
}

/** `lineDiscount()` — أفضل عرضٍ للبند، أو `null` */
export function bestOfferDiscount(
  offers: DiscountOffer[],
  productId: number,
  categoryId: number | null,
  quantity: number,
  lineTotal: number,
): { offerId: number; name: string; amount: number } | null {
  if (!productId || quantity <= 0 || lineTotal <= 0 || offers.length === 0) return null;

  let best: { offerId: number; name: string; amount: number } | null = null;
  for (const offer of offers) {
    if (!coversProduct(offer, productId, categoryId)) continue;
    const amount = offerAmount(offer, quantity, lineTotal);
    if (amount <= 0) continue;
    if (best === null || amount > best.amount) best = { offerId: offer.id, name: offer.name || `#${offer.id}`, amount };
  }
  return best;
}

// ═══════════════════════ عروض الهدايا ═══════════════════════

export interface GiftOffer {
  id: number;
  targetProductId: number | null;
  minQuantity: number;
  giftProductId: number | null;
  giftQuantity: number;
}

/**
 * أفضل هديةٍ لبند — الأعلى `gift_quantity` بين العروض المطابقة (الأسبق عند
 * التساوي)، مضروبةً في `floor(الكمية الأساسية ÷ الحدّ الأدنى)`. عرضٌ حدُّه صفر
 * لا يُطبَّق (القسمة عليه تُسقط الفاتورة في الويب).
 */
export function bestGift(offers: GiftOffer[], productId: number, baseQuantity: number): { offer: GiftOffer; quantity: number } | null {
  const valid = offers.filter((o) => o.minQuantity > 0 && (!o.targetProductId || o.targetProductId === productId) && baseQuantity >= o.minQuantity);
  if (!valid.length) return null;

  let best = valid[0];
  for (const o of valid) if (o.giftQuantity > best.giftQuantity) best = o;

  const quantity = best.giftQuantity * Math.floor(baseQuantity / best.minQuantity);
  return quantity > 0 ? { offer: best, quantity } : null;
}

// ═══════════════════════ الكوبونات ═══════════════════════

export interface Coupon {
  id: number;
  code: string;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minOrderAmount: number | null;
  maxDiscount: number | null;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  applicableProducts: number[];
  applicableCategories: number[];
  excludedProducts: number[];
  applicableClients: number[];
  firstOrderOnly: boolean;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
}

/** ما يحتاجه تقييم الكوبون من القاعدة — يُجلب عند الحاجة فقط */
export interface CouponFacts {
  now: string;
  usageCount: () => Promise<number>;
  clientUsageCount: () => Promise<number>;
  hasEarlierPurchase: () => Promise<boolean>;
  productsInCategories: (categoryIds: number[]) => Promise<boolean>;
}

export type CouponResult = { ok: true; coupon: Coupon; discount: number; freeShipping: boolean } | { ok: false; error: string | null };

const COUPON_MESSAGES = {
  notFound: 'لا يوجد كوبون بالرمز :code',
  inactive: 'الكوبون :code موقوف',
  notStarted: 'الكوبون لا يبدأ قبل :date',
  expired: 'انتهت صلاحية الكوبون في :date',
  limitReached: 'بلغ الكوبون حدَّ استعماله المسموح',
  clientLimitReached: 'بلغ هذا العميل حدَّ استعماله لهذا الكوبون',
  clientNotEligible: 'الكوبون مخصَّصٌ لعملاء آخرين',
  firstOrderOnly: 'الكوبون لأوّل عمليةِ شراءٍ للعميل، وله مشترياتٌ سابقة',
  minAmount: 'الكوبون يشترط حدّاً أدنى للمستند قدرُه :amount',
  excludedProduct: 'المستند يحوي منتجاً مستثنى من الكوبون',
  noEligibleProduct: 'لا يوجد في المستند منتجٌ يشمله الكوبون',
  noShipping: 'كوبون الشحن المجانيّ لا يُطبَّق على مستندٍ بلا شحن',
  zeroDiscount: 'خصم الكوبون على هذا المستند صفر',
  disabled: 'الكوبونات مطفأةٌ من «إعدادات الفواتير»',
};

export const couponMessage = (key: keyof typeof COUPON_MESSAGES, params: Record<string, string> = {}) =>
  Object.entries(params).reduce((m, [k, v]) => m.replace(`:${k}`, v), COUPON_MESSAGES[key]);

const money = (n: number) => phpRound(n, 2).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `SalesCouponService::evaluate()` — بالترتيب نفسه والرسائل نفسها */
export async function evaluateCoupon(
  coupon: Coupon | null,
  code: string,
  clientId: number | null,
  amount: number,
  productIds: number[],
  shippingCost: number,
  facts: CouponFacts,
): Promise<CouponResult> {
  if (!coupon) return { ok: false, error: couponMessage('notFound', { code }) };
  if (!coupon.isActive) return { ok: false, error: couponMessage('inactive', { code: coupon.code }) };
  if (coupon.startDate && coupon.startDate > facts.now) return { ok: false, error: couponMessage('notStarted', { date: coupon.startDate.slice(0, 10) }) };
  if (coupon.endDate && coupon.endDate < facts.now) return { ok: false, error: couponMessage('expired', { date: coupon.endDate.slice(0, 10) }) };
  if (coupon.usageLimit && (await facts.usageCount()) >= coupon.usageLimit) return { ok: false, error: couponMessage('limitReached') };
  if (coupon.applicableClients.length && (!clientId || !coupon.applicableClients.includes(clientId))) return { ok: false, error: couponMessage('clientNotEligible') };
  if (clientId && coupon.usageLimitPerUser && (await facts.clientUsageCount()) >= coupon.usageLimitPerUser) return { ok: false, error: couponMessage('clientLimitReached') };
  if (clientId && coupon.firstOrderOnly && (await facts.hasEarlierPurchase())) return { ok: false, error: couponMessage('firstOrderOnly') };
  if (coupon.minOrderAmount && amount < coupon.minOrderAmount) return { ok: false, error: couponMessage('minAmount', { amount: money(coupon.minOrderAmount) }) };

  const ids = productIds.filter(Boolean);
  if (coupon.excludedProducts.length && ids.some((id) => coupon.excludedProducts.includes(id))) return { ok: false, error: couponMessage('excludedProduct') };

  const hasProducts = coupon.applicableProducts.length > 0;
  const hasCategories = coupon.applicableCategories.length > 0;
  if (hasProducts || hasCategories) {
    const byProduct = hasProducts && ids.some((id) => coupon.applicableProducts.includes(id));
    const byCategory = !byProduct && hasCategories && ids.length > 0 && (await facts.productsInCategories(coupon.applicableCategories));
    if (!byProduct && !byCategory) return { ok: false, error: couponMessage('noEligibleProduct') };
  }

  if (coupon.type === 'free_shipping') {
    if (shippingCost <= 0) return { ok: false, error: couponMessage('noShipping') };
    return { ok: true, coupon, discount: 0, freeShipping: true };
  }

  let discount = coupon.type === 'percentage' ? (amount * coupon.value) / 100 : coupon.value;
  if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
  discount = round2(Math.min(discount, Math.max(0, amount)));
  if (discount <= 0) return { ok: false, error: couponMessage('zeroDiscount') };

  return { ok: true, coupon, discount, freeShipping: false };
}
