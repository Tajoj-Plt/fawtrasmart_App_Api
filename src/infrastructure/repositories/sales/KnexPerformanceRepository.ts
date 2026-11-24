import { Knex } from 'knex';
import { PerformanceRepository, TargetKind } from '../../../domain/repositories/sales';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const TABLES: Record<TargetKind, { targets: string; achievements: string; tiers: string; fk: string }> = {
  sales: { targets: 'sales_targets', achievements: 'sales_target_achievements', tiers: 'sales_target_commission_tiers', fk: 'sales_target_id' },
  collections: { targets: 'collections_targets', achievements: 'collections_target_achievements', tiers: 'collections_target_commission_tiers', fk: 'collections_target_id' },
};

/** أهداف الموظف وعمولاته — `TargetCalculationService` و`sales_target_settlements` */
export class KnexPerformanceRepository implements PerformanceRepository {
  constructor(private readonly db: Knex) {}

  async accountId(key: string): Promise<number | null> {
    const r = await this.db('accounting_settings').where('key', key).first('account_id').catch(() => null);
    return r && r.account_id ? Number(r.account_id) : null;
  }

  async calculationMethod(kind: TargetKind) {
    const r = await this.db('target_settings').where('target_type', kind).first('calculation_method').catch(() => null);
    return str(r?.calculation_method);
  }

  async targetsFor(kind: TargetKind, userId: number) {
    const t = TABLES[kind];
    const rows = await this.db(`${t.achievements} as a`)
      .join(`${t.targets} as t`, 't.id', `a.${t.fk}`)
      .where('a.employee_id', userId)
      .where('t.status', 'active')
      .orderBy('t.id')
      .select('t.id', 't.name', 't.commission_period', 't.commission_percentage', 'a.target_amount');
    const ids = rows.map((r: Record<string, unknown>) => Number(r.id));
    const tiers = ids.length ? await this.db(t.tiers).whereIn(t.fk, ids).orderBy('tier_order').select(t.fk, 'achievement_percentage', 'commission_percentage') : [];
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      period: str(r.commission_period),
      commissionPercentage: Number(r.commission_percentage ?? 0),
      targetAmount: Number(r.target_amount ?? 0),
      tiers: (tiers as Record<string, unknown>[]).filter((x) => Number(x[t.fk]) === Number(r.id)).map((x) => ({ achievement: Number(x.achievement_percentage ?? 0), commission: Number(x.commission_percentage ?? 0) })),
    }));
  }

  /** صافي حركة حسابٍ في قيود نوعٍ أنشأها المستخدم — مدين − دائن */
  async accountNet(userId: number, accountId: number, referenceType: string, from: string, to: string, paidInvoicesOnly = false) {
    const q = this.db('journal_entry_details as d')
      .join('journal_entries as j', 'j.id', 'd.journal_entry_id')
      .where('d.account_id', accountId)
      .where('j.created_by_employee', userId)
      .where('j.status', 1)
      .where('j.reference_type', referenceType)
      .whereBetween('j.date', [from, to]);
    if (paidInvoicesOnly) q.join('invoices as i', 'i.id', 'j.invoice_id').where('i.payment_status', 1);
    const r = await q.first(this.db.raw('COALESCE(SUM(d.debit), 0) - COALESCE(SUM(d.credit), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async descendantsOf(parentId: number | null) {
    if (!parentId) return [];
    const ids = [parentId];
    let stack = [parentId];
    while (stack.length) {
      const children = (await this.db('accounts').whereIn('parent_id', stack).pluck('id')).map(Number);
      if (!children.length) break;
      ids.push(...children);
      stack = children;
    }
    return [...new Set(ids)];
  }

  /** قيود التحصيل (REC) للمستخدم التي تُدخل خزينةً ولا تُخرج منها */
  async collectionEntries(userId: number, treasuryIds: number[], from: string, to: string) {
    if (!treasuryIds.length) return [];
    const rows = await this.db('journal_entries as j')
      .where('j.created_by_employee', userId)
      .where('j.status', 1)
      .where('j.reference_type', 'REC')
      .whereBetween('j.date', [from, to])
      .whereExists((s) => s.select(this.db.raw(1)).from('journal_entry_details as d').whereRaw('d.journal_entry_id = j.id').whereIn('d.account_id', treasuryIds).where('d.debit', '>', 0))
      .whereNotExists((s) => s.select(this.db.raw(1)).from('journal_entry_details as d').whereRaw('d.journal_entry_id = j.id').whereIn('d.account_id', treasuryIds).where('d.credit', '>', 0))
      .select('j.id', 'j.invoice_id');
    return rows.map((r: Record<string, unknown>) => ({ id: Number(r.id), invoiceId: num(r.invoice_id) }));
  }

  async debitSum(entryIds: number[], accountIds: number[]) {
    if (!entryIds.length || !accountIds.length) return 0;
    const r = await this.db('journal_entry_details').whereIn('journal_entry_id', entryIds).whereIn('account_id', accountIds).where('debit', '>', 0).first(this.db.raw('COALESCE(SUM(debit), 0) as v'));
    return Number((r as Record<string, unknown> | undefined)?.v ?? 0);
  }

  async weeklyCommissions(hrEmployeeId: number, paidSince: string) {
    const base = () =>
      this.db('sales_target_settlements as s')
        .join('sales_targets as t', 't.id', 's.sales_target_id')
        .where('s.employee_id', hrEmployeeId)
        .where('t.commission_period', 'weekly')
        .select('s.id', 's.commission_amount', 's.from_date', 's.to_date', 's.direct_paid_at', 's.notes', 't.id as target_id', 't.name as target_name', 's.created_at');
    const map = (r: Record<string, unknown>) => ({
      id: Number(r.id),
      target: { id: Number(r.target_id), name: String(r.target_name ?? '') },
      amount: Number(r.commission_amount ?? 0),
      fromDate: str(r.from_date),
      toDate: str(r.to_date),
      paidAt: str(r.direct_paid_at),
      notes: str(r.notes),
      createdAt: str(r.created_at),
    });
    const pending = await base().where('s.is_settled', 0).where('s.paid_directly', 0).whereNull('s.direct_journal_entry_id').where('s.commission_amount', '>', 0).orderBy('s.created_at', 'desc');
    const paid = await base().where('s.paid_directly', 1).where('s.direct_paid_at', '>=', paidSince).orderBy('s.direct_paid_at', 'desc');
    return { pending: pending.map(map), paid: paid.map(map) };
  }

  async employeeTreasury(hrEmployeeId: number) {
    const r = await this.db('treasury_employees as te').join('accounts as a', 'a.id', 'te.treasury_id').where('te.employee_id', hrEmployeeId).first('a.id', 'a.name', 'a.balance').catch(() => null);
    return r ? { id: Number(r.id), name: String(r.name ?? ''), balance: Number(r.balance ?? 0) } : null;
  }
}
