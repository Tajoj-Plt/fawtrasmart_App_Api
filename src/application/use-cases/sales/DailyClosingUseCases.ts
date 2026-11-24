import { AppError } from '../../../domain/errors/AppError';
import { OperationLogRepository } from '../../../domain/repositories/clients';
import { parseInputDate, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { fmtMoney, round2 } from '../../../domain/services/sales/SalesMath';
import { ClosingStockProduct, DailyClosingRepository } from '../../../domain/repositories/sales';
import { UnitOfWork } from '../../ports';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { SalesContext, SalesContextFactory } from '../../services/sales/SalesContext';
import { AccountingPeriodGuard } from '../../services/stock/AccountingPeriodGuard';

const LOG_MODULE = 'DailyClosing';
/** ميزتا الباقة — `plan:dashboard|reports` */
const PLAN = ['dashboard', 'reports'];
const P = {
  view: 'sales.daily_closing.view',
  viewAll: 'sales.daily_closing.view_all',
  create: 'sales.daily_closing.create',
  review: 'sales.daily_closing.review',
  autoClose: 'sales.daily_closing.auto_close',
};
/** `SystemAccountIds` — احتياط حين لا يُضبط الحساب في «الحسابات المحاسبية» */
const FALLBACK = { sales: 44, salesReturns: 45, mainTreasury: 14, cashParent: 13, bankParent: 15 };

const LABELS: Record<string, string> = {
  sales: 'إجمالي المبيعات',
  cash_sales: 'المباع نقداً',
  receipts: 'سندات القبض',
  returns: 'المرتجعات',
  cash_refunds: 'المرتجع النقدي',
  expenses: 'المصروفات',
};

export interface SystemTotals {
  sales: number;
  cashSales: number;
  receipts: number;
  cashRefunds: number;
  collections: number;
  returns: number;
  expenses: number;
  stockTotal: number;
  stockProducts: ClosingStockProduct[];
  visits: unknown;
}

const qty = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * الإقفال اليومي للمندوب — `DailyClosingController` و`DailyClosingLedger`:
 * أرقام النظام ليومه، والإقفال اليدويّ (يطابق ما أدخله بها) والتلقائيّ.
 * والإقفال مرّةً واحدة لليوم حتى مع إعادة المحاولة المتزامنة (الويب يفحص خارج المعاملة).
 */
export class DailyClosingUseCases {
  constructor(
    private readonly contexts: SalesContextFactory,
    private readonly repo: DailyClosingRepository,
    private readonly periodGuard: AccountingPeriodGuard,
    private readonly logs: OperationLogRepository,
    private readonly uow: UnitOfWork,
  ) {}

  private load(userId: number, meta: RequestMeta, permission: string | string[]) {
    return this.contexts.load(userId, meta, { planFeatures: PLAN, permissions: [permission] });
  }

  private dateOf(form: FormInput, errors: FieldErrors, required = true) {
    const text = form.string('date');
    if (text === null) {
      if (required) errors.add('date', 'التاريخ مطلوب.');
      return null;
    }
    const d = parseInputDate(text);
    if (!d) {
      errors.add('date', 'التاريخ بصيغة YYYY-MM-DD.');
      return null;
    }
    return toSqlDate(d);
  }

  // ═══════════════════════ أرقام النظام ═══════════════════════

  async systemTotals(ctx: SalesContext, date: string): Promise<SystemTotals> {
    const userId = ctx.user.id;
    const from = `${date} 00:00:00`;
    const to = `${date} 23:59:59`;
    const [salesAcc, returnsAcc, mainTreasury, cashParent, bankParent] = await Promise.all([
      this.repo.accountId('sales', FALLBACK.sales),
      this.repo.accountId('sales_returns', FALLBACK.salesReturns),
      this.repo.accountId('main_treasury', FALLBACK.mainTreasury),
      this.repo.accountId('cash_treasuries_parent', FALLBACK.cashParent),
      this.repo.accountId('bank_accounts_parent', FALLBACK.bankParent),
    ]);

    const sales = await this.repo.grossSales(userId, from, to, salesAcc);
    const cashInvoices = await this.repo.cashSaleInvoices(userId, date);
    const settled = await this.repo.nonCashSettlements(cashInvoices.map((i) => i.id));
    const cashSales = cashInvoices.reduce((s, i) => s + Math.max(0, i.grandTotal - (settled.get(i.id) ?? 0)), 0);
    const receipts = await this.repo.receipts(userId, from, to);
    const cashRefunds = await this.repo.cashRefunds(userId, date);
    const returns = await this.repo.returns(userId, from, to);

    // المصروفات — من خزينة الموظّف كلُّ ما خرج منها، ومن الرئيسية سنداتُ صرفه هو
    let expenses = 0;
    const hrEmployee = await this.repo.userEmployeeId(userId);
    if (hrEmployee) {
      const treasuryAndBank = await this.repo.treasuryAndBankAccountIds(cashParent, bankParent);
      const cancelled = await this.repo.cancelledExpenseRefs();
      const own = await this.repo.employeeTreasuryId(hrEmployee);
      const fromMain = await this.repo.expenseEntryIds(userId, from, to, mainTreasury, cancelled, true, treasuryAndBank, returnsAcc);
      expenses = await this.repo.creditSum(fromMain, mainTreasury);
      if (own !== null && own !== mainTreasury) {
        const fromOwn = await this.repo.expenseEntryIds(userId, from, to, own, cancelled, false, treasuryAndBank, returnsAcc);
        expenses += await this.repo.creditSum(fromOwn, own);
      }
    }

    const stockProducts = hrEmployee ? await this.repo.stockProducts(hrEmployee) : [];
    return {
      sales: round2(sales),
      cashSales: round2(cashSales),
      receipts: round2(receipts),
      cashRefunds: round2(cashRefunds),
      collections: round2(cashSales + receipts - cashRefunds),
      returns: round2(returns),
      expenses: round2(expenses),
      stockTotal: round2(stockProducts.reduce((s, p) => s + p.systemQuantity, 0)),
      stockProducts,
      visits: await this.visits(ctx, date),
    };
  }

  /** `DailyClosingLedger::visits()` — خطّ سير اليوم مع زيارات مساحة العمل */
  private async visits(ctx: SalesContext, date: string) {
    const userId = ctx.user.id;
    const rows = await this.repo.itineraryRows(userId, date);
    const workspace = await this.repo.workspaceVisits(userId, date, ctx.nowSql);
    const names = await this.repo.clientNames([...new Set([...rows.map((r) => r.clientId), ...workspace.keys()])]);
    const served = await this.repo.servedClientIds(userId, date);
    const label = (m: number) => (m < 60 ? `${m} د` : `${Math.floor(m / 60)} س${m % 60 ? ` ${m % 60} د` : ''}`);
    const outcome = (minutes: number | null, ws: string | null, isServed: boolean) => {
      const o = ws === 'success' ? 'success' : ws === 'failed' ? 'negative' : isServed ? 'success' : 'negative';
      return { durationMinutes: minutes, duration: minutes !== null ? label(minutes) : null, outcome: o, outcomeLabel: o === 'success' ? 'ناجحة' : 'سلبية' };
    };
    const time = (v: string | null) => (v ? v.slice(11, 16) : null);
    const completed = new Map<number, Record<string, unknown>>();
    const missed = new Map<number, Record<string, unknown>>();
    const name = (id: number) => names.get(id)?.name ?? `#${id}`;

    for (const r of rows) {
      const state = r.visitStatus === 'completed' || (r.visitStatus === null && r.status === 'active') ? 'completed' : r.visitStatus === 'cancelled' ? null : 'missed';
      if (state === null) continue;
      const list = state === 'completed' ? completed : missed;
      if (list.has(r.clientId)) continue;
      const entry: Record<string, unknown> = { client: name(r.clientId), code: names.get(r.clientId)?.code ?? null, time: null, note: state === 'missed' ? r.missedReason : null, unplanned: false };
      if (state === 'completed') {
        const ws = workspace.get(r.clientId);
        let minutes = r.minutes ?? ws?.minutes ?? null;
        if (minutes === null && r.startedAt && r.completedAt) minutes = Math.floor(Math.abs(new Date(r.completedAt.replace(' ', 'T')).getTime() - new Date(r.startedAt.replace(' ', 'T')).getTime()) / 60000);
        Object.assign(entry, outcome(minutes, ws?.outcome ?? null, served.has(r.clientId)), { time: time(ws?.endedAt ?? r.completedAt), startTime: time(ws?.startedAt ?? r.startedAt), _start: ws?.startedAt ?? r.startedAt });
      }
      list.set(r.clientId, entry);
    }
    for (const [clientId, ws] of workspace) {
      if (completed.has(clientId) || !ws.endedAt) continue;
      completed.set(clientId, { client: name(clientId), code: names.get(clientId)?.code ?? null, time: time(ws.endedAt), startTime: time(ws.startedAt), note: null, unplanned: !missed.has(clientId), _start: ws.startedAt, ...outcome(ws.minutes, ws.outcome, served.has(clientId)) });
      missed.delete(clientId);
    }
    const done = [...completed.values()].sort((a, b) => {
      const x = a._start as string | null;
      const y = b._start as string | null;
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    done.forEach((d) => delete d._start);
    const missing = [...missed.entries()].filter(([id]) => !completed.has(id)).map(([, v]) => v);
    const total = done.reduce((s, v) => s + Number(v.durationMinutes ?? 0), 0);
    return {
      completed: done,
      missed: missing,
      completedCount: done.length,
      missedCount: missing.length,
      successCount: done.filter((v) => v.outcome === 'success').length,
      negativeCount: done.filter((v) => v.outcome === 'negative').length,
      totalMinutes: total,
      totalDuration: total > 0 ? label(total) : null,
    };
  }

  async systemData(userId: number, meta: RequestMeta, dateText: unknown) {
    const ctx = await this.load(userId, meta, P.review);
    const errors = new FieldErrors();
    const date = this.dateOf(new FormInput({ date: dateText }, errors), errors) as string;
    errors.throwIfAny();
    if (await this.repo.existing(ctx.user.id, date)) throw new AppError('ALREADY_CLOSED', `تمّ الإقفال لهذا اليوم (${date}) مسبقاً`, 422);
    return this.systemTotals(ctx, date);
  }

  async stockProducts(userId: number, meta: RequestMeta, dateText: unknown) {
    const ctx = await this.load(userId, meta, P.create);
    const errors = new FieldErrors();
    const date = this.dateOf(new FormInput({ date: dateText }, errors), errors, false) ?? ctx.today;
    errors.throwIfAny();
    const hr = await this.repo.userEmployeeId(ctx.user.id);
    const products = hr ? await this.repo.stockProducts(hr) : [];
    return { products, total: round2(products.reduce((s, p) => s + p.systemQuantity, 0)), visits: await this.visits(ctx, date) };
  }

  // ═══════════════════════ الإقفال ═══════════════════════

  private columns(system: SystemTotals, reported: Record<string, number>, note: string, userId: number, date: string) {
    return {
      employee_id: userId,
      date,
      reported_sales: reported.sales,
      reported_cash_sales: reported.cash_sales,
      reported_receipts: reported.receipts,
      reported_collections: reported.collections,
      reported_returns: reported.returns,
      reported_cash_refunds: reported.cash_refunds,
      reported_expenses: reported.expenses,
      reported_stock_quantity: reported.stock_quantity,
      system_sales: system.sales,
      system_cash_sales: system.cashSales,
      system_receipts: system.receipts,
      system_collections: system.collections,
      system_returns: system.returns,
      system_cash_refunds: system.cashRefunds,
      system_expenses: system.expenses,
      system_stock_quantity: system.stockTotal,
      status: 'success',
      notes: note,
    };
  }

  /** `store()` — يُحفظ الإقفال إن طابق ما أدخله المندوب أرقامَ النظام، وإلا رُدّ بقائمة الفروق */
  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, P.create);
    const errors = new FieldErrors();
    const form = new FormInput(body, errors);
    const date = this.dateOf(form, errors) as string;
    const reported: Record<string, number> = {};
    for (const [key, field] of [['sales', 'reportedSales'], ['cash_sales', 'reportedCashSales'], ['receipts', 'reportedReceipts'], ['returns', 'reportedReturns'], ['expenses', 'reportedExpenses']] as const) {
      reported[key] = form.number(field, { required: true, min: 0, max: 99_999_999.99, message: `${LABELS[key]} مطلوب.` }) ?? 0;
    }
    reported.cash_refunds = form.number('reportedCashRefunds', { min: 0, max: 99_999_999.99 }) ?? 0;
    const list = form.array('stockProducts', { required: true, max: 5000, message: 'حقل المخزون مطلوب (قائمة، ولو فارغة).' }) ?? [];
    const stock: Array<{ productId: number; reported: number }> = [];
    list.forEach((entry, i) => {
      const item = form.child(entry, `stockProducts.${i}`);
      const productId = item.integer('productId', { required: true, min: 1 });
      const q = item.number('reportedQuantity', { required: true, min: 0 });
      if (productId !== null && q !== null) stock.push({ productId, reported: q });
    });
    errors.throwIfAny();

    if (await this.repo.existing(ctx.user.id, date)) throw new AppError('ALREADY_CLOSED', `تمّ الإقفال لهذا اليوم (${date}) مسبقاً`, 422);
    const block = await this.periodGuard.block(date, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `تعذّر الإقفال: ${block}`, 422);

    const system = await this.systemTotals(ctx, date);
    const map: Record<string, number> = { sales: system.sales, cash_sales: system.cashSales, receipts: system.receipts, returns: system.returns, cash_refunds: system.cashRefunds, expenses: system.expenses };
    const mismatches: string[] = [];
    for (const key of Object.keys(map)) {
      if (Math.abs(reported[key] - map[key]) >= 0.01) mismatches.push(`${LABELS[key]} — أدخلت ${fmtMoney(reported[key])} والنظام ${fmtMoney(map[key])}`);
    }
    const bySystem = new Map(system.stockProducts.map((p) => [p.productId, p]));
    for (const s of stock) {
      const sys = bySystem.get(s.productId);
      if (Math.abs(s.reported - (sys?.systemQuantity ?? 0)) >= 0.01) mismatches.push(`المخزون — ${sys?.productName ?? `#${s.productId}`}: أدخلت ${qty(s.reported)} والنظام ${qty(sys?.systemQuantity ?? 0)}`);
    }
    if (mismatches.length) {
      await this.logs.record({ action: 'rejected', module: LOG_MODULE, subjectId: null, description: `رُفض إقفال يوم ${date} لعدم المطابقة`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route, oldValues: reported, newValues: map });
      throw new AppError('CLOSING_MISMATCH', `الإقفال غير مطابق لما سجّله النظام:\n${mismatches.join('\n')}`, 422, { mismatches });
    }

    reported.collections = round2(reported.cash_sales + reported.receipts - reported.cash_refunds);
    reported.stock_quantity = round2(stock.reduce((s, p) => s + p.reported, 0));
    const id = await this.persist(ctx, date, system, reported, 'الإقفال صحيح ومطابق للنظام', stock.map((s) => ({ product_id: s.productId, product_name: bySystem.get(s.productId)?.productName ?? `منتج #${s.productId}`, reported_quantity: s.reported, system_quantity: bySystem.get(s.productId)?.systemQuantity ?? 0 })), 'created');
    return { message: 'تمّ الإقفال اليومي بنجاح — جميع البيانات مطابقة للنظام', data: await this.detail(ctx, id) };
  }

  /** `autoStore()` — الإقفال بأرقام النظام كما هي */
  async autoStore(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.load(userId, meta, [P.autoClose, P.review]);
    const errors = new FieldErrors();
    const date = this.dateOf(new FormInput(body, errors), errors) as string;
    errors.throwIfAny();
    if (await this.repo.existing(ctx.user.id, date)) throw new AppError('ALREADY_CLOSED', `تمّ الإقفال لهذا اليوم (${date}) مسبقاً`, 422);
    const block = await this.periodGuard.block(date, ctx.today, (p) => ctx.can(p));
    if (block) throw new AppError('ACCOUNTING_PERIOD_CLOSED', `تعذّر الإقفال: ${block}`, 422);
    const system = await this.systemTotals(ctx, date);
    const reported = { sales: system.sales, cash_sales: system.cashSales, receipts: system.receipts, collections: system.collections, returns: system.returns, cash_refunds: system.cashRefunds, expenses: system.expenses, stock_quantity: system.stockTotal };
    const id = await this.persist(ctx, date, system, reported, 'إقفال تلقائي من النظام', system.stockProducts.map((p) => ({ product_id: p.productId, product_name: p.productName, reported_quantity: p.systemQuantity, system_quantity: p.systemQuantity })), 'auto_created');
    return { message: 'تمّ الإقفال التلقائي بنجاح', data: await this.detail(ctx, id) };
  }

  private async persist(ctx: SalesContext, date: string, system: SystemTotals, reported: Record<string, number>, note: string, stock: Array<Record<string, unknown>>, action: string) {
    return this.uow.run(async (tx) => {
      await this.repo.lockUser(ctx.user.id, tx);
      if (await this.repo.existing(ctx.user.id, date, tx)) throw new AppError('ALREADY_CLOSED', `تمّ الإقفال لهذا اليوم (${date}) مسبقاً`, 422);
      const id = await this.repo.insert(this.columns(system, reported, note, ctx.user.id, date), stock, ctx.nowSql, tx);
      await this.logs.record({ action: 'created', module: LOG_MODULE, subjectId: id, description: `${action === 'auto_created' ? 'إقفال تلقائي' : 'إقفال يومي'} ليوم ${date} — ${ctx.user.name}`, userId: ctx.user.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, route: ctx.meta.route }, tx);
      return id;
    });
  }

  // ═══════════════════════ القراءة ═══════════════════════

  private async detail(ctx: SalesContext, id: number) {
    const row = await this.repo.find(id);
    if (!row) throw AppError.notFound('CLOSING_NOT_FOUND', 'الإقفال غير موجود.');
    if (row.employeeId !== ctx.user.id && !ctx.can(P.viewAll)) throw AppError.forbidden('CLOSING_FORBIDDEN', 'ليس لديك صلاحية لعرض هذا الإقفال.');
    return { ...row, stock: await this.repo.stockDetails(row.id) };
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.load(userId, meta, P.view);
    return this.detail(ctx, id);
  }

  async list(userId: number, meta: RequestMeta, q: { page?: number; employeeId?: number; fromDate?: string; toDate?: string }) {
    const ctx = await this.load(userId, meta, P.view);
    const seesAll = ctx.can(P.viewAll);
    const page = q.page ?? 1;
    const { rows, total } = await this.repo.page({ employeeId: seesAll ? q.employeeId ?? null : ctx.user.id, fromDate: q.fromDate, toDate: q.toDate }, page, 15);
    return { items: rows, total, page, perPage: 15, lastPage: Math.max(1, Math.ceil(total / 15)), seesAll };
  }
}
