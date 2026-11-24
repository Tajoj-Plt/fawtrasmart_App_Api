import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { ApprovalRepository, JournalEntryWrite, LedgerAccount, LedgerRepository } from '../../../domain/repositories/stock';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** حركة الكميات عند الاعتماد — `ProductDetails` بقفل الصفّ، فلا يضيع تحديثٌ متزامن */
export class KnexApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Knex) {}

  async firstStockRow(warehouseId: number, productId: number, tx: Tx) {
    const r = await conn(this.db, tx)('product_details').where('store_house_id', warehouseId).where('product_id', productId).orderBy('id').forUpdate().first('id', 'quantity');
    return r ? { id: Number(r.id), quantity: Number(r.quantity ?? 0) } : null;
  }

  async createStockRow(warehouseId: number, productId: number, quantity: number, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('product_details').insert({ store_house_id: warehouseId, product_id: productId, quantity, created_at: now, updated_at: now });
    return Number(id);
  }

  async addToStockRow(id: number, delta: number, now: string, tx: Tx) {
    await conn(this.db, tx)('product_details')
      .where('id', id)
      .update({ quantity: this.db.raw('quantity + ?', [delta]), updated_at: now });
  }

  async setPermitStatus(id: number, status: string, now: string, tx: Tx) {
    await conn(this.db, tx)('warehouse_permits').where('id', id).update({ status, updated_at: now });
  }

  async purchaseInvoiceForReceiving(id: number, tx: Tx) {
    const db = conn(this.db, tx);
    const inv = await db('purchase_invoices').where('id', id).first('id', 'receiving_status');
    if (!inv) return null;
    const items = await db('invoice_items as ii').leftJoin('products as p', 'p.id', 'ii.product_id').where('ii.purchase_invoice_id', id).orderBy('ii.id').select('ii.product_id', 'ii.quantity', 'p.name as product_name', 'p.id as pid');
    return {
      id: Number(inv.id),
      receivingStatus: str(inv.receiving_status),
      items: items.map((r: Record<string, unknown>) => ({ productId: Number(r.product_id), quantity: Number(r.quantity ?? 0), productName: r.pid === null ? null : str(r.product_name) ?? '' })),
    };
  }

  async markInvoiceReceived(id: number, date: string, now: string, tx: Tx) {
    await conn(this.db, tx)('purchase_invoices').where('id', id).update({ receiving_status: 'received', received_date: date, updated_at: now });
  }

  async adjustmentHasPendingPermits(adjustmentId: number, tx: Tx) {
    const r = await conn(this.db, tx)('warehouse_permits')
      .where('reference_type', 'STK')
      .where('reference_id', adjustmentId)
      .whereNotIn('status', ['approved', 'apporod', 'rejected', 'rejec'])
      .first('id');
    return Boolean(r);
  }

  async markAdjustment(id: number, status: string, adjustedAt: string | null, onlyIfStatus: string | null, now: string, tx: Tx) {
    const q = conn(this.db, tx)('inventory_adjustments').where('id', id);
    if (onlyIfStatus) q.where('status', onlyIfStatus);
    await q.update({ status, adjusted_at: adjustedAt, updated_at: now });
  }
}

function mapAccount(r: Record<string, unknown>): LedgerAccount {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    code: str(r.code),
    parentId: num(r.parent_id),
    balanceType: str(r.balance_type),
    balance: Number(r.balance ?? 0),
  };
}

const ACCOUNT_COLUMNS = ['id', 'name', 'code', 'parent_id', 'balance_type', 'balance'];

