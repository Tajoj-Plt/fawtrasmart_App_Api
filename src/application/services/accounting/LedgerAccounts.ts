import { LedgerAccount, LedgerRepository } from '../../../domain/repositories/stock';
import { Tx } from '../../ports';

/** `SystemAccountIds` — البديل حين لا يُربط الحساب (المخزون وحده يستعمله، كالويب) */
export const SYSTEM_ACCOUNTS = {
  opening_balance: 38,
  cost_of_sales: 50,
  purchases: 25,
  inventory: 16,
  other_debtor_parties: 20,
  other_creditor_parties: 33,
} as const;

/** خطأ «حساب غير مربوط» — يُميَّز عن أخطاء القاعدة ليصل برسالته */
export class AccountNotMappedError extends Error {}

/**
 * «الحسابات المحاسبية» (`accounting_settings`) وحساب كل مستودع — `AccountingSettings`
 * و`ResolvesAccountingAccounts::warehouseAccount()` في الويب، مشتركةً بين المخزون والمبيعات.
 */
export class LedgerAccounts {
  constructor(private readonly ledger: LedgerRepository) {}

  /** `AccountingSettings::account($key, $fallback)` */
  async find(key: string, fallback: number | null, tx: Tx): Promise<LedgerAccount | null> {
    const id = (await this.ledger.settingsMap()).get(key) ?? fallback;
    return id ? this.ledger.account(id, tx) : null;
  }

  /** `requireAccountingAccount()` — حسابٌ غير مربوط يوقف القيد برسالةٍ تسمّيه */
  async require(key: string, fallback: number | null, tx: Tx): Promise<LedgerAccount> {
    const account = await this.find(key, fallback, tx);
    if (account) return account;
    const label = (await this.ledger.settingName(key)) || key;
    throw new AccountNotMappedError(`حساب «${label}» غير مربوط في «إعدادات الحسابات المحاسبية». اربطه من الشاشة ثم أعد المحاولة.`);
  }

  /** `warehouseAccount()` — حساب المستودع تحت أبيه المضبوط، ويُنشأ إن غاب */
  async warehouse(storeHouseId: number, storeHouseName: string | null, now: string, tx: Tx): Promise<LedgerAccount> {
    const existing = await this.ledger.accountByStorehouse(storeHouseId, tx);
    if (existing) {
      if (!existing.parentId) {
        const parentId = await this.warehouseParentId(tx);
        await this.ledger.setAccountParent(existing.id, parentId, now, tx);
        return { ...existing, parentId };
      }
      return existing;
    }

    const parentId = await this.warehouseParentId(tx);
    const parent = await this.ledger.account(parentId, tx);
    const parentCode = parent?.code ?? '';
    let code = '';
    if (parentCode !== '') {
      const taken = new Set(await this.ledger.codesLike(parentCode, tx));
      for (let i = 1; i <= 999; i++) {
        const candidate = `${parentCode}${String(i).padStart(2, '0')}`;
        if (!taken.has(candidate)) {
          code = candidate;
          break;
        }
      }
    }
    const name = `حساب المستودع - ${storeHouseName || `مستودع ${storeHouseId}`}`;
    const id = await this.ledger.createWarehouseAccount({ name, code, parentId, storehouseId: storeHouseId }, now, tx);
    return { id, name, code, parentId, balanceType: 'debit', balance: 0 };
  }

  private async warehouseParentId(tx: Tx): Promise<number> {
    const inventory = (await this.ledger.settingsMap()).get('inventory') ?? SYSTEM_ACCOUNTS.inventory;
    return (await this.require('warehouse_accounts_parent', inventory, tx)).id;
  }
}
