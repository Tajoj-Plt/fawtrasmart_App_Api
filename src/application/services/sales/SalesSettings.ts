import { SalesInvoiceSettingsRow, SalesRepository, TreasuryRow } from '../../../domain/repositories/sales';
import { TaxBook } from '../../../domain/services/sales/SalesMath';
import { Cache } from '../../ports';
import { SalesContext } from './SalesContext';

/** `SalesInvoiceSetting` — أعلام «إعدادات الفواتير» وسقوف الخصم ومصدر المستودع */
export class InvoiceRules {
  constructor(private readonly row: SalesInvoiceSettingsRow) {}

  flag(name: string): boolean {
    return this.row.flags[name] ?? false;
  }

  get maxDiscountType(): 'percentage' | 'amount' {
    return this.row.maxDiscountType === 'amount' ? 'amount' : 'percentage';
  }

  /** `maxDiscountFor()` — النسبة، ويتجاوزها الفرع متى ضبطها بنفسه */
  maxDiscountPercent(branchOwn: number | null): number | null {
    if (this.maxDiscountType !== 'percentage') return null;
    const company = this.row.maxDiscountPercent ?? 10;
    return branchOwn ?? company;
  }

  /** `maxDiscountAmount()` */
  maxDiscountAmount(): number | null {
    if (this.maxDiscountType !== 'amount') return null;
    const v = this.row.maxDiscountAmount ?? 0;
    return v > 0 ? v : null;
  }

  get warehouseSource(): 'employee' | 'main' {
    return this.row.warehouseSource === 'main' ? 'main' : 'employee';
  }

  /** `stocklessTypesForEmployees()` */
  stocklessTypes(): string[] {
    return [this.flag('show_service_products') ? 'services' : null, this.flag('show_digital_products') ? 'digital' : null].filter((v): v is string => v !== null);
  }

  raw() {
    return this.row;
  }
}

/** إعدادات المبيعات محفوظةً لنصف دقيقة — تُقرأ في كل طلب */
export class SalesSettings {
  constructor(
    private readonly sales: SalesRepository,
    private readonly cache: Cache,
  ) {}

  async rules(): Promise<InvoiceRules> {
    return new InvoiceRules(await this.cache.wrap('sales:settings', 30, () => this.sales.settings()));
  }

  async taxBook(): Promise<TaxBook> {
    const taxes = await this.cache.wrap('sales:taxes', 30, () => this.sales.taxes());
    return new Map(taxes.map((t) => [t.id, t]));
  }

  async maxDiscountPercent(rules: InvoiceRules, branchId: number | null): Promise<number | null> {
    if (rules.maxDiscountType !== 'percentage') return null;
    const own = branchId ? await this.sales.branchOwnMaxDiscount(branchId) : null;
    return rules.maxDiscountPercent(own);
  }

  async orderSourceRequired(): Promise<boolean> {
    return (await this.sales.orderSourceSetting('order_source_mandatory')) === '1';
  }

  /** `resolveOrderSource()` — المختار أو الافتراضي المضبوط، نشطاً */
  async resolveOrderSource(requested: number | null): Promise<{ id: number; name: string } | null> {
    const id = requested || Number((await this.sales.orderSourceSetting('default_order_source_id')) || 0);
    return id ? this.sales.orderSource(id) : null;
  }
}

/**
 * `TreasuryAccessGuard` — من يُودِع في أيّ خزينة: جمهورها (الكل/موظف/دور/فرع)،
 * و«خزينتي» المعيَّنة في «خزائن الموظفين» لمن لا يملك `data_scope_all`.
 */
export class TreasuryGuard {
  constructor(private readonly sales: SalesRepository) {}

  private async rowBlock(ctx: SalesContext, t: TreasuryRow, action: 'deposit' | 'withdraw'): Promise<string | null> {
    if (ctx.can('data_scope_all')) return null;
    const scope = (action === 'deposit' ? t.depositPermissions : t.withdrawPermissions) ?? 0;
    if (scope === 0) return null;
    const value = action === 'deposit' ? t.valueOfDepositPermissions : t.valueOfWithdrawPermissions;
    if (value === null || value === '') return null;

    let ok = true;
    if (scope === 1) ok = String(ctx.user.employeeId ?? '') === String(value);
    else if (scope === 3) ok = String(ctx.user.branchId ?? '') === String(value);
    else if (scope === 2) {
      const roleName = ctx.user.roleId ? await this.sales.roleName(ctx.user.roleId) : null;
      ok = roleName === value || (/^\d+$/.test(value) && (ctx.user.roleId ?? 0) === Number(value));
    }
    if (ok) return null;

    const verb = action === 'deposit' ? 'الإيداع في' : 'السحب من';
    const kind = t.type === 1 ? 'الحساب البنكي' : 'الخزينة';
    return `لا يُسمح لك بـ${verb} ${kind} «${t.name}»: غيرُك من يملك ذلك. راجع إعدادات ${kind} أو اطلب من المسؤول تعديلها.`;
  }

  /** «خزائني» — `null` بلا قيد */
  private async ownAccountIds(ctx: SalesContext): Promise<number[] | null> {
    if (!ctx.user.employeeId || ctx.can('data_scope_all')) return null;
    return ctx.remember('ownTreasuries', () => this.sales.employeeTreasuryAccountIds(ctx.user.employeeId as number));
  }

  /** `ownDepositBlockReason()` */
  async depositBlock(ctx: SalesContext, accountId: number): Promise<string | null> {
    const t = await this.sales.treasuryByAccount(accountId);
    if (t) {
      const denied = await this.rowBlock(ctx, t, 'deposit');
      if (denied) return denied;
    }
    const own = await this.ownAccountIds(ctx);
    if (own !== null && !own.includes(accountId)) return 'لا يُسمح لك بالإيداع إلا في الخزينة المعيَّنة لك في «خزائن الموظفين». راجع المسؤول لتعديل التعيين.';
    return null;
  }

  /** `ownWithdrawBlockReason()` — الصرف من الخزينة (ردّ المرتجع) */
  async withdrawBlock(ctx: SalesContext, accountId: number): Promise<string | null> {
    const t = await this.sales.treasuryByAccount(accountId);
    if (t) {
      const denied = await this.rowBlock(ctx, t, 'withdraw');
      if (denied) return denied;
    }
    const own = await this.ownAccountIds(ctx);
    if (own !== null && !own.includes(accountId)) return 'لا يُسمح لك بالسحب إلا من الخزينة المعيَّنة لك في «خزائن الموظفين». راجع المسؤول لتعديل التعيين.';
    return null;
  }

  /** `ownWithdrawable()` */
  async withdrawable(ctx: SalesContext): Promise<TreasuryRow[]> {
    const own = await this.ownAccountIds(ctx);
    const out: TreasuryRow[] = [];
    for (const t of await this.sales.treasuries()) {
      if (await this.rowBlock(ctx, t, 'withdraw')) continue;
      if (own !== null && !own.includes(t.accountId as number)) continue;
      out.push(t);
    }
    return out;
  }

  /** `ownDepositable()` — الخزائن التي يودع فيها من الشاشة */
  async depositable(ctx: SalesContext): Promise<TreasuryRow[]> {
    const own = await this.ownAccountIds(ctx);
    const out: TreasuryRow[] = [];
    for (const t of await this.sales.treasuries()) {
      if (await this.rowBlock(ctx, t, 'deposit')) continue;
      if (own !== null && !own.includes(t.accountId as number)) continue;
      out.push(t);
    }
    return out;
  }
}