/** دفتر الأستاذ — `accounts` و`journal_entries` و`journal_entry_details` */
export class KnexLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Knex) {}

  async settingsMap() {
    const rows = await this.db('accounting_settings').where('is_active', 1).whereNotNull('account_id').select('key', 'account_id').catch(() => []);
    return new Map<string, number>((rows as Record<string, unknown>[]).map((r) => [String(r.key), Number(r.account_id)]));
  }

  async settingName(key: string) {
    const r = await this.db('accounting_settings').where('key', key).first('name').catch(() => null);
    return str(r?.name);
  }

  async account(id: number, tx: Tx) {
    const r = await conn(this.db, tx)('accounts').where('id', id).first(ACCOUNT_COLUMNS);
    return r ? mapAccount(r) : null;
  }

  async accountByStorehouse(storehouseId: number, tx: Tx) {
    const r = await conn(this.db, tx)('accounts').where('storehouse_id', storehouseId).orderBy('id').first(ACCOUNT_COLUMNS);
    return r ? mapAccount(r) : null;
  }

  async setAccountParent(id: number, parentId: number, now: string, tx: Tx) {
    await conn(this.db, tx)('accounts').where('id', id).update({ parent_id: parentId, updated_at: now });
  }

  async codesLike(prefix: string, tx: Tx) {
    const rows = await conn(this.db, tx)('accounts').where('code', 'like', `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).pluck('code');
    return rows.filter(Boolean).map(String);
  }

  async createWarehouseAccount(row: { name: string; code: string; parentId: number; storehouseId: number }, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('accounts').insert({
      name: row.name,
      code: row.code,
      parent_id: row.parentId,
      storehouse_id: row.storehouseId,
      account_type: 'assets',
      balance_type: 'debit',
      balance: 0,
      created_at: now,
      updated_at: now,
    });
    return Number(id);
  }

  async childIds(accountId: number, tx: Tx) {
    return (await conn(this.db, tx)('accounts').where('parent_id', accountId).orderBy('id').pluck('id')).map(Number);
  }

  async children(accountId: number, tx: Tx) {
    const rows = await conn(this.db, tx)('accounts').where('parent_id', accountId).orderBy('id').select('balance', 'balance_type');
    return rows.map((r: Record<string, unknown>) => ({ balance: Number(r.balance ?? 0), balanceType: str(r.balance_type) }));
  }

  async detailSums(accountId: number, tx: Tx) {
    const r = await conn(this.db, tx)('journal_entry_details').where('account_id', accountId).sum({ d: 'debit' }).sum({ c: 'credit' }).first();
    return { debit: Number((r as Record<string, unknown> | undefined)?.d ?? 0), credit: Number((r as Record<string, unknown> | undefined)?.c ?? 0) };
  }

  async setBalance(id: number, balance: number, now: string, tx: Tx) {
    // `save()` لا يلمس الصفّ إن لم يتغيّر شيء — فلا `updated_at` جديد بلا تغيير
    await conn(this.db, tx)('accounts').where('id', id).whereRaw('balance <> ?', [balance]).update({ balance, updated_at: now });
  }

  async lastReferenceNumber(type: string, year: string, tx: Tx) {
    const r = await conn(this.db, tx)('journal_entries')
      .where('reference_type', type)
      .where('reference_number', 'like', `${type}-${year}-%`)
      .orderByRaw("CAST(SUBSTRING_INDEX(reference_number, '-', -1) AS UNSIGNED) DESC")
      .first('reference_number');
    return str(r?.reference_number);
  }

  async insertEntry(row: JournalEntryWrite, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('journal_entries').insert({ ...row, created_at: now, updated_at: now });
    return Number(id);
  }

  async insertDetail(row: { journalEntryId: number; accountId: number; description: string; debit: number; credit: number; isDebit?: boolean }, now: string, tx: Tx) {
    const [id] = await conn(this.db, tx)('journal_entry_details').insert({
      journal_entry_id: row.journalEntryId,
      account_id: row.accountId,
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      ...(row.isDebit === undefined ? {} : { is_debit: row.isDebit ? 1 : 0 }),
      created_at: now,
      updated_at: now,
    });
    return Number(id);
  }

  async entriesToReverse(permitId: number, tx: Tx) {
    const rows = await conn(this.db, tx)('journal_entries')
      .where((q) => q.where('reference_id', permitId).orWhere('batch_reference', `WAREHOUSE_${permitId}`))
      .whereIn('reference_type', ['STK', 'AW', 'OPB'])
      .where((q) => q.whereNull('is_reversed').orWhere('is_reversed', 0))
      .where('reference_number', 'not like', 'REVERSE\\_%')
      .orderBy('id')
      .select('id', 'reference_number', 'description');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), referenceNumber: str(r.reference_number), description: str(r.description) }));
  }

  async details(entryId: number, tx: Tx) {
    const rows = await conn(this.db, tx)('journal_entry_details').where('journal_entry_id', entryId).orderBy('id').select('account_id', 'description', 'debit', 'credit');
    return rows.map((r: Record<string, unknown>) => ({ accountId: Number(r.account_id), description: str(r.description), debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0) }));
  }

  async markReversed(entryId: number, now: string, tx: Tx) {
    await conn(this.db, tx)('journal_entries').where('id', entryId).update({ is_reversed: 1, updated_at: now });
  }

  async setBatchReference(entryId: number, batch: string, tx: Tx) {
    await conn(this.db, tx)('journal_entries').where('id', entryId).update({ batch_reference: batch });
  }
}
