import { Request, Response } from 'express';
import { z } from 'zod';
import { CollectionsReportUseCases } from '../../../../application/use-cases/sales/CollectionsReportUseCases';
import { DailyClosingUseCases } from '../../../../application/use-cases/sales/DailyClosingUseCases';
import { MyPerformanceUseCases } from '../../../../application/use-cases/sales/MyPerformanceUseCases';
import { REP_PERIODS, REP_SORTS, RepsPerformanceUseCases } from '../../../../application/use-cases/sales/RepsPerformanceUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok, okMessage } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery } from '../clients/ClientsController';
import { salesMeta } from './SalesInvoicesController';

const id = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
const range = z.object({ fromDate: calendarDate.optional(), toDate: calendarDate.optional() });
const closingList = z.object({ page: id.optional(), employeeId: id.optional(), fromDate: calendarDate.optional(), toDate: calendarDate.optional() });
const reportSchema = z.object({
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
  employeeId: id.optional(),
  clientId: id.optional(),
  groupBy: z.enum(['employee', 'day', 'month', 'client', 'treasury'], { message: 'التجميع: employee أو day أو month أو client أو treasury.' }).optional(),
  view: z.enum(['summary', 'details'], { message: 'العرض summary أو details.' }).optional(),
});
const langOf = (req: Request): 'ar' | 'en' => (String(req.headers['accept-language'] ?? 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar');
const repsSchema = z.object({
  period: z.enum(REP_PERIODS, { message: 'الفترة غير معروفة.' }).optional(),
  sort: z.enum(REP_SORTS, { message: 'الترتيب غير معروف.' }).optional(),
  fromDate: calendarDate.optional(),
  toDate: calendarDate.optional(),
  branchId: id.optional(),
});
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** الإقفال اليومي، وأهدافي وعمولاتي، وتقرير المدفوعات حسب الموظف */
export class SalesSelfServiceController {
  constructor(
    private readonly closing: DailyClosingUseCases,
    private readonly performance: MyPerformanceUseCases,
    private readonly reports: CollectionsReportUseCases,
    private readonly reps: RepsPerformanceUseCases,
  ) {}

  closings = async (req: Request, res: Response) => {
    ok(res, await this.closing.list(currentUserId(req), salesMeta(req, 'daily-closing.index'), parseQuery(closingList, req.query)));
  };

  closingShow = async (req: Request, res: Response) => {
    ok(res, await this.closing.show(currentUserId(req), salesMeta(req, 'daily-closing.show'), idParam(req, 'id')));
  };

  systemData = async (req: Request, res: Response) => {
    ok(res, await this.closing.systemData(currentUserId(req), salesMeta(req, 'daily-closing.system-data'), req.query.date));
  };

  stockProducts = async (req: Request, res: Response) => {
    ok(res, await this.closing.stockProducts(currentUserId(req), salesMeta(req, 'daily-closing.stock-products'), req.query.date));
  };

  closingStore = async (req: Request, res: Response) => {
    const r = await this.closing.store(currentUserId(req), salesMeta(req, 'daily-closing.store'), body(req));
    okMessage(res, r.data, r.message, 201);
  };

  closingAuto = async (req: Request, res: Response) => {
    const r = await this.closing.autoStore(currentUserId(req), salesMeta(req, 'daily-closing.auto-store'), body(req));
    okMessage(res, r.data, r.message, 201);
  };

  myTargets = async (req: Request, res: Response) => {
    ok(res, await this.performance.targets(currentUserId(req), salesMeta(req, 'my.targets'), parseQuery(range, req.query)));
  };

  myCommissions = async (req: Request, res: Response) => {
    ok(res, await this.performance.commissions(currentUserId(req), salesMeta(req, 'my.commissions')));
  };

  repsPerformance = async (req: Request, res: Response) => {
    ok(res, await this.reps.report(currentUserId(req), salesMeta(req, 'reps-performance'), parseQuery(repsSchema, req.query), langOf(req)));
  };

  paymentsByEmployee = async (req: Request, res: Response) => {
    ok(res, await this.reports.report(currentUserId(req), salesMeta(req, 'reports.payments-by-employee'), parseQuery(reportSchema, req.query)));
  };
}
