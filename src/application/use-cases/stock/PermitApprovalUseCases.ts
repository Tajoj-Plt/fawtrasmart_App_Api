import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { ApprovalRepository, LedgerRepository, PermitRepository, PermitRow, StockRepository } from '../../../domain/repositories/stock';
import { PERMIT_STATUS, PermissionSources, sourceName, STOCK_PLAN } from '../../../domain/services/stock/StockConstants';
import { Tx, UnitOfWork } from '../../ports';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { NotificationGate } from '../../services/clients/ClientsSupport';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { LedgerAccounts, SYSTEM_ACCOUNTS } from '../../services/accounting/LedgerAccounts';
import { AccountBalances } from '../../services/stock/AccountBalances';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { StockContext, StockContextFactory } from '../../services/stock/StockContext';
import { StockLog } from '../../services/stock/StockLog';
import { PERMIT_PERMISSIONS, PermitApprover } from './PermitUseCases';


/** مصادر الوارد والمنصرف في `createApprovalJournalEntry()` و`updateAccountBalances()` */
const ADDITION_SOURCES: number[] = [PermissionSources.WAREHOUSE_ADD, PermissionSources.PURCHASE_INVOICE, PermissionSources.INVENTORY_RECEIVED, PermissionSources.SALES_RETURN, PermissionSources.PURCHASE_RETURN];
const DISBURSEMENT_SOURCES: number[] = [
  PermissionSources.WAREHOUSE_DISBURSEMENT,
  PermissionSources.INVENTORY_WITHDRAWN,
  PermissionSources.SALES_INVOICE,
  PermissionSources.POS_SHIFT_OUTBOUND,
  PermissionSources.MANUFACTURING_DISBURSEMENT,
];

/** رفضٌ برسالة الويب — يُرجع المعاملة كلّها */
const fail = (message: string, status = 422, code = 'PERMIT_APPROVAL_FAILED') => new AppError(code, message, status);

/**
 * اعتماد الإذن وإلغاء اعتماده — `approve()` و`cancelApproval()` في الويب:
 * تحريك الكميات في `product_details`، والقيد المحاسبي بحسابات «الحسابات
 * المحاسبية» وحساب المستودع (يُنشأ تحت أبيه إن غاب)، وإعادة حساب الأرصدة
 * هرمياً، وإقفال ورقة الجرد، والإشعار. كلّه في معاملةٍ واحدة أو لا شيء.
 */
