import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import {
  PeriodGuardRepository,
  PeriodSettings,
  PermitHeaderWrite,
  PermitItemRow,
  PermitLineWrite,
  PermitListFilters,
  PermitRepository,
  PermitRow,
  StockedProductOption,
  UsageCounter,
} from '../../../domain/repositories/stock';
import { STOCKED_PRODUCT_TYPES } from '../../../domain/services/stock/StockConstants';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const PERMIT_COLUMNS = [
  'w.id',
  'w.number',
  'w.permission_type',
  'w.permission_date',
  'w.status',
  'w.store_houses_id',
  'w.from_store_houses_id',
  'w.to_store_houses_id',
  'w.permission_source_id',
  'w.reference_type',
  'w.reference_id',
  'w.sub_account',
  'w.details',
  'w.grand_total',
  'w.currency',
  'w.attachments',
  'w.rejection_reason',
  'w.created_by',
  'u.name as created_by_name',
  'sh.name as warehouse_name',
  'fsh.name as from_warehouse_name',
  'tsh.name as to_warehouse_name',
];

function mapPermit(r: Record<string, unknown>): PermitRow {
  return {
    id: Number(r.id),
    number: str(r.number),
    permissionType: num(r.permission_type),
    permissionDate: str(r.permission_date),
    status: str(r.status),
    storeHousesId: num(r.store_houses_id),
    fromWarehouseId: num(r.from_store_houses_id),
    toWarehouseId: num(r.to_store_houses_id),
    permissionSourceId: num(r.permission_source_id),
    referenceType: str(r.reference_type),
    referenceId: num(r.reference_id),
    subAccount: num(r.sub_account),
    details: str(r.details),
    grandTotal: Number(r.grand_total ?? 0),
    currency: str(r.currency),
    attachments: str(r.attachments),
    rejectionReason: str(r.rejection_reason),
    createdBy: num(r.created_by),
    createdByName: str(r.created_by_name),
    warehouseName: str(r.warehouse_name),
    fromWarehouseName: str(r.from_warehouse_name),
    toWarehouseName: str(r.to_warehouse_name),
  };
}

/**
 * الأذون المخزنية — `warehouse_permits` وبنودها `warehouse_permits_products`،
 * والرصيد من `product_details`. الكمية لا تتحرّك هنا: الاعتماد وحده يحرّكها.
 */
export class KnexPermitRepository implements PermitRepository {
  constructor(private readonly db: Knex) {}

  private base(db: Knex) {
    return db('warehouse_permits as w')
      .leftJoin('users as u', 'u.id', 'w.created_by')
      .leftJoin('store_houses as sh', 'sh.id', 'w.store_houses_id')
      .leftJoin('store_houses as fsh', 'fsh.id', 'w.from_store_houses_id')
      .leftJoin('store_houses as tsh', 'tsh.id', 'w.to_store_houses_id');
  }

