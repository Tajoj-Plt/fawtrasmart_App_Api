import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { ExchangeItemRow, ExchangeListFilters, ExchangeRepository, ExchangeRow } from '../../../domain/repositories/sales';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const COLUMNS = [
  'x.*',
  'c.trade_name as client_name',
  'e.first_name as employee_first',
  'e.middle_name as employee_middle',
  'u.name as created_by_name',
  'so.name as storehouse_name',
  'si.name as return_storehouse_name',
];

function map(r: Record<string, unknown>): ExchangeRow {
  return {
    id: Number(r.id),
    code: str(r.code),
    clientId: num(r.client_id),
    clientName: str(r.client_name),
    branchId: num(r.branch_id),
    employeeId: num(r.employee_id),
    employeeName: `${r.employee_first ?? ''} ${r.employee_middle ?? ''}`.trim() || null,
    createdBy: num(r.created_by),
    createdByName: str(r.created_by_name),
    storehouseId: num(r.storehouse_id),
    storehouseName: str(r.storehouse_name),
    returnStorehouseId: num(r.return_storehouse_id),
    returnStorehouseName: str(r.return_storehouse_name),
    exchangeDate: str(r.exchange_date),
    image: str(r.image),
    notes: str(r.notes),
    totalValue: Number(r.total_value ?? 0),
    status: num(r.status),
    createdAt: str(r.created_at),
  };
}

/** `product_exchanges` وبنودها وأسبابها وحدودها اليومية */
export class KnexExchangeRepository implements ExchangeRepository {
  constructor(private readonly db: Knex) {}

  private base(db: Knex) {
    return db('product_exchanges as x')
      .leftJoin('clients as c', 'c.id', 'x.client_id')
      .leftJoin('employees as e', 'e.id', 'x.employee_id')
      .leftJoin('users as u', 'u.id', 'x.created_by')
      .leftJoin('store_houses as so', 'so.id', 'x.storehouse_id')
      .leftJoin('store_houses as si', 'si.id', 'x.return_storehouse_id');
  }

  async reasons() {
    const rows = await this.db('exchange_reasons').where('is_active', 1).orderBy('sort_order').orderBy('id').select('id', 'name', 'description');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? ''), description: str(r.description) }));
  }

  async reasonIds() {
    return new Set((await this.db('exchange_reasons').where('is_active', 1).pluck('id')).map(Number));
  }

  async insert(row: Record<string, unknown>, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('product_exchanges').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async insertItem(row: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('product_exchange_items').insert({ ...row, created_at: now, updated_at: now });
  }

  async update(id: number, patch: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('product_exchanges').where('id', id).update({ ...patch, updated_at: now });
  }

  async dayQuantity(by: 'employee_id' | 'client_id', id: number, date: string, tx?: Tx) {
    const r = await conn(this.db, tx)('product_exchange_items as it')
      .join('product_exchanges as x', 'x.id', 'it.product_exchange_id')
      .where(`x.${by}`, id)
      .whereRaw('DATE(x.exchange_date) = ?', [date])
      .first(this.db.raw('COALESCE(SUM(it.quantity), 0) as q'));
    return Number((r as Record<string, unknown> | undefined)?.q ?? 0);
  }

  async employeeLimit(employeeId: number) {
    const r = await this.db('employees').where('id', employeeId).first('first_name', 'daily_qty_limit');
    return r ? { name: String(r.first_name ?? ''), limit: num(r.daily_qty_limit) } : null;
  }

  async clientLimit(clientId: number) {
    const r = await this.db('clients').where('id', clientId).first('daily_exchange_limit');
    return r ? num(r.daily_exchange_limit) : null;
  }

  /** «الحدّ العامّ للعميل» — `account_settings` صفٌّ واحد للمنشأة (الويب يقرؤه بمعرّف المستخدم فلا يجده غيرُ صاحبه) */
  async globalClientLimit() {
    const r = await this.db('account_settings').whereNotNull('global_client_exchange_limit').orderBy('id').first('global_client_exchange_limit').catch(() => null);
    return r ? num(r.global_client_exchange_limit) : null;
  }

  async page(f: ExchangeListFilters, page: number, perPage: number) {
    const q = this.db('product_exchanges as x');
    const { branchIds, userIds, employeeIds } = f.scope;
    if (branchIds !== null) q.whereIn('x.branch_id', branchIds.length ? branchIds : [0]);
    else if (userIds !== null) q.where((w) => w.whereIn('x.created_by', userIds.length ? userIds : [0]).orWhereIn('x.employee_id', employeeIds && employeeIds.length ? employeeIds : [0]));
    if (f.headerBranchIds !== null) q.where((w) => w.whereIn('x.branch_id', f.headerBranchIds as number[]).orWhereNull('x.branch_id'));
    if (f.clientId !== undefined) q.where('x.client_id', f.clientId);
    if (f.code) q.where('x.code', 'like', likeTerm(f.code));
    if (f.branch !== undefined) q.where('x.branch_id', f.branch);
    if (f.fromDate) q.whereRaw('DATE(x.exchange_date) >= ?', [f.fromDate]);
    if (f.toDate) q.whereRaw('DATE(x.exchange_date) <= ?', [f.toDate]);
    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'x.id' });
    const ids = (await q.clone().orderBy('x.exchange_date', 'desc').orderBy('x.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('x.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c) };
    const rows = await this.base(this.db).whereIn('x.id', ids).orderBy('x.exchange_date', 'desc').orderBy('x.id', 'desc').select(COLUMNS);
    return { rows: rows.map(map), total: Number(c) };
  }

  async find(id: number) {
    const r = await this.base(this.db).where('x.id', id).first(COLUMNS);
    return r ? map(r) : null;
  }

  async items(id: number): Promise<ExchangeItemRow[]> {
    const rows = await this.db('product_exchange_items as it')
      .leftJoin('products as p', 'p.id', 'it.product_id')
      .leftJoin('exchange_reasons as r', 'r.id', this.db.raw('COALESCE(it.reason_id, it.exchange_reason_id)'))
      .where('it.product_exchange_id', id)
      .orderBy('it.id')
      .select('it.id', 'it.product_id', 'p.name as product_name', 'it.quantity', 'it.unit_price', 'it.total', 'it.reason_id', 'it.exchange_reason_id', 'r.name as reason_name', 'it.reason_notes');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      productId: Number(r.product_id),
      productName: str(r.product_name),
      quantity: Number(r.quantity ?? 0),
      unitPrice: Number(r.unit_price ?? 0),
      total: Number(r.total ?? 0),
      reasonId: num(r.reason_id) ?? num(r.exchange_reason_id),
      reasonName: str(r.reason_name),
      reasonNotes: str(r.reason_notes),
    }));
  }
}
