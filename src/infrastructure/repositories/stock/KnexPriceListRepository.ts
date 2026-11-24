import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { PriceListRepository, PriceListRow } from '../../../domain/repositories/stock';
import { conn } from '../../db/KnexUnitOfWork';

const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function mapList(r: Record<string, unknown>): PriceListRow {
  return { id: Number(r.id), name: String(r.name ?? ''), status: Number(r.status ?? 0), createdAt: r.created_at === null || r.created_at === undefined ? null : String(r.created_at) };
}

/** قوائم الأسعار — `price_lists` وأسطر ربطها `price_list_items` */
export class KnexPriceListRepository implements PriceListRepository {
  constructor(private readonly db: Knex) {}

  async page(f: { keywords?: string; product?: number; category?: number; brand?: number; status?: number }, page: number, perPage: number) {
    const q = this.db('price_lists as l');
    if (f.keywords) q.where('l.name', 'like', likeTerm(f.keywords));
    const viaProducts = (apply: (s: Knex.QueryBuilder) => void) =>
      q.whereExists((s) => {
        s.select(this.db.raw(1)).from('price_list_items as i').join('products as p', 'p.id', 'i.product_id').whereRaw('i.price_list_id = l.id');
        apply(s);
      });
    if (f.product !== undefined) q.whereExists((s) => s.select(this.db.raw(1)).from('price_list_items as i').whereRaw('i.price_list_id = l.id').where('i.product_id', f.product));
    if (f.category !== undefined) viaProducts((s) => s.where('p.category_id', f.category));
    if (f.brand !== undefined) viaProducts((s) => s.where('p.brand_id', f.brand));
    if (f.status !== undefined) q.where('l.status', f.status);

    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'l.id' });
    const rows = await q.orderBy('l.id', 'desc').limit(perPage).offset((page - 1) * perPage).select('l.id', 'l.name', 'l.status', 'l.created_at');
    return { rows: rows.map(mapList), total: Number(c) };
  }

  async find(id: number) {
    const r = await this.db('price_lists').where('id', id).first('id', 'name', 'status', 'created_at');
    return r ? mapList(r) : null;
  }

  async items(listId: number) {
    const rows = await this.db('price_list_items as i').join('products as p', 'p.id', 'i.product_id').where('i.price_list_id', listId).orderBy('i.id').select('i.id as item_id', 'p.id', 'p.name', 'p.sale_price');
    return rows.map((r: Record<string, unknown>) => ({ itemId: Number(r.item_id), productId: Number(r.id), name: String(r.name ?? ''), salePrice: Number(r.sale_price ?? 0) }));
  }

  async visibleProducts(scope: { warehouseIds: number[] | null; creatorIds: number[] | null }, productId?: number) {
    const q = this.db('products as p').orderBy('p.id').select('p.id', 'p.name', 'p.sale_price');
    if (productId !== undefined) q.where('p.id', productId);
    if (scope.warehouseIds !== null) {
      if (scope.warehouseIds.length) {
        const ids = scope.warehouseIds;
        q.whereExists((s) => s.select(this.db.raw(1)).from('product_details as d').whereRaw('d.product_id = p.id').whereIn('d.store_house_id', ids));
      } else if (scope.creatorIds !== null) {
        q.whereIn('p.created_by', scope.creatorIds.length ? scope.creatorIds : [0]);
      }
    }
    const rows = await q;
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), salePrice: Number(r.sale_price ?? 0) }));
  }

  async productExists(id: number) {
    return Boolean(await this.db('products').where('id', id).first('id'));
  }

  async itemExists(id: number) {
    return Boolean(await this.db('price_list_items').where('id', id).first('id'));
  }

  async insert(row: { name: string; status: number }, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('price_lists').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async update(id: number, row: { name: string; status: number }, now: string, tx: Tx) {
    await conn(this.db, tx)('price_lists').where('id', id).update({ ...row, updated_at: now });
  }

  async delete(id: number, tx: Tx) {
    await conn(this.db, tx)('price_lists').where('id', id).delete();
  }

  async addItem(listId: number, productId: number, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('price_list_items').insert({ price_list_id: listId, product_id: productId, created_at: now, updated_at: now });
    return Number(id);
  }

  async setProductSalePrice(productId: number, price: number, now: string, tx: Tx) {
    await conn(this.db, tx)('products').where('id', productId).update({ sale_price: price, updated_at: now });
  }

  async deleteItem(id: number, tx: Tx) {
    await conn(this.db, tx)('price_list_items').where('id', id).delete();
  }

  async log(type: string, typeId: number, description: string, userId: number, now: string, tx: Tx) {
    await conn(this.db, tx)('logs').insert({ type, type_id: typeId, type_log: 'log', description, created_by: userId, created_at: now, updated_at: now });
  }
}