export class PermitApprovalUseCases implements PermitApprover {
  constructor(
    private readonly contexts: StockContextFactory,
    private readonly permits: PermitRepository,
    private readonly approvals: ApprovalRepository,
    private readonly ledger: LedgerRepository,
    private readonly balances: AccountBalances,
    private readonly accounts: LedgerAccounts,
    private readonly stock: StockRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly notifications: NotificationGate,
    private readonly log: StockLog,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [STOCK_PLAN.permits], permissions: [permission] });
  }

  // ═══════════════════════ الاعتماد ═══════════════════════

  async approve(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, PERMIT_PERMISSIONS.approve);
    try {
      const message = await this.uow.run((tx) => this.approveWithin(ctx, id, tx));
      return { message, data: { id, status: 'approved' } };
    } catch (e) {
      if (e instanceof AppError) throw e;
      await this.log.failure(ctx, e, 'approve', id);
      throw fail(`عذراً، حدث خطأ أثناء الموافقة على الإذن المخزني: ${(e as Error).message}`);
    }
  }

  /** `approve()` داخل معاملةٍ قائمة — ويستعمله حفظ الرصيد الافتتاحي كذلك */
  async approveWithin(ctx: StockContext, id: number, tx: Tx): Promise<string> {
    const permit = await this.permits.find(id, tx, true);
    if (!permit) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
    await ctx.authorizeCreator(permit.createdBy);

    // إذن استلام المشتريات يُعتمد من شاشته — تلك وحدها تُحدِّث الاستلام وأمر الشراء
    if (permit.referenceType === 'purchase_receiving') throw fail('يُعتمد إذن استلام المشتريات من شاشة «استلام المشتريات» لا من هنا.');

    // الاعتماد هو ما يُرحِّل القيد — فتاريخ الإذن يُفحص هنا
    const block = await this.periodGuard.block(permit.permissionDate, ctx.today, (p) => ctx.can(p));
    if (block) throw fail(block, 422, 'ACCOUNTING_PERIOD_CLOSED');

    const items = await this.permits.items(permit.id, tx);
    const products = await this.permits.productsByIds(items.map((i) => i.productId));
    const inactive = [...products.values()].filter((p) => p.status !== 'active');
    if (inactive.length) throw fail(`لا يمكن إجراء العملية على المنتجات التالية لأنها غير نشطة: ${inactive.map((p) => p.name).join(', ')}`);

    if (permit.status !== PERMIT_STATUS.pending) {
      throw fail(`هذا الإذن ${permit.status === PERMIT_STATUS.approved ? 'تمت الموافقة عليه مسبقاً' : 'تم رفضه مسبقاً'}`);
    }

    // المستودع الهدف: التحويل إلى «إلى»، وما عداه مستودعه أو الرئيسي
    const type = permit.permissionType ?? 0;
    const majorId = async () => (await this.stock.majorWarehouseIds())[0] ?? null;
    let targetId: number | null;
    if (type === 3) targetId = permit.toWarehouseId !== null && (await this.stock.warehouse(permit.toWarehouseId)) ? permit.toWarehouseId : null;
    else targetId = permit.storeHousesId !== null && (await this.stock.warehouse(permit.storeHousesId)) ? permit.storeHousesId : await majorId();
    const target = targetId !== null ? await this.stock.warehouse(targetId) : null;
    if (!target) throw fail('لم يتم العثور على المستودع المطلوب');

    const now = ctx.nowSql;
    for (const item of items) {
      const product = products.get(item.productId);
      if (!product) throw fail('المنتج غير موجود');
      const qty = item.quantity;

      if (type === 1 || type === 4) {
        await this.addStock(target.id, product, qty, now, tx);
      } else if (type === 2) {
        const row = await this.approvals.firstStockRow(target.id, item.productId, tx);
        if (!row) throw fail('المنتج غير موجود في المستودع');
        if (row.quantity < qty) throw fail('الكمية المطلوبة أكبر من الكمية المتاحة');
        await this.approvals.addToStockRow(row.id, -qty, now, tx);
      } else if (type === 3) {
        const fromId = permit.fromWarehouseId !== null && (await this.stock.warehouse(permit.fromWarehouseId)) ? permit.fromWarehouseId : await majorId();
        if (fromId === null) throw fail('لم يتم العثور على المستودع المصدر');
        const row = await this.approvals.firstStockRow(fromId, item.productId, tx);
        if (!row) throw fail('المنتج غير موجود في المستودع المصدر');
        if (row.quantity < qty) throw fail('الكمية المطلوبة أكبر من الكمية المتاحة في المستودع المصدر');
        await this.approvals.addToStockRow(row.id, -qty, now, tx);
        await this.addStock(target.id, product, qty, now, tx);
      }
    }

    await this.approvals.setPermitStatus(permit.id, PERMIT_STATUS.approved, now, tx);

    // فاتورة مشتريات مرتبطة لم تُستلَم: كمّياتها إلى المستودع وتُعلَّم مستلَمة
    if (permit.referenceType === 'purchase_invoice' && permit.referenceId) {
      const invoice = await this.approvals.purchaseInvoiceForReceiving(permit.referenceId, tx);
      if (invoice && invoice.receivingStatus !== 'received') {
        for (const line of invoice.items) {
          if (line.productName === null) throw fail('المنتج غير موجود في بند فاتورة المشتريات');
          const p = { id: line.productId, name: line.productName, type: (await this.permits.productsByIds([line.productId])).get(line.productId)?.type ?? null };
          await this.addStock(target.id, p, line.quantity, now, tx);
        }
        await this.approvals.markInvoiceReceived(invoice.id, ctx.today, now, tx);
      }
    }

    await this.journalForApproval(ctx, { ...permit, status: PERMIT_STATUS.approved }, items, tx);
    await this.closeAdjustmentIfSettled(permit, now, tx);

    await this.notifications.send(
      {
        userId: permit.createdBy,
        receiverId: permit.createdBy,
        title: `تمت الموافقة على الإذن المخزني رقم ${permit.number ?? ''}`,
        description: `تمت الموافقة على الإذن المخزني رقم ${permit.number ?? ''}`,
        type: 'success',
      },
      ctx.now,
      tx,
    );

    return `تمت الموافقة على الإذن المخزني رقم ${permit.number ?? ''} بنجاح وتم تنفيذه في المستودع: ${target.name} وتم إنشاء القيد المحاسبي`;
  }

  /** `ProductDetails::firstOrCreate()` ثم الزيادة — وصنفٌ بلا رصيد لا يدخل (`StockMovementGuardObserver`) */
  private async addStock(warehouseId: number, product: { id: number; name: string; type: string | null }, qty: number, now: string, tx: Tx) {
    const row = await this.approvals.firstStockRow(warehouseId, product.id, tx);
    if (row) {
      await this.approvals.addToStockRow(row.id, qty, now, tx);
      return;
    }
    if (product.type === 'services' || product.type === 'digital') {
      const label = product.type === 'services' ? 'منتج خدمي' : 'منتج رقمي';
      throw fail(`عذراً، حدث خطأ أثناء الموافقة على الإذن المخزني: لا يمكن إدخال «${product.name || 'هذا الصنف'}» في المخزون: نوعه ${label} ولا رصيد له في المستودعات.`);
    }
    await this.approvals.createStockRow(warehouseId, product.id, qty, now, tx);
  }

  /** `closeAdjustmentIfSettled()` — ورقة الجرد تُقفل حين لا يبقى لها إذنٌ معلَّق */
  private async closeAdjustmentIfSettled(permit: PermitRow, now: string, tx: Tx) {
    if (permit.permissionSourceId !== PermissionSources.INVENTORY_ADJUSTMENT || !permit.referenceId) return;
    if (await this.approvals.adjustmentHasPendingPermits(permit.referenceId, tx)) return;
    await this.approvals.markAdjustment(permit.referenceId, 'adjusted', now, null, now, tx);
  }

  // ═══════════════════════ القيد المحاسبي ═══════════════════════

  /** `createApprovalJournalEntry()` — يرمي برسالة الويب «فشل إنشاء القيد المحاسبي…» */
  private async journalForApproval(ctx: StockContext, permit: PermitRow, items: Array<{ quantity: number; unitPrice: number }>, tx: Tx) {
    const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    if (total === 0) return;

    try {
      const now = ctx.nowSql;
      const store = permit.storeHousesId !== null ? await this.stock.warehouse(permit.storeHousesId) : null;
      if (!store) throw fail('المستودع غير موجود');

      const storeAccount = await this.accounts.warehouse(store.id, store.name, now, tx);
      const source = permit.permissionSourceId ?? 0;
      const number = permit.number ?? '';
      let description: string;
      let debitId: number;
      let creditId: number;

      if (source === PermissionSources.WAREHOUSE_OPENING_BALANCE) {
        description = `قيد رصيد افتتاحي للمخزون رقم ${number}`;
        debitId = storeAccount.id;
        creditId = (await this.accounts.require('opening_balance', SYSTEM_ACCOUNTS.opening_balance, tx)).id;
      } else if (source === PermissionSources.INVENTORY_ADJUSTMENT) {
        const adjustment = (await this.accounts.require('inventory_adjustment', SYSTEM_ACCOUNTS.cost_of_sales, tx)).id;
        const surplus = permit.permissionType === 1;
        description = `${surplus ? 'قيد زيادة جرد رقم ' : 'قيد عجز جرد رقم '}${number}`;
        debitId = surplus ? storeAccount.id : adjustment;
        creditId = surplus ? adjustment : storeAccount.id;
      } else if (source === PermissionSources.WAREHOUSE_ADD) {
        description = `قيد إضافة مخزنية يدوية رقم ${number}`;
        debitId = storeAccount.id;
        creditId = (await this.accounts.require('other_creditor_parties', SYSTEM_ACCOUNTS.other_creditor_parties, tx)).id;
      } else if (ADDITION_SOURCES.includes(source)) {
        description = `قيد إضافة بضاعة - ${sourceName(source)} رقم ${number}`;
        debitId = storeAccount.id;
        creditId = (await this.accounts.require('purchases', SYSTEM_ACCOUNTS.purchases, tx)).id;
      } else if (source === PermissionSources.WAREHOUSE_DISBURSEMENT) {
        description = `قيد صرف مخزني يدوي رقم ${number}`;
        debitId = (await this.accounts.require('other_debtor_parties', SYSTEM_ACCOUNTS.other_debtor_parties, tx)).id;
        creditId = storeAccount.id;
      } else if (DISBURSEMENT_SOURCES.includes(source)) {
        description = `قيد صرف بضاعة - ${sourceName(source)} رقم ${number}`;
        debitId = (await this.accounts.require('cost_of_sales', SYSTEM_ACCOUNTS.cost_of_sales, tx)).id;
        creditId = storeAccount.id;
      } else if (source === PermissionSources.MANUAL_TRANSFER) {
        const from = permit.fromWarehouseId !== null ? await this.stock.warehouse(permit.fromWarehouseId) : null;
        const to = permit.toWarehouseId !== null ? await this.stock.warehouse(permit.toWarehouseId) : null;
        if (!from || !to) throw fail('مستودع التحويل (المصدر أو الهدف) غير موجود');
        description = `قيد تحويل مخزني من ${from.name} إلى ${to.name} — إذن رقم ${number}`;
        debitId = (await this.accounts.warehouse(to.id, to.name, now, tx)).id;
        creditId = (await this.accounts.warehouse(from.id, from.name, now, tx)).id;
      } else {
        throw fail(`نوع مصدر الإذن غير مدعوم للقيود المحاسبية: ${source} (${sourceName(source)})`);
      }

      // `PlanLimitObserver` على `JournalEntry` — حدّ «القيود اليومية»
      await this.planLimits.assert('journal_entries', ctx.now);

      const entryId = await this.insertEntry(ctx, permit, description, now, tx);
      for (const [accountId, debit, credit] of [
        [debitId, total, 0],
        [creditId, 0, total],
      ] as const) {
        await this.ledger.insertDetail({ journalEntryId: entryId, accountId, description, debit, credit }, now, tx);
        await this.balances.updateParentBalances(accountId, now, tx);
      }

      // `updateAccountBalances()`: الزيادة/النقص اليدوي تمحوه إعادةُ الحساب الهرمية بعده مباشرة،
      // فالأثر الباقي إعادةُ حساب المشتريات أو تكلفة المبيعات ثم حساب المستودع
      if (ADDITION_SOURCES.includes(source)) {
        const purchases = await this.accounts.find('purchases', SYSTEM_ACCOUNTS.purchases, tx);
        if (purchases) await this.balances.updateBalancesHierarchically(purchases.id, now, tx);
      } else if (DISBURSEMENT_SOURCES.includes(source)) {
        const cost = await this.accounts.find('cost_of_sales', SYSTEM_ACCOUNTS.cost_of_sales, tx);
        if (cost) await this.balances.updateBalancesHierarchically(cost.id, now, tx);
      }
      await this.balances.updateBalancesHierarchically(storeAccount.id, now, tx);
    } catch (e) {
      const reason = e instanceof AppError && e.code === 'PERMIT_APPROVAL_FAILED' ? e.message : `فشل إنشاء القيد المحاسبي: ${(e as Error).message}`;
      if (e instanceof AppError && e.code === 'PLAN_LIMIT_REACHED') throw new AppError('PLAN_LIMIT_REACHED', `فشل إنشاء القيد المحاسبي: ${e.message}`, 422, e.details);
      throw fail(reason);
    }
  }

  /** `JournalEntry::create()` بخطافاته: الرقم، والفرع والموظف، والفترة، والعملة */
  private async insertEntry(ctx: StockContext, permit: PermitRow, description: string, now: string, tx: Tx) {
    const date = (permit.permissionDate ?? now).slice(0, 10);
    const year = ctx.now.getUTCFullYear().toString();
    const last = await this.ledger.lastReferenceNumber('AW', year, tx);
    const next = last ? Number(last.split('-').pop() ?? 0) + 1 : 1;
    const owner = await this.owner(ctx);

    return this.ledger.insertEntry(
      {
        reference_number: `AW-${year}-${String(next).padStart(5, '0')}`,
        reference_type: 'AW',
        batch_reference: `WAREHOUSE_${permit.id}`,
        reference_id: permit.id,
        date,
        description,
        status: 1,
        currency: permit.currency || (await this.defaultCurrency()),
        created_by_employee: ctx.user.id,
        branch_id: owner.branchId,
        employee_id: owner.employeeId,
        accounting_period_id: (await this.stock.accountingPeriodFor(date))?.id ?? null,
        linking_type: 'single',
      },
      now,
      tx,
    );
  }

  /** `StampsOwnerContext` — فرع الموظف ثم فرع المستخدم، وموظف المستخدم */
  private async owner(ctx: StockContext) {
    const employeeBranch = ctx.user.employeeId ? await this.stock.employeeBranchId(ctx.user.employeeId) : null;
    return { branchId: employeeBranch || ctx.user.branchId || null, employeeId: ctx.user.employeeId ?? null };
  }

  private async defaultCurrency() {
    return (await this.reference.defaultCurrency())?.code ?? 'SAR';
  }

  // ═══════════════════════ إلغاء الاعتماد ═══════════════════════

  /** `cancelApproval()` — تُعاد الكميات ويُعكس القيد بتاريخ اليوم، ويعود الإذن معلَّقاً */
  async cancelApproval(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, PERMIT_PERMISSIONS.cancelApproval);
    const found = await this.permits.find(id);
    if (!found) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
    await ctx.authorizeCreator(found.createdBy);

    // القيد العكسي يُرحَّل بتاريخ اليوم لا بتاريخ الإذن
    const block = await this.periodGuard.block(null, ctx.today, (p) => ctx.can(p));
    if (block) throw fail(block, 422, 'ACCOUNTING_PERIOD_CLOSED');

    try {
      const status = await this.uow.run(async (tx) => {
        const permit = await this.permits.find(id, tx, true);
        if (!permit) throw AppError.notFound('PERMIT_NOT_FOUND', 'الإذن المخزني غير موجود.');
        if (permit.status !== PERMIT_STATUS.approved) throw fail('هذا الإذن غير موافق عليه مسبقاً', 400, 'PERMIT_NOT_APPROVED');

        const now = ctx.nowSql;
        const type = permit.permissionType ?? 0;
        // عكس الكميات على أوّل صفٍّ للصنف — بلا فحص رصيد، كما في الويب
        for (const item of await this.permits.items(permit.id, tx)) {
          const move = async (warehouseId: number | null, delta: number) => {
            if (warehouseId === null) return;
            const row = await this.approvals.firstStockRow(warehouseId, item.productId, tx);
            if (row) await this.approvals.addToStockRow(row.id, delta, now, tx);
          };
          if (type === 1 || type === 4) await move(permit.storeHousesId, -item.quantity);
          else if (type === 2) await move(permit.storeHousesId, item.quantity);
          else if (type === 3) {
            await move(permit.toWarehouseId, -item.quantity);
            await move(permit.fromWarehouseId, item.quantity);
          }
        }

        await this.reverseEntries(ctx, permit, now, tx);

        // إذن تسوية الجرد يُلغى نهائياً وتعود ورقته «مكتملة»؛ واليدوي يعود معلَّقاً
        const settlement = permit.permissionSourceId === PermissionSources.INVENTORY_ADJUSTMENT;
        const next = settlement ? PERMIT_STATUS.rejected : PERMIT_STATUS.pending;
        await this.approvals.setPermitStatus(permit.id, next, now, tx);
        if (settlement && permit.referenceId) await this.approvals.markAdjustment(permit.referenceId, 'completed', null, 'adjusted', now, tx);
        return next;
      });

      return { message: 'تم إلغاء الموافقة بنجاح وإرجاع الكميات وعكس القيود', data: { id, status: status === PERMIT_STATUS.rejected ? 'rejected' : 'pending' } };
    } catch (e) {
      if (e instanceof AppError && e.code !== 'REVERSE_FAILED') throw e;
      await this.log.failure(ctx, e, 'cancelApproval', id);
      throw new AppError('CANCEL_APPROVAL_FAILED', `حدث خطأ أثناء إلغاء الموافقة: ${(e as Error).message}`, 500);
    }
  }

  /** `createReverseJournalEntries()` — قيدٌ عكسي لكل قيدٍ لم يُعكس، وتُعلَّم الأصول معكوسة */
  private async reverseEntries(ctx: StockContext, permit: PermitRow, now: string, tx: Tx) {
    try {
      const owner = await this.owner(ctx);
      const today = ctx.today;
      const periodId = (await this.stock.accountingPeriodFor(today))?.id ?? null;
      const currency = permit.currency || (await this.defaultCurrency());
      const stamp = Math.floor(Date.now() / 1000);

      for (const entry of await this.ledger.entriesToReverse(permit.id, tx)) {
        await this.planLimits.assert('journal_entries', ctx.now);
        const reverseId = await this.ledger.insertEntry(
          {
            reference_number: `REVERSE_${entry.referenceNumber ?? ''}_${stamp}`,
            reference_type: 'STK',
            batch_reference: null,
            reference_id: permit.id,
            date: today,
            description: `قيد عكسي لـ ${entry.description ?? ''}`,
            status: 1,
            currency,
            created_by_employee: ctx.user.id,
            branch_id: owner.branchId,
            employee_id: owner.employeeId,
            accounting_period_id: periodId,
            linking_type: 'single',
          },
          now,
          tx,
        );

        for (const d of await this.ledger.details(entry.id, tx)) {
          await this.ledger.insertDetail({ journalEntryId: reverseId, accountId: d.accountId, description: `عكس - ${d.description ?? ''}`.slice(0, 255), debit: d.credit, credit: d.debit }, now, tx);
          await this.balances.updateParentBalances(d.accountId, now, tx);
          await this.balances.updateBalancesHierarchically(d.accountId, now, tx);
        }
        await this.ledger.markReversed(entry.id, now, tx);
      }
    } catch (e) {
      throw new AppError('REVERSE_FAILED', `فشل في إنشاء القيود العكسية: ${(e as Error).message}`, 500);
    }
  }

}
