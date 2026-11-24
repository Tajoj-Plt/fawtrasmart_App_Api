import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { SalesWriteRepository, StockRow } from '../../../domain/repositories/sales';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** كتابة مستندات المبيعات — `invoices` وبنودها وضرائبها وسنداتها وأذون مخزونها */
export class KnexSalesWriteRepository implements SalesWriteRepository {
  constructor(private readonly db: Knex) {}

  async insertInvoice(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('invoices').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async updateInvoice(id: number, patch: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('invoices').where('id', id).update({ ...patch, updated_at: now });
  }

  async insertItem(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('invoice_items').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async freezeItemCost(itemId: number, unitCost: number, tx: Tx) {
    await conn(this.db, tx)('invoice_items').where('id', itemId).whereNull('unit_cost_at_sale').update({ unit_cost_at_sale: unitCost });
  }

  async insertTaxRows(rows: Array<Record<string, unknown>>, now: string, tx: Tx) {
    if (rows.length) await conn(this.db, tx)('taxs_invoice').insert(rows.map((r) => ({ ...r, created_at: now, updated_at: now })));
  }

  async insertLogs(rows: Array<Record<string, unknown>>, now: string, tx: Tx) {
    if (rows.length) await conn(this.db, tx)('logs').insert(rows.map((r) => ({ ...r, created_at: now, updated_at: now })));
  }

  async insertRawNotifications(rows: Array<Record<string, unknown>>, now: string, tx: Tx) {
    if (rows.length) await conn(this.db, tx)('notifications').insert(rows.map((r) => ({ ...r, created_at: now, updated_at: now })));
  }

  async insertPayment(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('payments_process').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async lastDepositCount(clientId: number, tx: Tx) {
    const r = await conn(this.db, tx)('client_relations').where('client_id', clientId).whereNotNull('deposit_count').where('deposit_count', '>', 0).orderBy('created_at', 'desc').orderBy('id', 'desc').first('deposit_count');
    return r ? Math.trunc(Number(r.deposit_count)) : 0;
  }

  async insertClientRelation(row: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('client_relations').insert({ ...row, created_at: now, updated_at: now });
  }

  async recordCouponUsage(couponId: number, clientId: number | null, invoiceId: number, discount: number, now: string, tx: Tx) {
    const db = conn(this.db, tx);
    const existing = await db('store_coupon_usages').where('coupon_id', couponId).where('invoice_id', invoiceId).first('id');
    if (existing) {
      await db('store_coupon_usages').where('id', existing.id).update({ discount_amount: discount, client_id: clientId, updated_at: now });
      return;
    }
    await db('store_coupon_usages').insert({ coupon_id: couponId, client_id: clientId, invoice_id: invoiceId, discount_amount: discount, created_at: now, updated_at: now });
    await db('store_coupons').where('id', couponId).increment('used_count', 1);
  }

  async lockStock(pairs: Array<[number, number]>, tx: Tx) {
    const out = new Map<string, StockRow>();
    if (!pairs.length) return out;
    const products = [...new Set(pairs.map((p) => p[0]))];
    const warehouses = [...new Set(pairs.map((p) => p[1]))];
    const rows = await conn(this.db, tx)('product_details').whereIn('product_id', products).whereIn('store_house_id', warehouses).orderBy('id').forUpdate().select('id', 'product_id', 'store_house_id', 'quantity');
    // `keyBy()` — الصفّ الأخير للمفتاح نفسه هو المعتمد في الويب
    for (const r of rows as Record<string, unknown>[]) out.set(`${r.product_id}_${r.store_house_id}`, { id: Number(r.id), quantity: Number(r.quantity ?? 0) });
    return out;
  }

  async createStockRow(productId: number, warehouseId: number, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('product_details').insert({ store_house_id: warehouseId, product_id: productId, quantity: 0, created_at: now, updated_at: now });
    return { id: Number(id), quantity: 0 };
  }

  async addStock(id: number, delta: number, now: string, tx: Tx) {
    await conn(this.db, tx)('product_details').where('id', id).update({ quantity: this.db.raw('quantity + ?', [delta]), updated_at: now });
  }

  async insertPermit(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('warehouse_permits').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async insertPermitLine(row: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits_products').insert({ ...row, created_at: now, updated_at: now });
  }

  async permissionSourceExists(id: number, tx: Tx) {
    return Boolean(await conn(this.db, tx)('permission_sources').where('id', id).first('id'));
  }

  async employeeLocation(userId: number, tx?: Tx) {
    const r = await conn(this.db, tx)('locations').where('employee_id', userId).whereNull('client_id').orderBy('created_at', 'desc').orderBy('id', 'desc').first('id', 'latitude', 'longitude');
    return r ? { id: Number(r.id), latitude: num(r.latitude), longitude: num(r.longitude) } : null;
  }

  async saveEmployeeLocation(existingId: number | null, userId: number, latitude: number, longitude: number, now: string) {
    if (existingId) await this.db('locations').where('id', existingId).update({ latitude, longitude, updated_at: now });
    else await this.db('locations').insert({ employee_id: userId, latitude, longitude, created_at: now, updated_at: now });
  }

  async insertWalletTransaction(row: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('client_wallet_transactions').insert({ ...row, created_at: now, updated_at: now });
  }

  async clientPoint(clientId: number) {
    const r = await this.db('locations').where('client_id', clientId).whereNull('client_relation_id').orderBy('created_at', 'desc').orderBy('id', 'desc').first('latitude', 'longitude');
    return r ? { latitude: num(r.latitude), longitude: num(r.longitude) } : null;
  }
}
