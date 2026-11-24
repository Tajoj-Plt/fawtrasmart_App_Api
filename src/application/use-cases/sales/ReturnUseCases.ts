import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository, OperationLogRepository } from '../../../domain/repositories/clients';
import { InvoiceItemRow, InvoiceRow, SalesPaymentRepository, SalesRepository, SalesWriteRepository } from '../../../domain/repositories/sales';
import { LedgerRepository, StockRepository } from '../../../domain/repositories/stock';
import { VisitRepository } from '../../../domain/repositories/visits';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { fmtMoney, fmtQty, round2 } from '../../../domain/services/sales/SalesMath';
import { PAYMENT_STATUS, PAYMENT_STATUS_LABELS, RETURN_LOG_MODULE, RETURN_PERMISSIONS, SALE_TYPES, SALES_LIMITS, SALES_PLAN, SALES_REFERENCE, SALES_RETURN_SOURCE, SALES_SECTIONS } from '../../../domain/services/sales/SalesConstants';
import { Tx, UnitOfWork } from '../../ports';
import { LedgerAccounts } from '../../services/accounting/LedgerAccounts';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { CreditLine, creditTotals, documentDiscountOf, lineFromInvoice } from '../../services/sales/CreditDocument';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { SalesInventory, StockMove } from '../../services/sales/SalesInventory';
import { SalesJournal } from '../../services/sales/SalesJournal';
import { SalesProximity } from '../../services/sales/SalesProximity';
import { SalesSettings, TreasuryGuard } from '../../services/sales/SalesSettings';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { InvoiceQueryUseCases } from './InvoiceQueryUseCases';

const PER_PAGE = [10, 25, 50, 100];
const STOCKED = ['products', 'compiled'];

export interface ReturnListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  invoiceNumber?: string;
  branch?: number;
  totalFrom?: number;
  totalTo?: number;
  fromDate?: string;
  toDate?: string;
  createdBy?: number;
  employeeId?: number;
}

const blockMessages = {
  notSale: 'هذا المستند مرتجعٌ لا فاتورة بيع — لا يُعمل له مرتجع.',
  hasReturn: 'لهذه الفاتورة مرتجعٌ سابق، ولا يُعمل لها مرتجعٌ آخر.',
  creditNote: 'صدر لهذه الفاتورة إشعارٌ دائن — يُعدّ مرتجعاً، فلا يُعمل لها مرتجعٌ آخر.',
  voided: 'الفاتورة ملغاة — لا يُعمل لها مرتجع.',
};

/**
 * مرتجعات المبيعات — `ReturnInvoiceController`. المرتجع يُبنى من بنود الفاتورة
 * الأصلية نفسها (السعر والضرائب وحصّة الخصم بنسبة الكمية)، فيُردّ للعميل ما
 * دفعه لا ما يكتبه الطلب؛ والبضاعة تعود إلى مستودع بندها.
 */
