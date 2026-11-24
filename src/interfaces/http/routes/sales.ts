import { Request, RequestHandler, Response, Router } from 'express';
import { Container } from '../../../container';
import { SalesSelfServiceController } from '../controllers/sales/SalesSelfServiceController';
import { SalesQuotesController } from '../controllers/sales/SalesQuotesController';
import { SalesExchangesController } from '../controllers/sales/SalesExchangesController';
import { upload } from './clients';
import { SalesCreditNotesController } from '../controllers/sales/SalesCreditNotesController';
import { SalesReturnsController } from '../controllers/sales/SalesReturnsController';
import { SalesPaymentsController } from '../controllers/sales/SalesPaymentsController';
import { SalesInvoicesController } from '../controllers/sales/SalesInvoicesController';
import { SalesPrintController } from '../controllers/sales/SalesPrintController';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => fn(req, res).catch(next);

/**
 * المبيعات — `/api/v1/sales/...`.
 * الاشتراك ومفتاح «إدارة المبيعات» وميزة الباقة والصلاحية ونطاق المستندات
 * والعملاء والمستودعات تُفحص في طبقة التطبيق (`SalesContextFactory`).
 */
export function salesRoutes(c: Container, auth: RequestHandler): Router {
  const router = Router();
  const invoices = new SalesInvoicesController(c.useCases.salesSetup, c.useCases.salesInvoiceQueries, c.useCases.salesInvoiceCreate);

  // ---- شاشة الفاتورة ----
  router.get('/sales/invoices/create-data', auth, wrap(invoices.createData));
  router.get('/sales/catalog', auth, wrap(invoices.catalog));
  router.get('/sales/price', auth, wrap(invoices.price));
  router.post('/sales/coupons/check', auth, wrap(invoices.checkCoupon));

  // ---- الفواتير ----
  router.get('/sales/business', auth, wrap(invoices.business));
  router.get('/sales/invoices', auth, wrap(invoices.index));
  router.post('/sales/invoices', auth, wrap(invoices.store));
  router.get('/sales/invoices/:id', auth, wrap(invoices.show));
  router.get('/sales/invoices/:id/print', auth, wrap(invoices.print));

  // ---- الطباعة بقوالب الويب (الافتراضيّ من الإعدادات، أو قالب النظام) ----
  const prints = new SalesPrintController(c.useCases.salesPrints);
  // `templates` قبل `:id` — وإلّا طابقه `:id` فرُدّ برقمٍ غير صالح
  router.get('/sales/print/:kind/templates', auth, wrap(prints.templates));
  router.get('/sales/print/:kind/:id', auth, wrap(prints.html));

  // ---- التحصيل ----
  const payments = new SalesPaymentsController(c.useCases.salesPayments);
  router.get('/sales/payments/create-data', auth, wrap(payments.createData));
  router.get('/sales/clients/:id/unpaid-invoices', auth, wrap(payments.unpaid));
  router.get('/sales/payments', auth, wrap(payments.index));
  router.post('/sales/payments', auth, wrap(payments.store));
  router.post('/sales/payments/bulk', auth, wrap(payments.bulk));
  router.get('/sales/payments/:id', auth, wrap(payments.show));

  // ---- المرتجعات ----
  const returns = new SalesReturnsController(c.useCases.salesReturns);
  router.get('/sales/invoices/:id/return-data', auth, wrap(returns.createData));
  router.get('/sales/returns', auth, wrap(returns.index));
  router.post('/sales/returns', auth, wrap(returns.store));
  router.get('/sales/returns/:id', auth, wrap(returns.show));

  // ---- الإشعارات الدائنة ----
  const credits = new SalesCreditNotesController(c.useCases.salesCreditNotes);
  router.get('/sales/credit-notes/create-data', auth, wrap(credits.createData));
  router.get('/sales/credit-notes/settlement-preview', auth, wrap(credits.preview));
  router.get('/sales/credit-notes', auth, wrap(credits.index));
  router.post('/sales/credit-notes', auth, wrap(credits.store));
  router.get('/sales/credit-notes/:id', auth, wrap(credits.show));
  router.post('/sales/credit-notes/:id/cancel', auth, wrap(credits.cancel));

  // ---- تبديل البضاعة ----
  const exchanges = new SalesExchangesController(c.useCases.salesExchanges);
  router.get('/sales/exchange-reasons', auth, wrap(exchanges.reasons));
  router.get('/sales/exchanges/create-data', auth, wrap(exchanges.createData));
  router.get('/sales/exchanges', auth, wrap(exchanges.index));
  router.post('/sales/exchanges', auth, upload, wrap(exchanges.store));
  router.get('/sales/exchanges/:id', auth, wrap(exchanges.show));

  // ---- عروض الأسعار وأوامر البيع ----
  for (const [prefix, kind] of [['quotes', 'quote'], ['sales-orders', 'sales_order']] as const) {
    const ctl = new SalesQuotesController(c.useCases.salesQuotes, kind);
    router.get(`/sales/${prefix}`, auth, wrap(ctl.index));
    router.post(`/sales/${prefix}`, auth, wrap(ctl.store));
    router.get(`/sales/${prefix}/:id`, auth, wrap(ctl.show));
    router.put(`/sales/${prefix}/:id`, auth, wrap(ctl.update));
    router.delete(`/sales/${prefix}/:id`, auth, wrap(ctl.destroy));
    router.post(`/sales/${prefix}/:id/convert`, auth, wrap(ctl.convert));
  }

  // ---- الإقفال اليومي، أهدافي وعمولاتي، والتقارير ----
  const self = new SalesSelfServiceController(c.useCases.salesDailyClosing, c.useCases.salesMyPerformance, c.useCases.salesCollectionsReport, c.useCases.salesRepsPerformance);
  router.get('/sales/daily-closing', auth, wrap(self.closings));
  router.get('/sales/daily-closing/system-data', auth, wrap(self.systemData));
  router.get('/sales/daily-closing/stock-products', auth, wrap(self.stockProducts));
  router.post('/sales/daily-closing', auth, wrap(self.closingStore));
  router.post('/sales/daily-closing/auto', auth, wrap(self.closingAuto));
  router.get('/sales/daily-closing/:id', auth, wrap(self.closingShow));
  router.get('/sales/my/targets', auth, wrap(self.myTargets));
  router.get('/sales/my/commissions', auth, wrap(self.myCommissions));
  router.get('/sales/reports/payments-by-employee', auth, wrap(self.paymentsByEmployee));
  router.get('/sales/reps-performance', auth, wrap(self.repsPerformance));

  return router;
}
