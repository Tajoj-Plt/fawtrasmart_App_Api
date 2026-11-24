import { AppError } from '../../../domain/errors/AppError';
import { ClientsReferenceRepository, DocumentNumberRepository, OperationLogRepository } from '../../../domain/repositories/clients';
import { PayableInvoice, PaymentRow, SalesPaymentRepository, SalesRepository, SalesWriteRepository } from '../../../domain/repositories/sales';
import { LedgerRepository, StockRepository } from '../../../domain/repositories/stock';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { fmtMoney, round2 } from '../../../domain/services/sales/SalesMath';
import { PAYMENT_STATUS, RECEIPT_STATUS_LABELS, SALES_LIMITS, SALES_PAYMENT_LOG_MODULE, SALES_PERMISSIONS, SALES_PLAN, SALES_REFERENCE, SALES_SECTIONS } from '../../../domain/services/sales/SalesConstants';
import { Tx, UnitOfWork } from '../../ports';
import { LedgerAccounts } from '../../services/accounting/LedgerAccounts';
import { PlanLimitGuard } from '../../services/access/PlanLimitGuard';
import { NotificationGate } from '../../services/clients/ClientsSupport';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { SalesJournal } from '../../services/sales/SalesJournal';
import { TreasuryGuard } from '../../services/sales/SalesSettings';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';
import { InvoiceQueryUseCases } from './InvoiceQueryUseCases';

const MAX_MONEY = 99_999_999.99;
const PER_PAGE = [10, 25, 50, 100];

export interface PaymentListQuery {
  page?: number;
  perPage?: number;
  clientId?: number;
  invoiceNumber?: string;
  reference?: string;
  paymentStatus?: number;
  amountFrom?: number;
  amountTo?: number;
  collectedBy?: number;
  treasuryId?: number;
  paymentMethod?: number;
  branch?: number;
  search?: string;
  fromDate?: string;
  toDate?: string;
}

interface Collection {
  invoice: PayableInvoice;
  amount: number;
  remaining: number;
  paidBefore: number;
}

/**
 * سندات القبض على الفواتير — `SalesPaymentController` (`store`، `bulkPaymentStore`،
 * `getClientUnpaidInvoices`، `index`، `show`) بحرّاسٍ واحدة للفردي والجماعي.
 */
