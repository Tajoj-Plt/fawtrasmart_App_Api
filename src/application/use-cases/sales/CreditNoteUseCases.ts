import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository, OperationLogRepository } from '../../../domain/repositories/clients';
import { CreditNoteRepository, CreditNoteRow, InvoiceItemRow, SalesRepository, SalesUnitOption, SalesWriteRepository } from '../../../domain/repositories/sales';
import { LedgerRepository, StockRepository } from '../../../domain/repositories/stock';
import { VisitRepository } from '../../../domain/repositories/visits';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { fmtMoney, fmtQty, round2 } from '../../../domain/services/sales/SalesMath';
import { CREDIT_NOTE_LOG_MODULE, CREDIT_NOTE_PERMISSIONS, CREDIT_NOTE_SOURCE, CREDIT_NOTE_STATUS_LABELS, SALES_LIMITS, SALES_PLAN, SALES_REFERENCE, SALES_SECTIONS, WAREHOUSE_DISBURSEMENT_SOURCE } from '../../../domain/services/sales/SalesConstants';
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
import { SalesSettings } from '../../services/sales/SalesSettings';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { InvoiceQueryUseCases } from './InvoiceQueryUseCases';

const PER_PAGE = [10, 25, 50, 100];
const STOCKED = ['products', 'compiled'];
const MAX_MONEY = 99_999_999.99;

export interface CreditNoteListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  number?: string;
  status?: number;
  branch?: number;
  fromDate?: string;
  toDate?: string;
}

interface SettlementPlan {
  previousBalance: number;
  previousPay: number;
  invoices: Array<{ id: number; code: string | null; date: string | null; total: number; due: number; pay: number }>;
  unallocated: number;
}

const blocked = {
  notSale: 'هذا المستند مرتجعٌ لا فاتورة بيع — لا يُعمل عليه إشعارٌ دائن.',
  hasReturn: 'لهذه الفاتورة مرتجعٌ سابق — والمرتجعُ ردٌّ لها، فلا يُعمل لها إشعارٌ دائن أيضاً.',
  hasCredit: 'لهذه الفاتورة إشعارٌ دائنٌ سابق، ولا يُعمل لها إشعارٌ آخر.',
  voided: 'الفاتورة ملغاة — لا يُعمل عليها إشعارٌ دائن.',
};

/**
 * الإشعارات الدائنة — `CreditNotificationController` و`ClientDebtSettlement`.
 * على فاتورةٍ: البنود منها كالمرتجع. وبلا فاتورة: الكمية بحدود ما بيع للعميل
 * من الصنف (ناقصاً ما رُدّ)، والسعر بحدود آخر سعر بيعٍ له — الويب يقبل هنا
 * أيّ كميةٍ بأيّ سعر.
 */