  async page(f: PermitListFilters, page: number, perPage: number) {
    const q = this.db('warehouse_permits as w');

    if (f.creatorIds !== null) q.whereIn('w.created_by', f.creatorIds.length ? f.creatorIds : [0]);
    if (f.warehouseIds !== null) {
      const ids = f.warehouseIds.length ? f.warehouseIds : [0];
      q.where((w) => w.whereIn('w.store_houses_id', ids).orWhereIn('w.from_store_houses_id', ids).orWhereIn('w.to_store_houses_id', ids));
    }

    if (f.branch !== undefined) q.whereExists((s) => s.select(this.db.raw(1)).from('users as bu').whereRaw('bu.id = w.created_by').where('bu.branch_id', f.branch));
    if (f.keywords) {
      const term = likeTerm(f.keywords);
      q.where((w) => w.where('w.number', 'like', term).orWhere('w.details', 'like', term));
    }
    if (f.permissionType !== undefined) q.where('w.permission_type', f.permissionType);
    if (f.permissionSource !== undefined) q.where('w.permission_source_id', f.permissionSource);
    if (f.warehouse !== undefined) q.where('w.store_houses_id', f.warehouse);
    if (f.client !== undefined) q.where('w.sub_account', f.client);
    if (f.supplier !== undefined) q.where('w.sub_account', f.supplier);
    if (f.status !== undefined) q.where('w.status', f.status);
    if (f.currency !== null) q.where('w.currency', f.currency);
    if (f.createdBy !== undefined) q.where('w.created_by', f.createdBy);
    if (f.product !== undefined) {
      q.whereExists((s) => s.select(this.db.raw(1)).from('warehouse_permits_products as pp').whereRaw('pp.warehouse_permits_id = w.id').where('pp.product_id', f.product));
    }
    if (f.periodIds !== null) {
      if (f.periodIds.length === 0) q.whereNull('w.accounting_period_id');
      else q.whereIn('w.accounting_period_id', f.periodIds);
    }
    if (f.fromDate) q.whereRaw('DATE(w.permission_date) >= ?', [f.fromDate]);
    if (f.toDate) q.whereRaw('DATE(w.permission_date) <= ?', [f.toDate]);

    const [{ c }] = await q.clone().count<{ c: number }[]>({ c: 'w.id' });
    const ids = (await q.clone().orderBy('w.id', 'desc').limit(perPage).offset((page - 1) * perPage).pluck('w.id')).map(Number);
    if (!ids.length) return { rows: [], total: Number(c) };

    const rows = await this.base(this.db).whereIn('w.id', ids).orderBy('w.id', 'desc').select(PERMIT_COLUMNS);
    return { rows: rows.map(mapPermit), total: Number(c) };
  }

  async find(id: number, tx?: Tx, lock = false) {
    const db = conn(this.db, tx);
    if (lock) await db('warehouse_permits').where('id', id).forUpdate().first('id');
    const r = await this.base(db).where('w.id', id).first(PERMIT_COLUMNS);
    return r ? mapPermit(r) : null;
  }

  async items(permitId: number, tx?: Tx): Promise<PermitItemRow[]> {
    const rows = await conn(this.db, tx)('warehouse_permits_products as i')
      .leftJoin('products as p', 'p.id', 'i.product_id')
      .where('i.warehouse_permits_id', permitId)
      .orderBy('i.id')
      .select('i.id', 'i.product_id', 'p.name as product_name', 'i.quantity', 'i.unit_price', 'i.total');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      productId: Number(r.product_id),
      productName: str(r.product_name),
      quantity: Number(r.quantity ?? 0),
      unitPrice: Number(r.unit_price ?? 0),
      total: Number(r.total ?? 0),
    }));
  }

  async logs(permitId: number) {
    const rows = await this.db('logs').where('type', 'warehouse_permit_log').where('type_id', permitId).orderBy('created_at', 'desc').select('created_at', 'description');
    return rows.map((r: Record<string, unknown>) => ({ date: str(r.created_at), description: str(r.description) }));
  }

  async stockedProducts(): Promise<StockedProductOption[]> {
    const rows = await this.db('products').whereIn('type', STOCKED_PRODUCT_TYPES).orderBy('id').select('id', 'name', 'barcode', 'purchase_price', 'sale_price');
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      barcode: str(r.barcode),
      purchasePrice: Number(r.purchase_price ?? 0),
      salePrice: Number(r.sale_price ?? 0),
    }));
  }

  async productsByIds(ids: number[]) {
    const unique = [...new Set(ids)];
    const out = new Map<number, { id: number; name: string; status: string | null; type: string | null }>();
    if (!unique.length) return out;
    const rows = await this.db('products').whereIn('id', unique).select('id', 'name', 'status', 'type');
    for (const r of rows as Record<string, unknown>[]) out.set(Number(r.id), { id: Number(r.id), name: String(r.name ?? ''), status: str(r.status), type: str(r.type) });
    return out;
  }

  async existingWarehouseIds(ids: number[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Set<number>();
    return new Set((await this.db('store_houses').whereIn('id', unique).pluck('id')).map(Number));
  }

  async stockOf(warehouseId: number | null, productId: number, tx?: Tx) {
    const q = conn(this.db, tx)('product_details').where('product_id', productId);
    if (warehouseId === null) q.whereNull('store_house_id');
    else q.where('store_house_id', warehouseId);
    const r = await q.sum<{ s: number | null }[]>({ s: 'quantity' }).first();
    return Number((r as { s?: number | null } | undefined)?.s ?? 0);
  }

  async insert(header: PermitHeaderWrite, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('warehouse_permits').insert({ ...header, status: 'pending', created_at: now, updated_at: now });
    return Number(id);
  }

  async update(id: number, patch: Record<string, unknown>, now: string, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits').where('id', id).update({ ...patch, updated_at: now });
  }

  async insertLines(permitId: number, lines: PermitLineWrite[], now: string, tx: Tx) {
    if (!lines.length) return;
    await conn(this.db, tx)('warehouse_permits_products').insert(
      lines.map((l) => ({
        warehouse_permits_id: permitId,
        product_id: l.productId,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        total: l.total,
        stock_before: l.stockBefore,
        stock_after: l.stockAfter,
        created_at: now,
        updated_at: now,
      })),
    );
  }

  async deleteLines(permitId: number, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits_products').where('warehouse_permits_id', permitId).delete();
  }

  async delete(id: number, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits').where('id', id).delete();
  }

  async setRejected(id: number, reason: string | null, userId: number, now: string, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits').where('id', id).update({ status: 'rejec', rejection_reason: reason, rejected_by: userId, rejected_at: now, updated_at: now });
  }
}