export class PaymentUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly payments: SalesPaymentRepository,
    private readonly sales: SalesRepository,
    private readonly writes: SalesWriteRepository,
    private readonly stock: StockRepository,
    private readonly ledger: LedgerRepository,
    private readonly accounts: LedgerAccounts,
    private readonly journal: SalesJournal,
    private readonly treasuries: TreasuryGuard,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly planLimits: PlanLimitGuard,
    private readonly numbers: DocumentNumberRepository,
    private readonly notifications: NotificationGate,
    private readonly logs: OperationLogRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly invoiceQueries: InvoiceQueryUseCases,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string) {
    return this.contexts.load(userId, meta, { planFeatures: [SALES_PLAN.payments], permissions: [permission] });
  }

  // ═══════════════════════ النطاق ═══════════════════════

  /** «عملائي المُسنَدون» يحصر السندات بعملاء موظّفه — وإلا نطاق المستندات */
  private assignedOnly(ctx: SalesContext) {
    return !ctx.seesAll && ctx.can(SALES_PERMISSIONS.paymentsViewAssignedClients) && Boolean(ctx.user.employeeId);
  }

  /** الوصول إلى فاتورةٍ للتحصيل عليها — `store()`: نطاقها، أو عميلٌ مُسنَدٌ إليه */
  private async canCollectOn(ctx: SalesContext, invoice: PayableInvoice) {
    if (await ctx.canAccessDocument(invoice.createdBy, invoice.employeeId, invoice.branchId)) return true;
    return ctx.can(SALES_PERMISSIONS.paymentsViewAssignedClients) && Boolean(ctx.user.employeeId) && invoice.clientId !== null && (await this.payments.clientAssignedTo(ctx.user.employeeId as number, invoice.clientId));
  }

  /** الوصول إلى سند — القاعدة نفسها التي تبني القائمة (الويب يعرض في القائمة ما يرفضه في العرض) */
  private async canSee(ctx: SalesContext, p: PaymentRow) {
    if (ctx.seesAll) return true;
    if (this.assignedOnly(ctx)) return p.clientId !== null && (await this.payments.clientAssignedTo(ctx.user.employeeId as number, p.clientId));
    const users = await ctx.documentUserIds();
    if (users === null) return true;
    if (p.collectorId !== null && users.includes(p.collectorId)) return true;
    return p.invoiceId !== null && (await ctx.canAccessDocument(p.invoiceCreatedBy, p.invoiceEmployeeId, p.invoiceBranchId));
  }

  /** ما يمنع التحصيل على الفاتورة — `null` إن جاز */
  private blockReason(invoice: PayableInvoice, flags: { returned: Set<number>; credited: Set<number>; installments: Set<number> }): string | null {
    const code = invoice.code ?? `#${invoice.id}`;
    if (invoice.type === 'returned') return `المستند ${code} مرتجعٌ لا فاتورة بيع — لا يُحصَّل عليه.`;
    if (invoice.voidedAt) return `الفاتورة ${code} ملغاة — لا تقبل تحصيلاً.`;
    if (flags.returned.has(invoice.id)) return `الفاتورة ${code} لها مرتجع، فلا تقبل تحصيلاً. المرتجع يعكس البيع ويردّ البضاعة، وقبضُ دفعةٍ عليه يقبض ثمن ما رُدّ.`;
    if (flags.credited.has(invoice.id)) return `صدر للفاتورة ${code} إشعارٌ دائن — يُعدّ مرتجعاً، فلا تقبل تحصيلاً.`;
    if (flags.installments.has(invoice.id)) return `الفاتورة ${code} مقسَّطة — تُحصَّل أقساطها من «إدارة الأقساط» في النظام.`;
    return null;
  }

  private async flagsFor(ids: number[]) {
    const [returned, credited, installments] = await Promise.all([this.sales.returnedInvoiceIds(ids), this.sales.activeCreditNoteInvoiceIds(ids), this.payments.installmentInvoiceIds(ids)]);
    return { returned, credited, installments };
  }

  /**
   * المتبقّي للتحصيل: الإجمالي − المقبوض بالسندات − المسدَّد من المحفظة،
   * ولا يتجاوز `due_value` (ما سُوِّي من رصيد العميل الدائن لا سند له).
   * الويب يطرح السندات وحدها فيقبل قبضَ ما سُدِّد من المحفظة مرّةً ثانية.
   */
  private remainingOf(invoice: PayableInvoice, paidBefore: number) {
    return round2(Math.max(0, this.grossRemaining(invoice, paidBefore) - invoice.returnedPayment));
  }

  /** قبل طرح ما سوّاه إشعارٌ دائن — به يُكتب `due_value` (المستحقّ الفعليّ = `due_value − returned_payment`) */
  private grossRemaining(invoice: PayableInvoice, paidBefore: number) {
    return round2(Math.max(0, Math.min(invoice.grandTotal - paidBefore - invoice.walletPaidAmount, invoice.dueValue)));
  }

  // ═══════════════════════ القراءة ═══════════════════════

  async createData(userId: number, meta: RequestMeta) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsCreate);
    const [treasuries, methods, nextNumber, periodBlock] = await Promise.all([
      this.treasuries.depositable(ctx),
      this.sales.paymentMethods(),
      this.numbers.peek(SALES_SECTIONS.payment, ctx.now),
      this.periodGuard.block(ctx.today, ctx.today, (p) => ctx.can(p)),
    ]);
    const own = ctx.user.employeeId ? await this.sales.employeeTreasuryAccountIds(ctx.user.employeeId) : [];
    return {
      treasuries: treasuries.map((t) => ({ id: t.accountId, name: t.name, isOwn: own.includes(t.accountId as number) })),
      defaultTreasuryId: own.find((id) => treasuries.some((t) => t.accountId === id)) ?? null,
      paymentMethods: methods,
      nextNumber,
      periodBlock,
      canBulk: ctx.can(SALES_PERMISSIONS.paymentsBulk),
    };
  }

  /** `getClientUnpaidInvoices()` — مستحقّات العميل في نطاقي، الأقدم أوّلاً */
  async unpaid(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsView);
    if (!(await this.sales.client(clientId))) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await ctx.assertClient(clientId);

    const ids = await this.payments.unpaidInvoiceIds(clientId, await ctx.documentScope(), await ctx.headerBranchIds());
    const [rows, paid, flags] = await Promise.all([this.payments.invoices(ids), this.payments.paidTotals(ids), this.flagsFor(ids)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const invoices = ids
      .map((id) => byId.get(id))
      .filter((r): r is PayableInvoice => Boolean(r))
      .map((r) => {
        const block = this.blockReason(r, flags);
        return {
          id: r.id,
          code: r.code,
          invoiceDate: r.invoiceDate,
          grandTotal: round2(r.grandTotal),
          paid: round2((paid.get(r.id) ?? 0) + r.walletPaidAmount),
          dueValue: round2(r.dueValue),
          remaining: this.remainingOf(r, paid.get(r.id) ?? 0),
          paymentStatus: r.paymentStatus,
          paymentStatusLabel: r.paymentStatus ? RECEIPT_STATUS_LABELS[r.paymentStatus] ?? null : null,
          partialAllowed: !r.disablePartialPayment,
          collectible: block === null,
          blockReason: block,
        };
      });
    return { invoices, totalDue: round2(invoices.filter((i) => i.collectible).reduce((s, i) => s + i.remaining, 0)) };
  }

  async list(userId: number, meta: RequestMeta, q: PaymentListQuery) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsView);
    const perPage = PER_PAGE.includes(q.perPage ?? 10) ? q.perPage ?? 10 : 10;
    const page = q.page ?? 1;
    const { start, end } = await this.invoiceQueries.range(ctx, q.fromDate, q.toDate);
    const assigned = this.assignedOnly(ctx);

    const { rows, total, sum } = await this.payments.page(
      {
        scope: assigned ? { branchIds: null, userIds: null, employeeIds: null } : await ctx.documentScope(),
        collectorIds: assigned || ctx.seesAll ? null : await ctx.documentUserIds(),
        assignedEmployeeId: assigned ? (ctx.user.employeeId as number) : null,
        headerBranchIds: await ctx.headerBranchIds(),
        clientId: q.clientId,
        invoiceNumber: q.invoiceNumber?.trim() || undefined,
        reference: q.reference?.trim() || undefined,
        paymentStatus: q.paymentStatus,
        amountFrom: q.amountFrom,
        amountTo: q.amountTo,
        collectedBy: q.collectedBy,
        treasuryId: q.treasuryId,
        paymentMethod: q.paymentMethod,
        branchIds: q.branch ? (ctx.tree.find(q.branch) ? ctx.tree.subtree(q.branch) : [q.branch]) : undefined,
        search: q.search?.trim() || undefined,
        start,
        end,
      },
      page,
      perPage,
    );
    return { items: rows.map((r) => this.present(r)), total, totalAmount: round2(sum), page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)), range: { from: start, to: end } };
  }

  private present(p: PaymentRow) {
    return {
      id: p.id,
      number: p.referenceNumber,
      invoice: p.invoiceId ? { id: p.invoiceId, code: p.invoiceCode } : null,
      client: p.clientId ? { id: p.clientId, tradeName: p.clientName } : null,
      branch: p.branchId ? { id: p.branchId, name: p.branchName } : null,
      treasury: p.treasuryId ? { id: p.treasuryId, name: p.treasuryName } : null,
      amount: round2(p.amount),
      currency: p.currency,
      paymentDate: p.paymentDate,
      paymentMethod: p.paymentMethod ? { id: p.paymentMethod, name: p.paymentMethodName } : null,
      paymentStatus: p.paymentStatus,
      paymentStatusLabel: p.paymentStatus ? RECEIPT_STATUS_LABELS[p.paymentStatus] ?? null : null,
      collectedBy: p.collectorId ? { id: p.collectorId, name: p.collectorName } : null,
      notes: p.notes,
      createdAt: p.createdAt,
    };
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsView);
    return this.detail(ctx, id);
  }

  private async detail(ctx: SalesContext, id: number) {
    const p = await this.payments.find(id);
    if (!p) throw AppError.notFound('PAYMENT_NOT_FOUND', 'السند غير موجود.');
    if (!(await this.canSee(ctx, p))) throw AppError.forbidden('PAYMENT_FORBIDDEN', 'ليس لديك صلاحية لعرض هذه الدفعة');
    const entry = p.invoiceId ? await this.payments.entryFor(p.invoiceId, p.referenceNumber) : null;
    const invoice = p.invoiceId ? (await this.payments.invoices([p.invoiceId]))[0] ?? null : null;
    const paid = invoice ? (await this.payments.paidTotals([invoice.id])).get(invoice.id) ?? 0 : 0;
    return {
      ...this.present(p),
      invoice: invoice
        ? { id: invoice.id, code: invoice.code, grandTotal: round2(invoice.grandTotal), paid: round2(paid + invoice.walletPaidAmount), dueValue: round2(invoice.dueValue), paymentStatus: invoice.paymentStatus }
        : null,
      journalEntry: entry,
    };
  }

  // ═══════════════════════ التحصيل ═══════════════════════

  private parseCommon(form: FormInput, errors: FieldErrors, today: string) {
    const dateText = form.string('paymentDate');
    let paymentDate = today;
    if (dateText !== null) {
      const d = parseInputDate(dateText);
      if (!d) errors.add('paymentDate', 'التاريخ بصيغة YYYY-MM-DD.');
      else paymentDate = toSqlDate(d);
    }
    return {
      paymentDate,
      treasuryId: form.integer('treasuryId', { min: 1 }),
      paymentMethod: form.integer('paymentMethod', { min: 1 }),
      notes: form.string('notes', { max: 5000 }),
    };
  }

  private parseAmount(form: FormInput, errors: FieldErrors, key: string) {
    const amount = form.number(key, { required: true, message: 'المبلغ مطلوب.' });
    if (amount === null) return 0;
    if (amount <= 0) errors.add(key, 'المبلغ يجب أن يكون أكبر من صفر.');
    else if (amount > MAX_MONEY) errors.add(key, 'المبلغ أكبر من المسموح.');
    return round2(amount);
  }

  /** الخزينة: المختارة إن سُمح له بالإيداع فيها، ثمّ خزينة الموظّف، ثمّ «الخزينة الرئيسية» */
  private async treasury(ctx: SalesContext, requested: number | null, tx: Tx) {
    if (requested) {
      if (!(await this.ledger.account(requested, tx))) throw AppError.validation({ treasuryId: ['الخزينة المختارة غير موجودة.'] }, 'الخزينة المختارة غير موجودة.');
      const denied = await this.treasuries.depositBlock(ctx, requested);
      if (denied) throw AppError.forbidden('TREASURY_FORBIDDEN', denied);
      return requested;
    }
    if (ctx.user.employeeId) {
      const own = (await this.sales.employeeTreasuryAccountIds(ctx.user.employeeId))[0];
      if (own && (await this.ledger.account(own, tx))) return own;
    }
    return (await this.accounts.require('main_treasury', null, tx)).id;
  }

  private async notify(input: Parameters<NotificationGate['send']>[0], now: Date, tx?: Tx) {
    try {
      await this.notifications.send(input, now, tx);
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'PLAN_LIMIT_REACHED')) throw e;
    }
  }

  /**
   * سندٌ واحد على فاتورة واحدة — داخل معاملة الطالب، والفاتورة مقفلة:
   * السند، والفاتورة (المقدَّم والحالة والمستحقّ)، وقيد التحصيل بتاريخ السند.
   */
  private async collect(ctx: SalesContext, c: Collection, common: { paymentDate: string; paymentMethod: number | null; notes: string | null; treasuryId: number }, clientAccountId: number, owner: { branchId: number | null; employeeId: number | null }, noteSuffix: string, tx: Tx) {
    const now = ctx.nowSql;
    const invoice = c.invoice;
    const number = await this.numbers.next(SALES_SECTIONS.payment, ctx.now, tx);
    const settles = c.amount >= c.remaining - 0.009;
    const status = settles ? PAYMENT_STATUS.paid : PAYMENT_STATUS.partial;
    const due = settles ? 0 : round2(this.grossRemaining(invoice, c.paidBefore) - c.amount);
    const currency = invoice.currency || (await this.reference.defaultCurrency())?.code || 'SAR';

    const paymentId = await this.writes.insertPayment(
      {
        invoice_id: invoice.id,
        client_id: invoice.clientId,
        branch_id: invoice.branchId ?? ctx.user.branchId ?? null,
        treasury_id: common.treasuryId,
        amount: c.amount,
        payment_date: `${common.paymentDate} ${now.slice(11, 19)}`,
        Payment_method: common.paymentMethod ?? (await this.sales.defaultReceiptPaymentMethod()),
        reference_number: number,
        notes: (common.notes ?? '') + noteSuffix || null,
        type: 'client payments',
        payment_status: status,
        employee_id: ctx.user.id,
        accounting_period_id: (await this.stock.accountingPeriodFor(common.paymentDate))?.id ?? null,
      },
      now,
      tx,
    );

    await this.writes.updateInvoice(invoice.id, { advance_payment: round2(c.paidBefore + c.amount), payment_status: status, is_paid: settles ? 1 : 0, due_value: due }, now, tx);

    await this.journal.post(
      ctx,
      { reference: number, referenceType: SALES_REFERENCE.collection, description: `دفعة للفاتورة رقم ${invoice.code ?? invoice.id}`, clientId: invoice.clientId, invoiceId: invoice.id, currency, date: common.paymentDate },
      [
        { accountId: common.treasuryId, description: 'استلام دفعة نقدية', debit: c.amount, credit: 0 },
        { accountId: clientAccountId, description: 'دفعة من العميل', debit: 0, credit: c.amount },
      ],
      owner,
      now,
      tx,
    );

    await this.logs.record(
      {
        action: 'created',
        module: SALES_PAYMENT_LOG_MODULE,
        subjectId: paymentId,
        description: `${noteSuffix ? 'دفعة مجمَّعة' : 'تسجيل دفعة'} على الفاتورة **${invoice.code ?? invoice.id}** — العميل: ${invoice.clientName ?? '—'} — المبلغ: ${fmtMoney(c.amount)} ${currency}`,
        userId: ctx.user.id,
        ip: ctx.meta.ip,
        userAgent: ctx.meta.userAgent,
        route: ctx.meta.route,
      },
      tx,
    );

    return { paymentId, number, status, due };
  }

  /** `store()` — سندٌ على فاتورة */
  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsCreate);
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const invoiceId = form.integer('invoiceId', { required: true, min: 1, message: 'اختر الفاتورة.' });
    const amount = this.parseAmount(form, errors, 'amount');
    const common = this.parseCommon(form, errors, ctx.today);
    errors.throwIfAny();

    const block = await this.periodGuard.block(common.paymentDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);
    await this.planLimits.assert(SALES_LIMITS.payments, ctx.now);

    const [invoice] = await this.payments.invoices([invoiceId as number]);
    if (!invoice) throw AppError.notFound('INVOICE_NOT_FOUND', 'الفاتورة غير موجودة.');
    if (!(await this.canCollectOn(ctx, invoice))) throw AppError.forbidden('PAYMENT_FORBIDDEN', 'ليس لديك صلاحية لإضافة مدفوعات لهذا العميل');
    const reason = this.blockReason(invoice, await this.flagsFor([invoice.id]));
    if (reason) throw new AppError('INVOICE_NOT_COLLECTIBLE', reason, 422);

    const clientAccount = invoice.clientId ? await this.sales.clientLedgerAccount(invoice.clientId) : null;
    if (!clientAccount) throw new AppError('CLIENT_ACCOUNT_MISSING', `لا حساب محاسبيّ للعميل «${invoice.clientName ?? '—'}» — يُنشأ من شاشة العميل قبل تحصيل دفعةٍ منه.`, 422);

    const result = await this.uow.run(async (tx) => {
      await this.planLimits.assert(SALES_LIMITS.payments, ctx.now);
      await this.payments.lockInvoices([invoice.id], tx);
      const [fresh] = await this.payments.invoices([invoice.id], tx);
      const paidBefore = (await this.payments.paidTotals([invoice.id], tx)).get(invoice.id) ?? 0;
      const remaining = this.remainingOf(fresh, paidBefore);

      if (remaining <= 0) throw new AppError('INVOICE_SETTLED', `الفاتورة ${fresh.code ?? fresh.id} مسدَّدة بالكامل — لا متبقّي يُحصَّل.`, 422);
      if (amount - remaining > 0.01) throw AppError.validation({ amount: [`مبلغ الدفع يتجاوز المبلغ المتبقي للفاتورة. المبلغ المتبقي هو: ${fmtMoney(remaining)}`] }, `مبلغ الدفع يتجاوز المبلغ المتبقي للفاتورة. المبلغ المتبقي هو: ${fmtMoney(remaining)}`);
      if (fresh.disablePartialPayment && amount < remaining - 0.01) throw new AppError('PARTIAL_PAYMENT_BLOCKED', `الفاتورة ${fresh.code} لا تقبل السداد الجزئي — تُسدَّد كاملةً: ${fmtMoney(remaining)}`, 422);

      const treasuryId = await this.treasury(ctx, common.treasuryId, tx);
      const owner = await this.journal.owner(ctx);
      const done = await this.collect(ctx, { invoice: fresh, amount, remaining, paidBefore }, { ...common, treasuryId }, clientAccount.id, owner, '', tx);

      await this.notify(
        {
          userId: ctx.user.id,
          receiverId: fresh.createdBy && fresh.createdBy !== ctx.user.id ? fresh.createdBy : null,
          clientId: fresh.clientId,
          type: 'invoice_payment',
          title: `${ctx.user.name} أنشأ عملية دفع`,
          description: `عملية دفع للفاتورة رقم ${fresh.code ?? fresh.id} للعميل ${fresh.clientName ?? '—'} بقيمة ${fmtMoney(amount)} ${(await this.reference.defaultCurrency())?.symbol ?? 'ر.س'}`,
          isSent: true,
        },
        ctx.now,
        tx,
      );
      return done;
    });

    const message = `تم تسجيل عملية الدفع بنجاح. المبلغ المدفوع: ${fmtMoney(amount)}، المبلغ المتبقي: ${fmtMoney(result.due)} - حالة الدفع: ${RECEIPT_STATUS_LABELS[result.status]}`;
    return { message, data: await this.detail(ctx, result.paymentId) };
  }

  /**
   * `bulkPaymentStore()` — مبلغٌ واحد يوزَّع على فواتير العميل المختارة، الأقدم أوّلاً.
   * كلُّ فاتورةٍ بحرّاس السند الفردي، وكلُّ سندٍ برقمه وقيده، والخزينة تُقيَّد
   * بما وُزِّع فعلاً لا بالمبلغ المُدخَل.
   */
  async bulk(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, SALES_PERMISSIONS.paymentsBulk);
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const clientId = form.integer('clientId', { required: true, min: 1, message: 'يرجى اختيار العميل' });
    const total = this.parseAmount(form, errors, 'amount');
    const common = this.parseCommon(form, errors, ctx.today);
    const rawIds = form.array('invoiceIds', { required: true, min: 1, max: 200, message: 'يرجى اختيار فاتورة واحدة على الأقل' }) ?? [];
    const invoiceIds = [...new Set(rawIds.map((v) => Number(v)))];
    if (invoiceIds.some((id) => !Number.isInteger(id) || id < 1)) errors.add('invoiceIds', 'أرقام الفواتير أعدادٌ صحيحة.');
    errors.throwIfAny();

    const client = await this.sales.client(clientId as number);
    if (!client) throw AppError.validation({ clientId: ['العميل المحدَّد غير موجود.'] }, 'العميل المحدَّد غير موجود.');
    await ctx.assertClient(client.id);

    const block = await this.periodGuard.block(common.paymentDate, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', block, 422);

    // كلُّ فاتورةٍ مختارة: موجودةٌ، للعميل نفسه، في النطاق، قابلةٌ للتحصيل
    const found = await this.payments.invoices(invoiceIds);
    const flags = await this.flagsFor(invoiceIds);
    const problems: string[] = [];
    for (const id of invoiceIds) {
      const inv = found.find((f) => f.id === id);
      if (!inv) problems.push(`الفاتورة #${id} غير موجودة.`);
      else if (inv.clientId !== client.id) problems.push(`الفاتورة ${inv.code} ليست لهذا العميل.`);
      else if (!(await this.canCollectOn(ctx, inv))) problems.push(`الفاتورة ${inv.code} خارج نطاقك.`);
      else {
        const reason = this.blockReason(inv, flags);
        if (reason) problems.push(reason);
      }
    }
    if (problems.length) throw new AppError('INVOICES_NOT_COLLECTIBLE', problems.join('\n'), 422, { invoices: problems });

    const clientAccount = await this.sales.clientLedgerAccount(client.id);
    if (!clientAccount) throw new AppError('CLIENT_ACCOUNT_MISSING', `لا حساب محاسبيّ للعميل «${client.tradeName ?? '—'}» — يُنشأ من شاشة العميل قبل تحصيل دفعةٍ منه.`, 422);

    const outcome = await this.uow.run(async (tx) => {
      await this.payments.lockInvoices(invoiceIds, tx);
      const fresh = (await this.payments.invoices(invoiceIds, tx)).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id - b.id);
      const paid = await this.payments.paidTotals(invoiceIds, tx);

      // التوزيع أوّلاً — ثمّ حدّ الباقة بعدد السندات الفعلي
      let left = total;
      const plan: Collection[] = [];
      const skipped: string[] = [];
      for (const inv of fresh) {
        if (left <= 0.004) break;
        const paidBefore = paid.get(inv.id) ?? 0;
        const remaining = this.remainingOf(inv, paidBefore);
        if (remaining <= 0) continue;
        const share = round2(Math.min(left, remaining));
        if (inv.disablePartialPayment && share < remaining - 0.01) {
          skipped.push(`${inv.code} (لا تقبل السداد الجزئي — تُسدَّد كاملةً: ${fmtMoney(remaining)})`);
          continue;
        }
        plan.push({ invoice: inv, amount: share, remaining, paidBefore });
        left = round2(left - share);
      }
      if (!plan.length) throw new AppError('NOTHING_TO_COLLECT', skipped.length ? `لا توجد فواتير مستحقة للدفع بهذا المبلغ: ${skipped.join('، ')}` : 'لا توجد فواتير مستحقة للدفع', 422);

      await this.planLimits.assert(SALES_LIMITS.payments, ctx.now, plan.length);
      const treasuryId = await this.treasury(ctx, common.treasuryId, tx);
      const owner = await this.journal.owner(ctx);

      const done: Array<{ code: string | null; paid: number; status: number; paymentId: number; number: string }> = [];
      for (const c of plan) {
        const r = await this.collect(ctx, c, { ...common, treasuryId }, clientAccount.id, owner, ' [دفع مجمع]', tx);
        done.push({ code: c.invoice.code, paid: c.amount, status: r.status, paymentId: r.paymentId, number: r.number });
      }
      const distributed = round2(done.reduce((s, d) => s + d.paid, 0));

      await this.notify(
        {
          userId: ctx.user.id,
          receiverId: null,
          clientId: client.id,
          type: 'bulk_payment',
          title: `${ctx.user.name} أنشأ دفعة مجمعة`,
          description: `دفعة مجمعة للعميل ${client.tradeName ?? ''} بقيمة ${fmtMoney(distributed)} ${(await this.reference.defaultCurrency())?.symbol ?? 'ر.س'} لعدد ${done.length} فواتير`,
          isSent: true,
        },
        ctx.now,
        tx,
      );
      return { done, distributed, left, skipped };
    });

    const summary = outcome.done.map((d) => `${d.code} (${fmtMoney(d.paid)} - ${RECEIPT_STATUS_LABELS[d.status]})`).join('، ');
    const message =
      `تم تسجيل الدفعة المجمعة بنجاح! المبلغ الموزَّع: ${fmtMoney(outcome.distributed)} - الفواتير: ${summary}` +
      (outcome.left > 0.004 ? ` - المبلغ المتبقي غير المستخدم: ${fmtMoney(outcome.left)}` : '') +
      (outcome.skipped.length ? ` - تُخطّيت: ${outcome.skipped.join('، ')}` : '');
    return {
      message,
      data: {
        distributed: outcome.distributed,
        unused: round2(outcome.left),
        payments: outcome.done.map((d) => ({ id: d.paymentId, number: d.number, invoiceCode: d.code, amount: d.paid, paymentStatus: d.status, paymentStatusLabel: RECEIPT_STATUS_LABELS[d.status] })),
        skipped: outcome.skipped,
      },
    };
  }
}
