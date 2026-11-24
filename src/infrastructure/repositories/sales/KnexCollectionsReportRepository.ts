import { Knex } from 'knex';
import { CollectionLine, CollectionsReportFilters, CollectionsReportRepository } from '../../../domain/repositories/sales';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * `PaymentsByEmployeeController::getCollectionsDetail()` — ما دخل الخزائن والبنوك من
 * العملاء (قيدٌ يُدخل نقداً ولا يُخرجه)، ناقصاً ما صُرف نقداً لمرتجعٍ، بلا سندٍ مُلغى
 * ولا قيد إلغائه، وبلا فتراتٍ مُقفلة.
 */
export class KnexCollectionsReportRepository implements CollectionsReportRepository {
  constructor(private readonly db: Knex) {}

  async cashAccounts() {
    const parents = (await this.db('accounting_settings').whereIn('key', ['cash_treasuries_parent', 'bank_accounts_parent']).pluck('account_id')).filter(Boolean).map(Number);
    if (!parents.length) return [];
    return (await this.db('accounts').whereIn('parent_id', parents).pluck('id')).map(Number);
  }

  /** `SalesLedger::cancelledEntryIds()` — آخر `#رقم` في وصف قيد الإلغاء (PCAN) */
  async cancelledEntryIds() {
    const texts = await this.db('journal_entries').where('reference_type', 'PCAN').where('status', 1).where('description', 'like', '%#%').pluck('description');
    const ids = new Set<number>();
    for (const t of texts) {
      const all = [...String(t).matchAll(/#(\d+)/g)];
      if (all.length) ids.add(Number(all[all.length - 1][1]));
    }
    return [...ids];
  }

  private scoped(q: Knex.QueryBuilder, f: CollectionsReportFilters) {
    q.whereBetween('j.date', [f.from, f.to]).where('j.status', 1).whereNotNull('j.client_id');
    if (f.nodeIds !== null) {
      const ids = f.nodeIds.length ? f.nodeIds : [0];
      q.whereIn('j.client_id', (s) => s.select('c2.id').from('clients as c2').where((w) => w.whereIn('c2.branch_id', ids).orWhereIn('c2.tree_node_id', ids)));
    }
    if (f.userIds !== null) q.whereIn('j.created_by_employee', f.userIds.length ? f.userIds : [0]);
    if (f.employeeId !== undefined) q.where('j.created_by_employee', f.employeeId);
    if (f.clientId !== undefined) q.where('j.client_id', f.clientId);
    for (const [from, to] of f.closedRanges) {
      const after = new Date(`${to}T00:00:00Z`);
      after.setUTCDate(after.getUTCDate() + 1);
      q.where((w) => w.where('j.date', '<', from).orWhere('j.date', '>=', after.toISOString().slice(0, 10)));
    }
    return q;
  }

  async lines(f: CollectionsReportFilters, cash: number[], cancelled: number[]): Promise<CollectionLine[]> {
    if (!cash.length) return [];
    const base = () =>
      this.db('journal_entry_details as d')
        .join('journal_entries as j', 'j.id', 'd.journal_entry_id')
        .leftJoin('clients as c', 'c.id', 'j.client_id')
        .leftJoin('users as u', 'u.id', 'j.created_by_employee')
        .leftJoin('accounts as a', 'a.id', 'd.account_id')
        .whereIn('d.account_id', cash);
    const cols = ['d.id as detail_id', 'j.id', 'j.date', 'j.reference_number', 'j.reference_type', 'j.description', 'j.client_id', 'c.trade_name as client_name', 'j.created_by_employee', 'u.name as employee_name', 'd.account_id', 'a.name as account_name', 'd.debit', 'd.credit'];

    const collections = this.scoped(base(), f)
      .where('d.debit', '>', 0)
      .whereNotExists((s) => s.select(this.db.raw(1)).from('journal_entry_details as x').whereRaw('x.journal_entry_id = d.journal_entry_id').whereIn('x.account_id', cash).where('x.credit', '>', 0));
    if (cancelled.length) collections.whereNotIn('j.id', cancelled);
    const refunds = this.scoped(base(), f).where('d.credit', '>', 0).where('j.reference_type', 'SR');

    const map = (isReturn: boolean) => (r: Record<string, unknown>): CollectionLine => ({
      entryId: Number(r.id),
      date: String(r.date).slice(0, 10),
      reference: str(r.reference_number),
      referenceType: str(r.reference_type),
      description: str(r.description),
      clientId: num(r.client_id),
      clientName: str(r.client_name),
      employeeId: num(r.created_by_employee),
      employeeName: str(r.employee_name),
      treasuryId: Number(r.account_id),
      treasuryName: str(r.account_name),
      amount: isReturn ? -Number(r.credit ?? 0) : Number(r.debit ?? 0),
      isReturn,
    });
    const [a, b] = await Promise.all([collections.select(cols), refunds.select(cols)]);
    return [...a.map(map(false)), ...b.map(map(true))];
  }
}