/** `AccountingPeriodService` — الإعدادات والفترة والسنة لتاريخٍ ما */
export class KnexPeriodGuardRepository implements PeriodGuardRepository {
  constructor(private readonly db: Knex) {}

  async settings(): Promise<PeriodSettings> {
    const r = await this.db('accounting_period_settings').first().catch(() => null);
    return {
      enforceLock: r ? bool(r.enforce_lock) : false,
      lockBeforeDate: r?.lock_before_date ? String(r.lock_before_date).slice(0, 10) : null,
      blockUndefinedDates: r ? bool(r.block_undefined_dates) : false,
      blockFutureDates: r ? bool(r.block_future_dates) : false,
      defaultPeriodType: String(r?.default_period_type ?? 'monthly'),
      overridePermission: r ? str(r.override_permission) : 'settings.accounting_periods.override',
    };
  }

  async periodFor(date: string) {
    const r = await this.db('accounting_periods').whereRaw('DATE(start_date) <= ?', [date]).whereRaw('DATE(end_date) >= ?', [date]).first('id', 'name', 'status', 'fiscal_year_id');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), status: String(r.status ?? ''), fiscalYearId: num(r.fiscal_year_id) } : null;
  }

  async fiscalYear(id: number) {
    const r = await this.db('fiscal_years').where('id', id).first('id', 'name', 'status');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), status: String(r.status ?? '') } : null;
  }

  async fiscalYearFor(date: string) {
    const r = await this.db('fiscal_years').whereRaw('DATE(start_date) <= ?', [date]).whereRaw('DATE(end_date) >= ?', [date]).first('id', 'name', 'status');
    return r ? { id: Number(r.id), name: String(r.name ?? ''), status: String(r.status ?? '') } : null;
  }
}

/** `UsageReporter::measure()` — الجداول المعدودة بلا حذفٍ ناعم، فالعدّ صفوفٌ كلّها */
export class KnexUsageCounter implements UsageCounter {
  constructor(private readonly db: Knex) {}

  async count(table: string, from?: string, to?: string, where?: [string, Array<string | number>]) {
    try {
      const q = this.db(table);
      if (where) q.whereIn(where[0], where[1]);
      if (from) q.whereBetween('created_at', [from, to ?? from]);
      const [{ c }] = await q.count<{ c: number }[]>({ c: '*' });
      return Number(c);
    } catch {
      return null;
    }
  }
}
