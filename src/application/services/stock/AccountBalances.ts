import { LedgerAccount, LedgerRepository } from '../../../domain/repositories/stock';
import { Tx } from '../../ports';

/**
 * أرصدة الحسابات كما يعيد الويب حسابها — `Account::updateParentBalances()`
 * و`updateBalancesHierarchically()`: رصيد كل حساب = قيوده المباشرة (بطبيعته)
 * + صافي أرصدة أبنائه (ابنٌ بطبيعةٍ عكسية يُطرح). والترتيب هو ترتيب الويب
 * نفسه، فالنتيجة واحدة حتى على شجرةٍ أرصدتها غير متّسقة أصلاً.
 */
export class AccountBalances {
  constructor(private readonly ledger: LedgerRepository) {}

  /** `JournalEntryDetail::created` ← `Account::updateParentBalances($id, true)` */
  async updateParentBalances(accountId: number, now: string, tx: Tx) {
    const account = await this.ledger.account(accountId, tx);
    if (!account) return;
    await this.recompute(account, now, tx);
    if (account.parentId) await this.updateAncestors(account.parentId, now, tx);
  }

  /** `Account::updateBalancesHierarchically($id)` — الحساب وذرّيته ثم آباؤه */
  async updateBalancesHierarchically(accountId: number, now: string, tx: Tx) {
    const account = await this.ledger.account(accountId, tx);
    if (!account) return;
    await this.updateAccountAndDescendants(account, now, tx, new Set());
    if (account.parentId) await this.updateAncestors(account.parentId, now, tx);
  }

  private async updateAccountAndDescendants(account: LedgerAccount, now: string, tx: Tx, seen: Set<number>) {
    if (seen.has(account.id)) return; // شجرةٌ فيها حلقة لا تُدخل الحساب في دورانٍ بلا نهاية
    seen.add(account.id);
    for (const childId of await this.ledger.childIds(account.id, tx)) {
      const child = await this.ledger.account(childId, tx);
      if (child) await this.updateAccountAndDescendants(child, now, tx, seen);
    }
    await this.recompute(account, now, tx);
  }

  private async updateAncestors(parentId: number, now: string, tx: Tx) {
    const seen = new Set<number>();
    let id: number | null = parentId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const parent = await this.ledger.account(id, tx);
      if (!parent) return;
      await this.recompute(parent, now, tx);
      id = parent.parentId;
    }
  }

  /** `computeFullBalance()` ثم الحفظ */
  private async recompute(account: LedgerAccount, now: string, tx: Tx) {
    const { debit, credit } = await this.ledger.detailSums(account.id, tx);
    const own = account.balanceType === 'debit' ? debit - credit : credit - debit;
    let net = 0;
    for (const child of await this.ledger.children(account.id, tx)) net += child.balanceType === account.balanceType ? child.balance : -child.balance;
    await this.ledger.setBalance(account.id, own + net, now, tx);
  }
}