export class CreditNoteUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly notes: CreditNoteRepository,
    private readonly sales: SalesRepository,
    private readonly writes: SalesWriteRepository,
    private readonly stock: StockRepository,
    private readonly ledger: LedgerRepository,
    private readonly accounts: LedgerAccounts,
    private readonly journal: SalesJournal,
    private readonly inventory: SalesInventory,
    private readonly proximity: SalesProximity,
    private readonly settings: SalesSettings,
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
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.creditNotes], permissions: [permission] });
  }

  // ═══════════════════════ التسوية ═══════════════════════

  /**
   * `ClientDebtSettlement::plan()` — الفاتورة المرجعية أوّلاً، ثمّ الرصيد السابق
   * (الافتتاحيّ غير المسدَّد)، ثمّ الفواتير المفتوحة من الأقدم. والمستحقّ
   * يطرح ما سُدِّد من المحفظة وما سوّاه ردٌّ سابق.
   */
  private async plan(clientId: number, amount: number, preferredInvoiceId: number | null, tx?: Tx): Promise<SettlementPlan> {
    let remaining = round2(Math.max(0, amount));
    const invoices = await this.notes.openInvoices(clientId, tx);
    const due = new Map(invoices.map((i) => [i.id, round2(Math.max(0, Math.min(i.grandTotal - i.paid - i.walletPaidAmount, i.dueValue) - i.returnedPayment))]));

    let previousBalance = 0;
    const account = await this.sales.clientLedgerAccount(clientId, tx);
    if (account) {
      const residual = Math.max(0, (await this.notes.ledgerBalance(account.id, tx)) - [...due.values()].reduce((s, v) => s + v, 0));
      const opening = Math.max(0, (await this.notes.openingBalance(account.id, tx)) - (await this.notes.openingPaid(clientId, tx)));
      previousBalance = round2(Math.min(residual, opening));
    }

    const preferred = preferredInvoiceId ? invoices.find((i) => i.id === preferredInvoiceId) ?? null : null;
    const queue: Array<(typeof invoices)[number] | 'previous'> = [...(preferred ? [preferred] : []), 'previous', ...invoices.filter((i) => i !== preferred)];
    const lines: SettlementPlan['invoices'] = [];
    let previousPay = 0;
    for (const entry of queue) {
      if (remaining <= 0) break;
      if (entry === 'previous') {
        previousPay = round2(Math.min(remaining, previousBalance));
        remaining = round2(remaining - previousPay);
        continue;
      }
      const d = due.get(entry.id) ?? 0;
      if (d <= 0) continue;
      const pay = round2(Math.min(remaining, d));
      remaining = round2(remaining - pay);
      lines.push({ id: entry.id, code: entry.code, date: entry.invoiceDate, total: entry.grandTotal, due: d, pay });
    }
    return { previousBalance, previousPay, invoices: lines, unallocated: remaining };
  }

  async settlementPreview(userId: number, meta: RequestMeta, q: { clientId: number; amount: number; invoiceId?: number }) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.create);
    if (!(await this.sales.client(q.clientId))) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await ctx.assertClient(q.clientId);
    return this.plan(q.clientId, q.amount, q.invoiceId ?? null);
  }

  // ═══════════════════════ شاشة الإنشاء ═══════════════════════

  private async invoiceBlock(invoice: { id: number; type: string | null; voidedAt: string | null }) {
    if (invoice.type === 'returned') return blocked.notSale;
    if (invoice.voidedAt) return blocked.voided;
    if ((await this.sales.returnedInvoiceIds([invoice.id])).has(invoice.id)) return blocked.hasReturn;
    if ((await this.sales.activeCreditNoteInvoiceIds([invoice.id])).has(invoice.id)) return blocked.hasCredit;
    return null;
  }

  async createData(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.create);
    if (!(await this.sales.client(clientId))) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await ctx.assertClient(clientId);
    const [rules, book, periodBlock, nextNumber] = await Promise.all([
      this.settings.rules(),
      this.settings.taxBook(),
      this.periodGuard.block(ctx.today, ctx.today, (p) => ctx.can(p)),
      this.numbers.peek(SALES_SECTIONS.creditNote, ctx.now),
    ]);
    const { rows } = await this.sales.invoicePage(
      { scope: await ctx.documentScope(), headerBranchIds: await ctx.headerBranchIds(), clientId, currency: null, defaultCurrency: 'SAR', start: '1900-01-01', end: '2999-12-31', closedRanges: [] },
      1,
      100,
    );
    const ids = rows.map((r) => r.id);
    const [returned, credited] = await Promise.all([this.sales.returnedInvoiceIds(ids), this.sales.activeCreditNoteInvoiceIds(ids)]);
    return {
      invoices: rows.filter((r) => !r.voidedAt && !returned.has(r.id) && !credited.has(r.id)).map((r) => ({ id: r.id, code: r.code, invoiceDate: r.invoiceDate, grandTotal: r.grandTotal })),
      warehouses: await ctx.warehouseOptions(rules.warehouseSource),
      taxes: [...book.values()].map((t) => ({ id: t.id, name: t.name, rate: t.rate, type: t.type })),
      periodBlock,
      nextNumber,
    };
  }

  // ═══════════════════════ الإصدار ═══════════════════════

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.create);
    const book = await this.settings.taxBook();
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const clientId = form.integer('clientId', { required: true, min: 1, message: 'اختر العميل.' });
    const invoiceId = form.integer('invoiceId', { min: 1 });
    const dateField = (key: string, fallback: string) => {
      const text = form.string(key);
      if (text === null) return fallback;
      const d = parseInputDate(text);
      if (!d) {
        errors.add(key, 'التاريخ بصيغة YYYY-MM-DD.');
        return fallback;
      }
      return toSqlDate(d);
    };
    const creditDate = dateField('creditDate', ctx.today);
    const releaseDate = dateField('releaseDate', creditDate);
    const includeShipping = form.boolean('includeShipping') ?? false;
    const notes = form.string('notes', { max: 5000 });
    const requestedEmployee = form.integer('employeeId', { min: 1 });
    const latitude = form.number('currentLatitude', { min: -90, max: 90 });
    const longitude = form.number('currentLongitude', { min: -180, max: 180 });
    const list = form.array('items', { required: true, min: 1, max: 200, message: 'أضف بنداً واحداً على الأقل.' }) ?? [];

    type Raw = { invoiceItemId: number | null; productId: number | null; unitId: number | null; quantity: number; unitPrice: number | null; discount: number; discountType: 'amount' | 'percentage'; tax1Id: number | null; tax2Id: number | null; warehouseId: number | null; description: string | null };
    const raws: Raw[] = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `items.${i}`);
      const quantity = item.number('quantity', { required: true, message: 'الكمية مطلوبة.' });
      if (quantity !== null && quantity <= 0) errors.add(`items.${i}.quantity`, 'الكمية يجب أن تكون أكبر من صفر.');
      const raw: Raw = {
        invoiceItemId: item.integer('invoiceItemId', { min: 1 }),
        productId: item.integer('productId', { min: 1 }),
        unitId: item.integer('unitId', { min: 1 }),
        quantity: quantity ?? 0,
        unitPrice: item.number('unitPrice', { min: 0, max: MAX_MONEY }),
        discount: item.number('discount', { min: 0, max: MAX_MONEY }) ?? 0,
        discountType: item.oneOf('discountType', ['amount', 'percentage'] as const) ?? 'amount',
        tax1Id: item.integer('tax1Id', { min: 1 }),
        tax2Id: item.integer('tax2Id', { min: 1 }),
        warehouseId: item.integer('warehouseId', { min: 1 }),
        description: item.string('description', { max: 1000 }),
      };
      if (invoiceId && raw.invoiceItemId === null) errors.add(`items.${i}.invoiceItemId`, 'على فاتورة: اختر بند الفاتورة.');
      if (!invoiceId) {
        if (raw.productId === null) errors.add(`items.${i}.productId`, 'اختر المنتج.');
        if (raw.unitPrice === null) errors.add(`items.${i}.unitPrice`, 'السعر مطلوب.');
        if (raw.discountType === 'percentage' && raw.discount > 100) errors.add(`items.${i}.discount`, 'نسبة الخصم لا تتجاوز 100.');
        for (const [k, id] of [['tax1Id', raw.tax1Id], ['tax2Id', raw.tax2Id]] as const) if (id !== null && !book.has(id)) errors.add(`items.${i}.${k}`, 'الضريبة غير موجودة في «إعدادات الضريبة».');
      }
      raws.push(raw);
    });
    errors.throwIfAny();

    const client = await this.sales.client(clientId as number);
    if (!client) throw AppError.validation({ clientId: ['العميل المحدَّد غير موجود.'] }, 'العميل المحدَّد غير موجود.');
    await ctx.assertClient(client.id);

    const rules = await this.settings.rules();
    const fallbackWarehouse = await ctx.resolveWarehouse(rules.warehouseSource, null);
    let lines: CreditLine[] = [];
    let documentDiscount = 0;
    let shipping = { cost: 0, tax: 0 };

    if (invoiceId) {
      const invoice = await this.invoiceQueries.find(ctx, invoiceId);
      if (invoice.clientId !== client.id) throw AppError.validation({ invoiceId: [`الفاتورة ${invoice.code} ليست لهذا العميل.`] }, `الفاتورة ${invoice.code} ليست لهذا العميل.`);
      const reason = await this.invoiceBlock(invoice);
      if (reason) throw new AppError('CREDIT_NOTE_BLOCKED', reason, 422);
      const items = await this.sales.invoiceItems(invoice.id);
      const byId = new Map(items.map((i) => [i.id, i]));
      const seen = new Set<number>();
      for (const r of raws) {
        const item = byId.get(r.invoiceItemId as number);
        if (!item || !item.productId) throw AppError.validation({ items: [`البند #${r.invoiceItemId} ليس من بنود الفاتورة ${invoice.code}.`] }, `البند #${r.invoiceItemId} ليس من بنود الفاتورة ${invoice.code}.`);
        if (seen.has(item.id)) throw AppError.validation({ items: ['البند مكرَّر — اجمع كميته في سطرٍ واحد.'] }, 'البند مكرَّر — اجمع كميته في سطرٍ واحد.');
        seen.add(item.id);
        if (r.quantity - item.quantity > 0.0001) throw AppError.validation({ items: [`لا يمكن ردّ ${fmtQty(r.quantity)} من «${item.item}»: المباع في الفاتورة ${fmtQty(item.quantity)}.`] }, `لا يمكن ردّ ${fmtQty(r.quantity)} من «${item.item}»: المباع في الفاتورة ${fmtQty(item.quantity)}.`);
        lines.push(lineFromInvoice(item, r.quantity, fallbackWarehouse));
      }
      const saleLines = items.filter((i: InvoiceItemRow) => i.productId);
      const allNet = saleLines.reduce((s, i) => s + Math.max(0, i.quantity * i.unitPrice - i.discount), 0);
      const net = lines.reduce((s, l) => s + Math.max(0, l.quantity * l.unitPrice - l.discount), 0);
      documentDiscount = allNet > 0 ? round2((documentDiscountOf(invoice, items) * net) / allNet) : 0;
      if (includeShipping) shipping = { cost: invoice.shippingCost, tax: invoice.shippingTax };
    } else {
      lines = await this.freeLines(ctx, client.id, raws, fallbackWarehouse);
    }

    await this.proximity.assert(ctx, CREDIT_NOTE_PERMISSIONS.bypassLocation, client.id, latitude, longitude);
    const periodBlock = await this.periodGuard.block(creditDate, ctx.today, (p) => ctx.can(p));
    if (periodBlock) throw new AppError('ACCOUNTING_PERIOD_CLOSED', periodBlock, 422);
    await this.planLimits.assert(SALES_LIMITS.creditNotes, ctx.now);

    const totals = creditTotals(book, lines, documentDiscount, shipping);
    const products = await this.sales.products(lines.map((l) => l.productId));
    const moves = await this.movesFor(lines, products, totals.lineTotals);
    const clientAccount = await this.sales.clientLedgerAccount(client.id);
    if (!clientAccount) throw new AppError('CLIENT_ACCOUNT_MISSING', `لا حساب محاسبيّ للعميل «${client.tradeName ?? '—'}».`, 422);
    const employeeId = await ctx.clampEmployee(requestedEmployee);

    const result = await this.uow.run(async (tx) => {
      if (invoiceId) {
        await this.notes.lockInvoice(invoiceId, tx);
        const reason = await this.invoiceBlock({ id: invoiceId, type: null, voidedAt: null });
        if (reason) throw new AppError('CREDIT_NOTE_BLOCKED', reason, 422);
      }
      await this.planLimits.assert(SALES_LIMITS.creditNotes, ctx.now);
      const permits = this.inventory.permitsFor(moves);
      if (permits) await this.planLimits.assert('warehouse_permits', ctx.now, permits);

      const now = ctx.nowSql;
      const currency = (await this.reference.defaultCurrency())?.code ?? 'SAR';
      const number = await this.numbers.next(SALES_SECTIONS.creditNote, ctx.now, tx);
      // خطّة التسوية قبل القيد: الرصيد السابق مشتقٌّ من رصيد الحساب، والقيد يُنزله
      const settlement = await this.plan(client.id, totals.grandTotal, invoiceId ?? null, tx);
      const owner = await this.journal.owner(ctx);

      const noteId = await this.notes.insert(
        {
          client_id: client.id,
          branch_id: ctx.user.branchId ?? null,
          invoice_id: invoiceId ?? null,
          credit_number: number,
          currency,
          release_date: releaseDate,
          credit_date: creditDate,
          notes,
          created_by: ctx.user.id,
          employee_id: employeeId ?? ctx.user.employeeId ?? null,
          store_house_id: lines.find((l) => l.warehouseId)?.warehouseId ?? null,
          discount_amount: totals.documentDiscount,
          discount_type: 1,
          shipping_cost: totals.shippingCost,
          shipping_tax: totals.shippingTax,
          tax_type: '1',
          tax_rate: 0,
          subtotal: totals.subtotal,
          total_discount: totals.totalDiscount,
          total_tax: totals.taxTotal,
          grand_total: totals.grandTotal,
          status: 3,
          accounting_period_id: (await this.stock.accountingPeriodFor(creditDate))?.id ?? null,
        },
        now,
        tx,
      );

      const averages = await this.stock.averageCosts(lines.map((l) => l.productId), null);
      const costByWarehouse = new Map<number, number>();
      const taxRows: Array<Record<string, unknown>> = [];
      for (const [i, l] of lines.entries()) {
        const unitCost = l.unitCost && l.unitCost > 0 ? l.unitCost : averages.get(l.productId) ?? 0;
        await this.writes.insertItem(
          {
            credit_note_id: noteId,
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
          if (setting) taxRows.push({ name: setting.name, invoice_id: noteId, type: setting.type, rate: setting.rate, value: t.amount, type_invoice: 'credit', product_id: l.productId });
        }
      }
      await this.writes.insertTaxRows(taxRows, now, tx);

      await this.inventory.restock(ctx, { source: CREDIT_NOTE_SOURCE, number, date: creditDate, clientId: client.id, referenceType: 'CreditNote', referenceId: noteId, currency, permissionType: 1 }, moves, now, tx);

      // قيد الإشعار — المرجع معرّفه كما يقرؤه الإلغاء والتسوية في الويب
      const header = { reference: String(noteId), referenceType: SALES_REFERENCE.creditNote, clientId: client.id, invoiceId: null, currency, date: creditDate };
      const vat = await this.accounts.require('vat_payable', null, tx);
      const entryLines = [
        { accountId: (await this.accounts.require('sales_returns', null, tx)).id, description: `مردود مبيعات - إشعار دائن ${number}`, debit: totals.subtotal, credit: 0 },
        { accountId: clientAccount.id, description: `تخفيض مديونية العميل - إشعار دائن ${number}`, debit: 0, credit: totals.grandTotal },
      ];
      if (totals.totalDiscount > 0) entryLines.push({ accountId: (await this.accounts.require('allowed_discount', null, tx)).id, description: `عكس خصم مسموح به - إشعار دائن ${number}`, debit: 0, credit: totals.totalDiscount });
      if (totals.itemsTax > 0) entryLines.push({ accountId: vat.id, description: `عكس ضريبة القيمة المضافة على البنود - إشعار دائن ${number}`, debit: totals.itemsTax, credit: 0 });
      if (totals.shippingTax > 0) entryLines.push({ accountId: ((await this.accounts.find('shipping_vat_payable', null, tx)) ?? vat).id, description: `عكس ضريبة شحن مبيعات - إشعار دائن ${number}`, debit: totals.shippingTax, credit: 0 });
      if (totals.shippingCost > 0) entryLines.push({ accountId: (await this.accounts.require('shipping_revenue_returns', null, tx)).id, description: `مردود إيراد شحن - إشعار دائن ${number}`, debit: totals.shippingCost, credit: 0 });
      const entryId = await this.journal.post(ctx, { ...header, description: `إشعار دائن ${number} - ${clientAccount.name || 'العميل'}` }, entryLines, owner, now, tx);

      // `ClientDebtSettlement::apply()` — الرصيد السابق بسند، والفواتير بروابط القيد
      if (settlement.previousPay > 0) {
        await this.writes.insertPayment(
          { client_id: client.id, invoice_id: null, employee_id: null, amount: settlement.previousPay, type: 'credit_note_previous_balance', payment_date: creditDate, payment_status: 1, reference_number: `CN-${noteId}`, notes: `تسوية رصيد سابق - إشعار دائن ${number}` },
          now,
          tx,
        );
      }
      const codes: string[] = [];
      for (const line of settlement.invoices) {
        if (line.pay <= 0) continue;
        await this.notes.addReturned(line.id, line.pay, now, tx);
        await this.notes.insertLink(entryId, line.id, line.pay, now, tx);
        codes.push(line.code ?? String(line.id));
      }
      if (codes.length > 1) await this.notes.setLinking(entryId, 'multiple', codes.join(', ').slice(0, 255), tx);

      const costTotal = round2([...costByWarehouse.values()].reduce((s, v) => s + v, 0));
      if (costTotal > 0) {
        const names = await this.stock.warehouseNames([...costByWarehouse.keys()]);
        const debits = [];
        for (const [warehouseId, cost] of costByWarehouse) {
          const account = await this.accounts.warehouse(warehouseId, names.get(warehouseId) ?? null, now, tx);
          debits.push({ accountId: account.id, description: `إرجاع البضاعة للمخزون - إشعار دائن ${number}`, debit: round2(cost), credit: 0 });
        }
        await this.journal.post(
          ctx,
          { ...header, description: `تكلفة مبيعات - إشعار دائن ${number} - ${clientAccount.name || 'العميل'}` },
          [...debits, { accountId: (await this.accounts.require('cost_of_sales', null, tx)).id, description: `عكس تكلفة المبيعات - إشعار دائن ${number}`, debit: 0, credit: round2(debits.reduce((s, d) => s + d.debit, 0)) }],
          owner,
          now,
          tx,
        );
      }

      const quantity = lines.reduce((s, l) => s + Math.trunc(l.quantity), 0);
      const previous = await this.writes.lastDepositCount(client.id, tx);
      await this.writes.insertClientRelation(
        {
          client_id: client.id,
          employee_id: ctx.user.id,
          type: 'invoice',
          invoice_id: null,
          description: `اشعار دائن رقم: ${number} - الكمية: ${quantity} قطعة - القيمة: ${fmtMoney(totals.grandTotal)} ${currency}`,
          deposit_count: Math.max(0, previous - quantity),
          date: ctx.today,
          time: now.slice(11, 19),
          status: 'completed',
          process: 'اشعار دائن',
          additional_data: JSON.stringify({ credit_notification_id: noteId }),
        },
        now,
        tx,
      );

      await this.logs.record(
        {
          action: 'created',
          module: CREDIT_NOTE_LOG_MODULE,
          subjectId: noteId,
          description: `إنشاء إشعار دائن رقم ${number} — العميل: ${client.tradeName ?? '—'} — الإجمالي: ${fmtMoney(totals.grandTotal)} ${currency}`,
          userId: ctx.user.id,
          ip: ctx.meta.ip,
          userAgent: ctx.meta.userAgent,
          route: ctx.meta.route,
        },
        tx,
      );
      return { id: noteId, number, settlement };
    });

    await this.visits.markCompletedFor(ctx.user.id, client.id, ctx.today, ctx.nowSql, null).catch(() => undefined);

    const s = result.settlement;
    const parts = [s.previousPay > 0 ? `رصيد سابق ${fmtMoney(s.previousPay)}` : null, ...s.invoices.map((i) => `${i.code} (${fmtMoney(i.pay)})`)].filter(Boolean);
    const message = `تم إنشاء اشعار دائن بنجاح. رقم الإشعار: ${result.number}` + (parts.length ? ` — سُوِّي منه: ${parts.join('، ')}` : '') + (s.unallocated > 0 ? ` — رصيدٌ دائن للعميل: ${fmtMoney(s.unallocated)}` : '');
    return { message, data: await this.detail(ctx, result.id) };
  }

  /** بنودٌ بلا فاتورة — الكمية بحدود المباع للعميل، والسعر بحدود آخر سعر بيعٍ له */
  private async freeLines(ctx: SalesContext, clientId: number, raws: Array<{ productId: number | null; unitId: number | null; quantity: number; unitPrice: number | null; discount: number; discountType: 'amount' | 'percentage'; tax1Id: number | null; tax2Id: number | null; warehouseId: number | null; description: string | null }>, fallbackWarehouse: number | null): Promise<CreditLine[]> {
    const products = await this.sales.products(raws.map((r) => r.productId as number));
    const units = await this.sales.unitsFor([...products.values()]);
    const demand = new Map<number, number>();
    const lines: CreditLine[] = [];
    for (const [i, r] of raws.entries()) {
      const p = products.get(r.productId as number);
      if (!p) throw AppError.validation({ [`items.${i}.productId`]: ['المنتج غير موجود.'] }, 'المنتج غير موجود.');
      let unit: SalesUnitOption | null = null;
      if (r.unitId !== null) {
        unit = (units.get(p.id) ?? []).find((u) => u.id === r.unitId) ?? null;
        if (!unit) throw AppError.validation({ [`items.${i}.unitId`]: ['الوحدة المختارة ليست من وحدات هذا الصنف.'] }, 'الوحدة المختارة ليست من وحدات هذا الصنف.');
      }
      const factor = unit?.conversionFactor || 1;
      let warehouseId = fallbackWarehouse;
      if (r.warehouseId !== null) {
        if (!(await this.stock.warehouse(r.warehouseId))) throw AppError.validation({ [`items.${i}.warehouseId`]: ['المستودع المختار غير موجود.'] }, 'المستودع المختار غير موجود.');
        warehouseId = r.warehouseId;
      }
      const limits = await this.notes.clientReturnable(clientId, p.id);
      const basePrice = (r.unitPrice as number) / factor;
      if (limits.lastBasePrice !== null && basePrice - limits.lastBasePrice > 0.01) {
        throw AppError.validation({ [`items.${i}.unitPrice`]: [`سعر ردّ «${p.name}» (${fmtQty(basePrice)} للوحدة الأساسية) أعلى من آخر سعر بيعٍ له لهذا العميل (${fmtQty(limits.lastBasePrice)}).`] }, `سعر ردّ «${p.name}» أعلى من آخر سعر بيعٍ له لهذا العميل.`);
      }
      demand.set(p.id, (demand.get(p.id) ?? 0) + r.quantity * factor);
      const available = Math.max(0, limits.sold - limits.returned);
      if ((demand.get(p.id) as number) - available > 0.0001) {
        throw AppError.validation(
          { [`items.${i}.quantity`]: [`لا يمكن ردّ ${fmtQty(demand.get(p.id) as number)} من «${p.name}» بالوحدة الأساسية: المباع لهذا العميل ${fmtQty(limits.sold)} والمردود سابقاً ${fmtQty(limits.returned)}، فالمتاح للردّ ${fmtQty(available)}.`] },
          `لا يمكن ردّ هذه الكمية من «${p.name}»: المتاح للردّ ${fmtQty(available)}.`,
        );
      }
      const gross = r.quantity * (r.unitPrice as number);
      const discount = r.discountType === 'percentage' ? (gross * r.discount) / 100 : r.discount;
      if (discount - gross > 0.001) throw AppError.validation({ [`items.${i}.discount`]: ['خصم البند أكبر من قيمته.'] }, 'خصم البند أكبر من قيمته.');
      lines.push({
        source: null,
        productId: p.id,
        name: p.name,
        productUnitId: unit?.id ?? null,
        unitName: unit?.name ?? null,
        conversionFactor: factor,
        quantity: r.quantity,
        baseQuantity: r.quantity * factor,
        unitPrice: r.unitPrice as number,
        discount,
        tax1Id: r.tax1Id,
        tax2Id: r.tax2Id,
        warehouseId,
        description: r.description,
        unitCost: null,
      });
    }
    return lines;
  }

  /** حركات الإدخال: الصنف المخزَّن في مستودع بنده، والمجمَّع الفوري بمكوّناته */
  private async movesFor(lines: CreditLine[], products: Map<number, { id: number; name: string; type: string; compileType: string | null }>, lineTotals: number[]): Promise<StockMove[]> {
    const instant = lines.filter((l) => products.get(l.productId)?.type === 'compiled' && products.get(l.productId)?.compileType === 'Instant').map((l) => l.productId);
    const compiled = await this.sales.compiledComponents(instant);
    const names = await this.sales.products([...compiled.values()].flat().map((c) => c.productId));
    const moves: StockMove[] = [];
    lines.forEach((l, i) => {
      const p = products.get(l.productId);
      if (!p || !STOCKED.includes(p.type) || !l.warehouseId) return;
      if (p.type === 'compiled' && p.compileType === 'Instant') {
        for (const c of compiled.get(p.id) ?? []) moves.push({ productId: c.productId, name: names.get(c.productId)?.name ?? `#${c.productId}`, warehouseId: l.warehouseId, baseQuantity: c.quantity * l.baseQuantity, unitPrice: 0, total: 0 });
        return;
      }
      moves.push({ productId: l.productId, name: p.name, warehouseId: l.warehouseId, baseQuantity: l.baseQuantity, unitPrice: l.baseQuantity > 0 ? round2(lineTotals[i] / l.baseQuantity) : 0, total: lineTotals[i] });
    });
    return moves;
  }

  // ═══════════════════════ الإلغاء ═══════════════════════

  /**
   * `cancel()` — عكسُ المخزون (ولا يُلغى ما خرج بعده) والتسوية وكلِّ قيدٍ بقيدٍ
   * عكسيّ بتاريخ اليوم. ويبقى منشئ الإشعار كما هو — الويب يكتب فوقه اسمَ من ألغاه.
   */
  async cancel(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.cancel);
    if (!ctx.can('data_scope_all')) throw AppError.forbidden('CREDIT_NOTE_CANCEL_FORBIDDEN', 'عذراً، لا يمكن للموظفين إلغاء الإشعارات');
    const note = await this.findNote(ctx, id);
    const block = await this.periodGuard.block(ctx.today, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);

    const items = await this.sales.creditNoteItems(note.id);
    const products = await this.sales.products(items.map((i) => i.productId as number).filter(Boolean));
    const lines: CreditLine[] = items.filter((i) => i.productId).map((i) => ({ ...lineFromInvoice(i, i.quantity, note.storeHouseId), discount: i.discount }));
    const moves = await this.movesFor(lines, products, items.filter((i) => i.productId).map((i) => i.total));

    await this.uow.run(async (tx) => {
      await this.notes.lock(note.id, tx);
      const fresh = await this.notes.find(note.id, tx);
      if (!fresh || [0, 5].includes(fresh.status ?? -1)) throw new AppError('CREDIT_NOTE_CANCELLED', 'هذا الإشعار ملغي مسبقاً', 422);
      const permits = this.inventory.permitsFor(moves);
      if (permits) await this.planLimits.assert('warehouse_permits', ctx.now, permits);

      const now = ctx.nowSql;
      await this.inventory.unstock(ctx, { source: WAREHOUSE_DISBURSEMENT_SOURCE, number: `CANCEL-${note.creditNumber}`, date: now, clientId: note.clientId, referenceType: 'CreditNoteCancel', referenceId: note.id, currency: note.currency ?? 'SAR', permissionType: 2 }, moves, now, tx);

      // عكس التسوية
      const links = await this.notes.links(note.id, note.clientId as number, tx);
      for (const l of links) await this.notes.addReturned(l.invoiceId, -l.amount, now, tx);
      await this.notes.deleteLinks(links.map((l) => l.linkId), tx);
      await this.notes.deletePreviousBalancePayments(note.id, tx);

      // قيدٌ عكسيّ لكل قيد — لا حذف
      const owner = await this.journal.owner(ctx);
      for (const entry of await this.notes.entries(note.id, note.clientId as number, tx)) {
        const details = await this.ledger.details(entry.id, tx);
        if (!details.length) continue;
        await this.journal.post(
          ctx,
          { reference: `REV-${note.id}`, referenceType: SALES_REFERENCE.creditNote, description: `قيد عكسي لإلغاء إشعار دائن ${note.creditNumber} - من القيد رقم #${entry.id}`, clientId: note.clientId, invoiceId: null, currency: entry.currency ?? note.currency ?? 'SAR', date: ctx.today },
          details.map((d) => ({ accountId: d.accountId, description: `عكس: ${d.description ?? ''}`, debit: d.credit, credit: d.debit })),
          owner,
          now,
          tx,
        );
      }
      await this.notes.deleteTaxRows(note.id, tx);
      await this.notes.update(note.id, { status: 0 }, now, tx);

      await this.logs.record(
        { action: 'cancelled', module: CREDIT_NOTE_LOG_MODULE, subjectId: note.id, description: `إلغاء إشعار دائن رقم ${note.creditNumber} — عُكست قيوده وأُرجعت كمّياته`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route },
        tx,
      );
    });

    return { message: `تم إلغاء إشعار الدائن رقم ${note.creditNumber} بنجاح`, data: await this.detail(ctx, note.id) };
  }

  // ═══════════════════════ القراءة ═══════════════════════

  private async findNote(ctx: SalesContext, id: number): Promise<CreditNoteRow> {
    const note = await this.notes.find(id);
    if (!note) throw AppError.notFound('CREDIT_NOTE_NOT_FOUND', 'الإشعار الدائن غير موجود.');
    if (!(await ctx.canAccessDocument(note.createdBy, note.employeeId, note.branchId))) throw AppError.forbidden('CREDIT_NOTE_FORBIDDEN', 'ليس لديك صلاحية لعرض هذا الإشعار.');
    return note;
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.view);
    return this.detail(ctx, id);
  }

  private async detail(ctx: SalesContext, id: number) {
    const note = await this.findNote(ctx, id);
    const [items, links, previous] = await Promise.all([this.sales.creditNoteItems(note.id), this.notes.links(note.id, note.clientId ?? 0), this.notes.previousBalancePaid(note.id)]);
    return {
      ...this.summary(note),
      notes: note.notes,
      items: items.map((i) => ({ id: i.id, productId: i.productId, item: i.item, unitName: i.unitName, warehouse: i.storeHouseId ? { id: i.storeHouseId, name: i.storeHouseName } : null, quantity: i.quantity, quantityInBaseUnit: i.quantityInBaseUnit, unitPrice: i.unitPrice, discount: i.discount, tax1Id: i.tax1Id, tax2Id: i.tax2Id, total: i.total })),
      settlement: { previousBalance: round2(previous), invoices: links.map((l) => ({ invoiceId: l.invoiceId, amount: round2(l.amount) })) },
    };
  }

  private summary(n: CreditNoteRow) {
    return {
      id: n.id,
      number: n.creditNumber,
      client: n.clientId ? { id: n.clientId, tradeName: n.clientName } : null,
      branch: n.branchId ? { id: n.branchId, name: n.branchName } : null,
      invoice: n.invoiceId ? { id: n.invoiceId, code: n.invoiceCode } : null,
      createdBy: n.createdBy ? { id: n.createdBy, name: n.createdByName } : null,
      creditDate: n.creditDate,
      releaseDate: n.releaseDate,
      currency: n.currency,
      subtotal: n.subtotal,
      totalDiscount: n.totalDiscount,
      shippingCost: n.shippingCost,
      shippingTax: n.shippingTax,
      totalTax: n.totalTax,
      grandTotal: n.grandTotal,
      status: n.status,
      statusLabel: n.status !== null ? CREDIT_NOTE_STATUS_LABELS[n.status] ?? null : null,
      cancelled: n.status === 0 || n.status === 5,
      createdAt: n.createdAt,
    };
  }

  async list(userId: number, meta: RequestMeta, q: CreditNoteListQuery) {
    const ctx = await this.load(userId, meta, CREDIT_NOTE_PERMISSIONS.view);
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;
    const { start, end } = await this.invoiceQueries.range(ctx, q.fromDate, q.toDate);
    const { rows, total } = await this.notes.page(
      {
        scope: await ctx.documentScope(),
        headerBranchIds: await ctx.headerBranchIds(),
        clientId: q.clientId,
        number: q.number?.trim() || undefined,
        status: q.status,
        branchIds: q.branch ? (ctx.tree.find(q.branch) ? ctx.tree.subtree(q.branch) : [q.branch]) : undefined,
        start,
        end,
      },
      page,
      perPage,
    );
    return { items: rows.map((r) => this.summary(r)), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)), range: { from: start, to: end } };
  }
}