export class ReturnUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly sales: SalesRepository,
    private readonly writes: SalesWriteRepository,
    private readonly payments: SalesPaymentRepository,
    private readonly stock: StockRepository,
    private readonly ledger: LedgerRepository,
    private readonly accounts: LedgerAccounts,
    private readonly journal: SalesJournal,
    private readonly inventory: SalesInventory,
    private readonly proximity: SalesProximity,
    private readonly settings: SalesSettings,
    private readonly treasuries: TreasuryGuard,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly visits: VisitRepository,
    private readonly logs: OperationLogRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly invoiceQueries: InvoiceQueryUseCases,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.returns], permissions: [permission] });
  }

  /** `returnBlockReason()` — ومعها الإلغاء */
  private async blockReason(invoice: InvoiceRow): Promise<string | null> {
    if (invoice.type === 'returned') return blockMessages.notSale;
    if (invoice.voidedAt) return blockMessages.voided;
    if ((await this.sales.returnedInvoiceIds([invoice.id])).has(invoice.id)) return blockMessages.hasReturn;
    if ((await this.sales.activeCreditNoteInvoiceIds([invoice.id])).has(invoice.id)) return blockMessages.creditNote;
    return null;
  }

  /** المدفوع نقداً على الفاتورة (سوى الفاشل) */
  private async cashPaid(invoiceId: number, tx?: Tx) {
    return (await this.payments.paidTotals([invoiceId], tx)).get(invoiceId) ?? 0;
  }

  /**
   * ما يُردّ نقداً: فائضُ ما دُفع على قيمة ما بقي عند العميل — لا يتجاوز قيمة
   * المرتجع. الويب يردّ المدفوعَ كلَّه (بسقف المرتجع) ولو بقي على العميل دَين:
   * فاتورةٌ بمئة دُفع نصفُها ورُدّ منها ثلاثون تُخرج ثلاثين من الخزينة وتترك
   * على العميل عشرين زيادةً عمّا أخذ.
   */
  private refundable(originalTotal: number, paid: number, returnTotal: number) {
    return round2(Math.min(returnTotal, Math.max(0, paid - (originalTotal - returnTotal))));
  }

  // ═══════════════════════ شاشة الإنشاء ═══════════════════════

  async createData(userId: number, meta: RequestMeta, invoiceId: number) {
    const ctx = await this.load(userId, meta, RETURN_PERMISSIONS.create);
    const invoice = await this.invoiceQueries.find(ctx, invoiceId);
    const [items, paid, treasuries, periodBlock, blocked] = await Promise.all([
      this.sales.invoiceItems(invoice.id),
      this.cashPaid(invoice.id),
      this.treasuries.withdrawable(ctx),
      this.periodGuard.block(ctx.today, ctx.today, (p) => ctx.can(p)),
      this.blockReason(invoice),
    ]);
    const own = ctx.user.employeeId ? await this.sales.employeeTreasuryAccountIds(ctx.user.employeeId) : [];
    return {
      invoice: { id: invoice.id, code: invoice.code, client: invoice.clientId ? { id: invoice.clientId, tradeName: invoice.clientName } : null, grandTotal: invoice.grandTotal, paid: round2(paid), currency: invoice.currency },
      blockReason: blocked,
      lines: items
        .filter((i) => i.productId)
        .map((i) => ({
          invoiceItemId: i.id,
          productId: i.productId,
          item: i.item,
          unitName: i.unitName,
          maxQuantity: i.quantity,
          unitPrice: i.unitPrice,
          discount: i.discount,
          total: i.total,
          warehouse: i.storeHouseId ? { id: i.storeHouseId, name: i.storeHouseName } : null,
        })),
      shipping: { cost: invoice.shippingCost, tax: invoice.shippingTax },
      refundIfFullReturn: this.refundable(invoice.grandTotal, paid, invoice.grandTotal),
      treasuries: treasuries.map((t) => ({ id: t.accountId, name: t.name, isOwn: own.includes(t.accountId as number) })),
      periodBlock,
      nextNumber: await this.numbers.peek(SALES_SECTIONS.returnInvoice, ctx.now),
    };
  }

  // ═══════════════════════ الإصدار ═══════════════════════

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, RETURN_PERMISSIONS.create);
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const invoiceId = form.integer('invoiceId', { required: true, min: 1, message: 'اختر الفاتورة الأصلية.' });
    const dateText = form.string('returnDate');
    let returnDate = ctx.today;
    if (dateText !== null) {
      const d = parseInputDate(dateText);
      if (!d) errors.add('returnDate', 'التاريخ بصيغة YYYY-MM-DD.');
      else returnDate = toSqlDate(d);
    }
    const includeShipping = form.boolean('includeShipping') ?? false;
    const refund = form.boolean('refund') ?? false;
    const treasuryId = form.integer('treasuryId', { min: 1 });
    const paymentMethod = form.integer('paymentMethod', { min: 1 });
    const notes = form.string('notes', { max: 5000 });
    const latitude = form.number('currentLatitude', { min: -90, max: 90 });
    const longitude = form.number('currentLongitude', { min: -180, max: 180 });
    const list = form.array('items', { required: true, min: 1, max: 200, message: 'لا بنود للإرجاع — أضف بنداً واحداً على الأقل.' }) ?? [];
    const picks = new Map<number, number>();
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const itemId = item.integer('invoiceItemId', { required: true, min: 1, message: 'بند الفاتورة مطلوب.' });
      const quantity = item.number('quantity', { required: true, message: 'الكمية مطلوبة.' });
      if (quantity !== null && quantity <= 0) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      if (itemId !== null && picks.has(itemId)) errors.add(`items.${i}.invoiceItemId`, 'البند مكرَّر — اجمع كميته في سطرٍ واحد.');
      if (itemId !== null && quantity !== null && quantity > 0) picks.set(itemId, quantity);
    });
    errors.throwIfAny();

    // الفاتورة الأصلية في نطاقي، ولم يُعمل لها ردّ
    const original = await this.invoiceQueries.find(ctx, invoiceId as number);
    const blocked = await this.blockReason(original);
    if (blocked) throw new AppError('RETURN_BLOCKED', blocked, 422);

    await this.proximity.assert(ctx, RETURN_PERMISSIONS.bypassLocation, original.clientId, latitude, longitude);
    const block = await this.periodGuard.block(returnDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);
    await this.planLimits.assert(SALES_LIMITS.returns, ctx.now);

    // البنود: من الفاتورة نفسها، بكمياتٍ لا تتجاوز المباع
    const items = await this.sales.invoiceItems(original.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const fallbackWarehouse = await ctx.resolveWarehouse((await this.settings.rules()).warehouseSource, null);
    const lines: CreditLine[] = [];
    for (const [itemId, quantity] of picks) {
      const item = byId.get(itemId);
      if (!item || !item.productId) throw AppError.validation({ items: [`البند #${itemId} ليس من بنود الفاتورة ${original.code}.`] }, `البند #${itemId} ليس من بنود الفاتورة ${original.code}.`);
      if (quantity - item.quantity > 0.0001) {
        throw AppError.validation({ items: [`لا يمكن ردّ ${fmtQty(quantity)} من «${item.item}»: المباع في الفاتورة ${fmtQty(item.quantity)}.`] }, `لا يمكن ردّ ${fmtQty(quantity)} من «${item.item}»: المباع في الفاتورة ${fmtQty(item.quantity)}.`);
      }
      lines.push(lineFromInvoice(item, quantity, fallbackWarehouse));
    }

    const book = await this.settings.taxBook();
    const saleLines = items.filter((i) => i.productId);
    const allNet = saleLines.reduce((s, i) => s + Math.max(0, i.quantity * i.unitPrice - i.discount), 0);
    const returnNet = lines.reduce((s, l) => s + Math.max(0, l.quantity * l.unitPrice - l.discount), 0);
    const documentDiscount = allNet > 0 ? round2((documentDiscountOf(original, items) * returnNet) / allNet) : 0;
    const totals = creditTotals(book, lines, documentDiscount, includeShipping ? { cost: original.shippingCost, tax: original.shippingTax } : { cost: 0, tax: 0 });

    // ردٌّ كامل: المجاميع مجاميع الفاتورة نفسها — لا فرق تقريبٍ بينهما
    const full = saleLines.every((i) => Math.abs((picks.get(i.id) ?? 0) - i.quantity) < 0.0001) && (includeShipping || original.shippingCost === 0);
    if (full) {
      totals.subtotal = original.subtotal;
      totals.totalDiscount = original.discountAmount;
      totals.taxTotal = original.taxTotal;
      totals.itemsTax = round2(original.taxTotal - original.shippingTax);
      totals.grandTotal = round2(original.grandTotal);
    }

    const products = await this.sales.products(lines.map((l) => l.productId));
    const compiled = await this.sales.compiledComponents(lines.filter((l) => products.get(l.productId)?.type === 'compiled' && products.get(l.productId)?.compileType === 'Instant').map((l) => l.productId));
    const componentNames = await this.sales.products([...compiled.values()].flat().map((c) => c.productId));
    const moves: StockMove[] = [];
    lines.forEach((l, i) => {
      const p = products.get(l.productId);
      if (!p || !STOCKED.includes(p.type) || !l.warehouseId) return;
      if (p.type === 'compiled' && p.compileType === 'Instant') {
        // المجمَّع الفوري لا رصيد له — تعود مكوّناته كما خرجت
        for (const c of compiled.get(p.id) ?? []) {
          moves.push({ productId: c.productId, name: componentNames.get(c.productId)?.name ?? `#${c.productId}`, warehouseId: l.warehouseId, baseQuantity: c.quantity * l.baseQuantity, unitPrice: 0, total: 0 });
        }
        return;
      }
      moves.push({ productId: l.productId, name: p.name, warehouseId: l.warehouseId, baseQuantity: l.baseQuantity, unitPrice: l.baseQuantity > 0 ? round2(totals.lineTotals[i] / l.baseQuantity) : 0, total: totals.lineTotals[i] });
    });

    const clientAccount = original.clientId ? await this.sales.clientLedgerAccount(original.clientId) : null;
    if (!clientAccount) throw new AppError('CLIENT_ACCOUNT_MISSING', `لا حساب محاسبيّ للعميل «${original.clientName ?? '—'}».`, 422);

    const result = await this.uow.run(async (tx) => {
      // قفل الأصل ثمّ إعادة الفحص — مرتجعان متزامنان لا يمرّان معاً
      await this.payments.lockInvoices([original.id], tx);
      const again = await this.blockReason(original);
      if (again) throw new AppError('RETURN_BLOCKED', again, 422);

      await this.planLimits.assert(SALES_LIMITS.returns, ctx.now);
      const permits = this.inventory.permitsFor(moves);
      if (permits) await this.planLimits.assert('warehouse_permits', ctx.now, permits);

      const now = ctx.nowSql;
      const currency = original.currency || (await this.reference.defaultCurrency())?.code || 'SAR';
      const code = await this.numbers.next(SALES_SECTIONS.returnInvoice, ctx.now, tx);
      const paid = await this.cashPaid(original.id, tx);
      const refundAmount = refund ? this.refundable(original.grandTotal, paid, totals.grandTotal) : 0;

      let refundTreasury: number | null = null;
      if (refundAmount > 0) {
        refundTreasury = await this.refundTreasury(ctx, treasuryId, tx);
        const account = await this.ledger.account(refundTreasury, tx);
        if ((account?.balance ?? 0) + 0.005 < refundAmount) {
          throw new AppError('TREASURY_INSUFFICIENT', `رصيد الخزينة «${account?.name ?? '—'}» لا يكفي لردّ المبلغ: الرصيد ${fmtMoney(account?.balance ?? 0)} والمطلوب ${fmtMoney(refundAmount)}. اختر خزينةً أخرى، أو أودِع فيها أوّلاً، أو اختر «عدم إرجاع المبلغ».`, 422);
        }
      }
      const status = refundAmount >= totals.grandTotal - 0.009 ? PAYMENT_STATUS.paid : refundAmount > 0 ? PAYMENT_STATUS.partial : PAYMENT_STATUS.unpaid;
      const owner = await this.journal.owner(ctx);

      const returnId = await this.writes.insertInvoice(
        {
          client_id: original.clientId,
          branch_id: original.branchId ?? ctx.user.branchId ?? null,
          pos_branch_id: owner.branchId,
          employee_id: original.employeeId,
          currency,
          due_value: round2(totals.grandTotal - refundAmount),
          reference_number: String(original.id),
          reference_id: original.id,
          code,
          type: 'returned',
          invoice_date: returnDate,
          issue_date: returnDate,
          notes,
          payment_status: status,
          is_paid: status === PAYMENT_STATUS.paid ? 1 : 0,
          created_by: ctx.user.id,
          discount_amount: totals.totalDiscount,
          discount_type: 1,
          advance_payment: refundAmount,
          shipping_cost: totals.shippingCost,
          shipping_tax: totals.shippingTax,
          tax_type: 1,
          payment_method: paymentMethod ? String(paymentMethod) : null,
          subtotal: totals.subtotal,
          tax_total: totals.taxTotal,
          grand_total: totals.grandTotal,
          accounting_period_id: (await this.stock.accountingPeriodFor(returnDate))?.id ?? null,
        },
        now,
        tx,
      );
      await this.writes.updateInvoice(original.id, { returned_payment: round2(original.returnedPayment + totals.grandTotal) }, now, tx);

      // البنود وضرائبها بعد الخصم، والتكلفة المجمَّدة من البيع
      const averages = await this.stock.averageCosts(lines.map((l) => l.productId), null);
      const costByWarehouse = new Map<number, number>();
      const taxRows: Array<Record<string, unknown>> = [];
      for (const [i, l] of lines.entries()) {
        const unitCost = l.unitCost && l.unitCost > 0 ? l.unitCost : averages.get(l.productId) ?? 0;
        await this.writes.insertItem(
          {
            invoice_id: returnId,
            product_id: l.productId,
            product_unit_id: l.productUnitId,
            store_house_id: l.warehouseId,
            item: l.name,
            description: l.description,
            quantity: l.quantity,
            quantity_in_base_unit: l.baseQuantity,
            conversion_factor: l.conversionFactor,
            unit_name: l.unitName,
            unit_price: l.unitPrice,
            discount: round2(l.discount),
            discount_type: 1,
            tax_1: l.tax1Id ? book.get(l.tax1Id)?.rate ?? 0 : 0,
            tax_2: l.tax2Id ? book.get(l.tax2Id)?.rate ?? 0 : 0,
            tax_1_id: l.tax1Id,
            tax_2_id: l.tax2Id,
            total: totals.lineTotals[i],
            unit_cost_at_sale: unitCost > 0 ? unitCost : null,
          },
          now,
          tx,
        );
        const p = products.get(l.productId);
        if (p && STOCKED.includes(p.type) && l.warehouseId && unitCost > 0) costByWarehouse.set(l.warehouseId, (costByWarehouse.get(l.warehouseId) ?? 0) + unitCost * l.baseQuantity);
        for (const t of totals.lineTaxes[i]) {
          const setting = t.id ? book.get(t.id) : null;
          if (setting) taxRows.push({ name: setting.name, invoice_id: returnId, type: setting.type, rate: setting.rate, value: t.amount, type_invoice: 'invoice', product_id: l.productId });
        }
      }
      await this.writes.insertTaxRows(taxRows, now, tx);

      await this.inventory.restock(ctx, { source: SALES_RETURN_SOURCE, number: String(returnId), date: returnDate, clientId: original.clientId, referenceType: 'SalesReturn', referenceId: returnId, currency, permissionType: 1 }, moves, now, tx);

      // قيد المرتجع — عكسُ قيد البيع بمكوّناته
      const header = { reference: code, referenceType: SALES_REFERENCE.salesReturn, clientId: original.clientId, invoiceId: returnId, currency, date: returnDate };
      const vat = await this.accounts.require('vat_payable', null, tx);
      const entryLines = [
        { accountId: (await this.accounts.require('sales_returns', null, tx)).id, description: `مردود مبيعات - مرتجع ${code}`, debit: totals.subtotal, credit: 0 },
        { accountId: clientAccount.id, description: `تخفيض مديونية العميل - مرتجع ${code}`, debit: 0, credit: totals.grandTotal },
      ];
      if (totals.totalDiscount > 0) entryLines.push({ accountId: (await this.accounts.require('allowed_discount', null, tx)).id, description: `عكس خصم مسموح به - مرتجع ${code}`, debit: 0, credit: totals.totalDiscount });
      if (totals.itemsTax > 0) entryLines.push({ accountId: vat.id, description: `عكس ضريبة القيمة المضافة على البنود - مرتجع ${code}`, debit: totals.itemsTax, credit: 0 });
      if (totals.shippingTax > 0) entryLines.push({ accountId: ((await this.accounts.find('shipping_vat_payable', null, tx)) ?? vat).id, description: `عكس ضريبة شحن مبيعات - مرتجع ${code}`, debit: totals.shippingTax, credit: 0 });
      if (totals.shippingCost > 0) entryLines.push({ accountId: (await this.accounts.require('shipping_revenue_returns', null, tx)).id, description: `مردود إيراد شحن - مرتجع ${code}`, debit: totals.shippingCost, credit: 0 });
      await this.journal.post(ctx, { ...header, description: `مرتجع مبيعات ${code} - ${clientAccount.name || 'العميل'}` }, entryLines, owner, now, tx);

      // عكس التكلفة — إلى حساب مخزون مستودع كل بند
      const costTotal = round2([...costByWarehouse.values()].reduce((s, v) => s + v, 0));
      if (costTotal > 0) {
        const names = await this.stock.warehouseNames([...costByWarehouse.keys()]);
        const debits = [];
        for (const [warehouseId, cost] of costByWarehouse) {
          const account = await this.accounts.warehouse(warehouseId, names.get(warehouseId) ?? null, now, tx);
          debits.push({ accountId: account.id, description: `إرجاع البضاعة للمخزون - مرتجع ${code}`, debit: round2(cost), credit: 0 });
        }
        await this.journal.post(
          ctx,
          { ...header, description: `تكلفة مبيعات - مرتجع ${code} - ${clientAccount.name || 'العميل'}` },
          [...debits, { accountId: (await this.accounts.require('cost_of_sales', null, tx)).id, description: `عكس تكلفة المبيعات - مرتجع ${code}`, debit: 0, credit: round2(debits.reduce((s, d) => s + d.debit, 0)) }],
          owner,
          now,
          tx,
        );
      }

      // ردّ النقد من الخزينة
      if (refundAmount > 0 && refundTreasury) {
        await this.writes.insertPayment(
          {
            invoice_id: returnId,
            client_id: original.clientId,
            branch_id: original.branchId ?? ctx.user.branchId ?? null,
            treasury_id: refundTreasury,
            amount: refundAmount,
            payment_date: `${returnDate} ${now.slice(11, 19)}`,
            Payment_method: paymentMethod ?? (await this.sales.defaultReceiptPaymentMethod()),
            reference_number: code,
            notes: `صرف مرتجع مبيعات - فاتورة رقم ${original.code} | العميل: ${original.clientName ?? '—'}`,
            type: 'treasury_return',
            payment_status: 1,
            employee_id: ctx.user.id,
            accounting_period_id: (await this.stock.accountingPeriodFor(returnDate))?.id ?? null,
          },
          now,
          tx,
        );
        await this.journal.post(
          ctx,
          { ...header, description: `صرف نقدية - مرتجع ${code}` },
          [
            { accountId: clientAccount.id, description: `تسوية حساب العميل - مرتجع ${code}`, debit: refundAmount, credit: 0 },
            { accountId: refundTreasury, description: `صرف نقدية للعميل - مرتجع ${code}`, debit: 0, credit: refundAmount },
          ],
          owner,
          now,
          tx,
        );
      }

      // العهدة التراكمية للعميل تنقص بالكميات المردودة
      const quantity = lines.reduce((s, l) => s + Math.trunc(l.quantity), 0);
      const previous = await this.writes.lastDepositCount(original.clientId as number, tx);
      await this.writes.insertClientRelation(
        {
          client_id: original.clientId,
          employee_id: ctx.user.id,
          type: 'invoice',
          invoice_id: returnId,
          description: `فاتورة مرتجعة رقم: ${code} - الكمية المرتجعة: ${quantity} قطعة - قيمة المرتجع: ${fmtMoney(totals.grandTotal)} ${currency}`,
          deposit_count: Math.max(0, previous - quantity),
          date: ctx.today,
          time: now.slice(11, 19),
          status: 'completed',
          process: 'مرتجع مبيعات',
        },
        now,
        tx,
      );

      await this.logs.record(
        {
          action: 'created',
          module: RETURN_LOG_MODULE,
          subjectId: returnId,
          description: `إنشاء فاتورة مرتجعة رقم ${code} — عن الفاتورة: ${original.code ?? '—'} — العميل: ${original.clientName ?? '—'} — الإجمالي: ${fmtMoney(totals.grandTotal)} ${currency}`,
          userId: ctx.user.id,
          ip: ctx.meta.ip,
          userAgent: ctx.meta.userAgent,
          route: ctx.meta.route,
        },
        tx,
      );
      return { id: returnId, code, refundAmount, total: totals.grandTotal };
    });

    if (original.clientId) await this.visits.markCompletedFor(ctx.user.id, original.clientId, ctx.today, ctx.nowSql, null).catch(() => undefined);

    const message =
      `تم إرجاع الفاتورة بنجاح. رقم المرتجع: ${result.code} — القيمة: ${fmtMoney(result.total)}` +
      (result.refundAmount > 0 ? ` — رُدّ للعميل نقداً: ${fmtMoney(result.refundAmount)}` : refund ? ' — لا نقد يُردّ: ما دفعه العميل لا يزيد على قيمة ما بقي عنده، فخُفّضت مديونيته.' : '');
    return { message, data: await this.detail(ctx, result.id) };
  }

  /** خزينة الردّ: المختارة إن سُمح له بالسحب منها، ثمّ خزينته، ثمّ الرئيسية */
  private async refundTreasury(ctx: SalesContext, requested: number | null, tx: Tx) {
    if (requested) {
      if (!(await this.ledger.account(requested, tx))) throw AppError.validation({ treasuryId: ['الخزينة المختارة غير موجودة.'] }, 'الخزينة المختارة غير موجودة.');
      const denied = await this.treasuries.withdrawBlock(ctx, requested);
      if (denied) throw AppError.forbidden('TREASURY_FORBIDDEN', denied);
      return requested;
    }
    if (ctx.user.employeeId) {
      const own = (await this.sales.employeeTreasuryAccountIds(ctx.user.employeeId))[0];
      if (own && (await this.ledger.account(own, tx))) return own;
    }
    return (await this.accounts.require('main_treasury', null, tx)).id;
  }

  // ═══════════════════════ القراءة ═══════════════════════

  private async findReturn(ctx: SalesContext, id: number): Promise<InvoiceRow> {
    const row = await this.sales.invoice(id);
    if (!row || row.type !== 'returned') throw AppError.notFound('RETURN_NOT_FOUND', 'المرتجع غير موجود.');
    if (await ctx.canAccessDocument(row.createdBy, row.employeeId, row.branchId)) return row;
    throw AppError.forbidden('RETURN_FORBIDDEN', 'ليس لديك صلاحية لعرض هذا المرتجع.');
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, RETURN_PERMISSIONS.view);
    return this.detail(ctx, id);
  }

  private async detail(ctx: SalesContext, id: number) {
    const row = await this.findReturn(ctx, id);
    const [items, original, refunds] = await Promise.all([
      this.sales.invoiceItems(row.id),
      row.referenceNumber && /^\d+$/.test(row.referenceNumber) ? this.sales.invoice(Number(row.referenceNumber)) : Promise.resolve(null),
      this.sales.invoicePayments(row.id),
    ]);
    return {
      ...this.summary(row),
      originalInvoice: original && (SALE_TYPES as readonly string[]).includes(original.type ?? '') ? { id: original.id, code: original.code, grandTotal: original.grandTotal } : null,
      notes: row.notes,
      items: items.map((i: InvoiceItemRow) => ({
        id: i.id,
        productId: i.productId,
        item: i.item,
        unitName: i.unitName,
        warehouse: i.storeHouseId ? { id: i.storeHouseId, name: i.storeHouseName } : null,
        quantity: i.quantity,
        quantityInBaseUnit: i.quantityInBaseUnit,
        unitPrice: i.unitPrice,
        discount: i.discount,
        tax1Id: i.tax1Id,
        tax2Id: i.tax2Id,
        total: i.total,
      })),
      refunds,
    };
  }

  private summary(row: InvoiceRow) {
    return {
      id: row.id,
      code: row.code,
      client: row.clientId ? { id: row.clientId, tradeName: row.clientName, code: row.clientCode } : null,
      branch: row.branchId ? { id: row.branchId, name: row.branchName } : null,
      employee: row.employeeId ? { id: row.employeeId, name: row.employeeName } : null,
      createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName } : null,
      returnDate: row.invoiceDate,
      currency: row.currency,
      subtotal: row.subtotal,
      discountAmount: row.discountAmount,
      shippingCost: row.shippingCost,
      shippingTax: row.shippingTax,
      taxTotal: row.taxTotal,
      grandTotal: row.grandTotal,
      refunded: row.advancePayment,
      dueValue: row.dueValue,
      paymentStatus: row.paymentStatus,
      paymentStatusLabel: row.paymentStatus ? PAYMENT_STATUS_LABELS[row.paymentStatus] ?? null : null,
      createdAt: row.createdAt,
    };
  }

  async list(userId: number, meta: RequestMeta, q: ReturnListQuery) {
    const ctx = await this.load(userId, meta, RETURN_PERMISSIONS.view);
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;
    const { start, end } = await this.invoiceQueries.range(ctx, q.fromDate, q.toDate);
    const defaultCurrency = (await this.reference.defaultCurrency())?.code ?? 'SAR';
    const { rows, total } = await this.sales.invoicePage(
      {
        scope: await ctx.documentScope(),
        headerBranchIds: await ctx.headerBranchIds(),
        types: ['returned'],
        clientId: q.clientId,
        invoiceNumber: q.invoiceNumber?.trim() || undefined,
        currency: null,
        defaultCurrency,
        branchIds: q.branch ? (ctx.tree.find(q.branch) ? ctx.tree.subtree(q.branch) : [q.branch]) : undefined,
        totalFrom: q.totalFrom,
        totalTo: q.totalTo,
        start,
        end,
        closedRanges: await this.sales.closedRanges(),
        createdBy: q.createdBy,
        employeeId: q.employeeId,
      },
      page,
      perPage,
    );
    return { items: rows.map((r) => ({ ...this.summary(r), originalInvoiceId: r.referenceNumber && /^\d+$/.test(r.referenceNumber) ? Number(r.referenceNumber) : null })), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)), range: { from: start, to: end } };
  }
}
