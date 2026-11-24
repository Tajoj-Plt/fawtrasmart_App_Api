import { LedgerRepository, StockRepository } from '../../../domain/repositories/stock';
import { round2 } from '../../../domain/services/sales/SalesMath';
import { Tx } from '../../ports';
import { PlanLimitGuard } from '../access/PlanLimitGuard';
import { AccountBalances } from '../stock/AccountBalances';
import { SalesContext } from './SalesContext';

export interface JournalLine {
  accountId: number;
  description: string;
  debit: number;
  credit: number;
}

export interface JournalHeader {
  reference: string;
  referenceType: string;
  description: string;
  clientId: number | null;
  invoiceId: number | null;
  currency: string;
  /** تاريخ المستند — لا تاريخ اليوم */
  date: string;
}

export interface JournalOwner {
  branchId: number | null;
  employeeId: number | null;
}

/**
 * قيود مستندات المبيعات — `JournalEntry::create()` وتفاصيله ومراقبوه:
 * ختم الفرع والموظف والفترة، حدّ «القيود اليومية»، وإعادة حساب الأرصدة
 * هرمياً بعد كل سطر. وكلُّ قيدٍ يُكتب متوازناً: فرقُ التقريب (قرشٌ أو
 * قرشان) يُحمَّل على سطر الإيراد، فلا يخرج قيدٌ مدينُه غيرُ دائنه.
 */
export class SalesJournal {
  /** قيود المعاملة الجارية — العدّ الحيّ لا يرى ما لم يُثبَّت بعد */
  private readonly pending = new WeakMap<object, number>();

  constructor(
    private readonly ledger: LedgerRepository,
    private readonly balances: AccountBalances,
    private readonly stock: StockRepository,
    private readonly planLimits: PlanLimitGuard,
  ) {}

  /** فرع القيد وموظّفه — فرعُ موظّف المستخدم أوّلاً ثمّ فرعُ المستخدم */
  async owner(ctx: SalesContext): Promise<JournalOwner> {
    const employeeBranch = ctx.user.employeeId ? await this.stock.employeeBranchId(ctx.user.employeeId) : null;
    return { branchId: employeeBranch || ctx.user.branchId || null, employeeId: ctx.user.employeeId ?? null };
  }

  async post(ctx: SalesContext, header: JournalHeader, lines: JournalLine[], owner: JournalOwner, now: string, tx: Tx): Promise<number> {
    const rounded = lines.map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) })).filter((l) => l.debit > 0 || l.credit > 0);
    const diff = round2(rounded.reduce((s, l) => s + l.debit - l.credit, 0));
    if (diff !== 0 && Math.abs(diff) <= 0.05) {
      const plug = rounded.find((l) => l.credit > 0 && l.description.startsWith('إيرادات')) ?? rounded.find((l) => l.credit > 0);
      if (plug) plug.credit = round2(plug.credit + diff);
    }

    const count = (this.pending.get(tx) ?? 0) + 1;
    await this.planLimits.assert('journal_entries', ctx.now, count);
    this.pending.set(tx, count);

    const entryId = await this.ledger.insertEntry(
      {
        reference_number: header.reference,
        reference_type: header.referenceType,
        batch_reference: null,
        reference_id: null,
        date: header.date,
        description: header.description,
        status: 1,
        currency: header.currency,
        created_by_employee: ctx.user.id,
        branch_id: owner.branchId,
        employee_id: owner.employeeId,
        accounting_period_id: (await this.stock.accountingPeriodFor(header.date.slice(0, 10)))?.id ?? null,
        linking_type: 'single',
        client_id: header.clientId,
        invoice_id: header.invoiceId,
      },
      now,
      tx,
    );
    for (const l of rounded) {
      await this.ledger.insertDetail({ journalEntryId: entryId, accountId: l.accountId, description: l.description, debit: l.debit, credit: l.credit, isDebit: l.debit > 0 }, now, tx);
      await this.balances.updateParentBalances(l.accountId, now, tx);
    }
    return entryId;
  }
}
