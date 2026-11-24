import { Router } from 'express';
import multer from 'multer';
import { Container } from '../../../container';
import { AuthController, loginSchema, logoutSchema, refreshSchema } from '../controllers/AuthController';
import { HomeController } from '../controllers/HomeController';
import { listSchema, markSchema, NotificationsController } from '../controllers/NotificationsController';
import { changePasswordSchema, ProfileController, profileQuerySchema, switchBranchSchema, updateProfileSchema } from '../controllers/ProfileController';
import { AccountingController, AccountingFormsController, createBodySchema, formOptionsQuery, FORM_SECTIONS, listQuerySchema, nextCodeQuery, SECTION_ROUTES } from '../controllers/AccountingController';
import { ClientModuleController, clientListQuerySchema, CLIENT_SECTION_ROUTES } from '../controllers/ClientModuleController';
import { StockModuleController, stockListQuerySchema, STOCK_SECTION_ROUTES } from '../controllers/StockModuleController';
import { SalesModuleController, salesListQuerySchema, SALES_SECTION_ROUTES } from '../controllers/SalesModuleController';
import { ClientFormsController, CLIENT_CREATE_BODY, CLIENT_FORM_OPTIONS_QUERY } from '../controllers/ClientFormsController';
import { StockFormsController, STOCK_CREATE_BODY, STOCK_FORM_OPTIONS_QUERY } from '../controllers/StockFormsController';
import { SalesFormsController, SALES_CREATE_BODY, SALES_FORM_OPTIONS_QUERY } from '../controllers/SalesFormsController';
import { SettingsController } from '../controllers/SettingsController';
import { authenticate } from '../middlewares/auth';
import { loginLimiter } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { env } from '../../../config/env';
import { probeErp } from '../erpDiagnostics';
import { describeDbError } from '../dbDiagnostics';
import { Request, RequestHandler, Response } from 'express';
import { clientRoutes } from './clients';
import { salesRoutes } from './sales';
import { stockRoutes } from './stock';
import { hrRoutes } from './hr';

/** يلفّ المعالجات غير المتزامنة كي تصل أخطاؤها إلى errorHandler */
const wrap = (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  (req, res, next) => fn(req, res).catch(next);

export function buildRouter(c: Container): Router {
  const router = Router();
  const auth = authenticate(c.tokenService, c.repos.users);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  const authCtl = new AuthController(c.useCases.login, c.useCases.refresh, c.useCases.logout, c.useCases.me);
  const homeCtl = new HomeController(c.useCases.homeModules);
  const settingsCtl = new SettingsController(c.useCases.theme, c.useCases.languages);
  const notifCtl = new NotificationsController(c.useCases.notifications);
  const profileCtl = new ProfileController(c.useCases.profile);
  const accountingCtl = new AccountingController(c.useCases.accounting);
  const formsCtl = new AccountingFormsController(c.useCases.accountingForms);
  const clientCtl = new ClientModuleController(c.useCases.client);
  const stockCtl = new StockModuleController(c.useCases.stock);
  const salesCtl = new SalesModuleController(c.useCases.sales);
  const clientFormsCtl = new ClientFormsController(c.useCases.clientForms);
  const stockFormsCtl = new StockFormsController(c.useCases.stockForms);
  const salesFormsCtl = new SalesFormsController(c.useCases.salesForms);

  router.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

  /**
   * فحص الاتصال بقاعدة بيانات النظام. يُرجع رمز الخطأ وتلميحاً فقط — لا مضيف ولا اسم مستخدم ولا كلمة مرور.
   * يُستعمل بعد النشر لمعرفة لماذا يفشل الدخول (بيانات خاطئة، أو الاستضافة لا تسمح باتصال خارجي…).
   */
  router.get('/health/db', async (_req, res) => {
    try {
      await Promise.race([
        c.db.raw('select 1 as ok'),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 10_000)),
      ]);
      await c.db('users').count({ n: 'id' }).first(); // the ERP schema must be there too
      res.json({ success: true, data: { database: 'ok' } });
    } catch (e) {
      res.status(503).json({ success: false, error: describeDbError(e, env) });
    }
  });

  /**
   * فحص الوصول إلى نظام الإدارة (جسر الإضافة ورفع الصور): يُرجع النطاق المستعمَل ورمز الخطأ وتلميحاً.
   * أيّ ردّ HTTP من الـ ERP (ولو 401) = الشبكة سليمة.
   */
  router.get('/health/erp', async (_req, res) => {
    const configured = Boolean(env.ERP_API_URL || process.env.ERP_PUBLIC_URL?.trim());
    const probe = await probeErp(env.ERP_API_URL || env.ERP_PUBLIC_URL, configured);
    res.status(probe.success ? 200 : 503).json({ success: probe.success, data: probe });
  });

  // ---- عام (قبل الدخول): المظهر واللغات كي تُبنى شاشة الدخول بألوان النظام ----
  router.get('/settings/theme', wrap(settingsCtl.themeHandler));
  router.get('/settings/languages', wrap(settingsCtl.languagesHandler));

  // ---- الدخول ----
  router.post('/auth/login', loginLimiter, validate(loginSchema), wrap(authCtl.loginHandler));
  router.post('/auth/refresh', validate(refreshSchema), wrap(authCtl.refreshHandler));
  router.post('/auth/logout', auth, validate(logoutSchema), wrap(authCtl.logoutHandler));
  router.get('/auth/me', auth, wrap(authCtl.meHandler));

  // ---- الرئيسية ----
  router.get('/home/modules', auth, wrap(homeCtl.modulesHandler));

  // ---- الإشعارات ----
  router.get('/notifications', auth, validate(listSchema, 'query'), wrap(notifCtl.listHandler));
  router.get('/notifications/unread-count', auth, wrap(notifCtl.unreadCountHandler));
  router.post('/notifications/mark-read', auth, validate(markSchema), wrap(notifCtl.markReadHandler));
  router.post('/notifications/mark-all-read', auth, wrap(notifCtl.markAllReadHandler));

  // ---- الملف الشخصي ----
  router.get('/profile', auth, validate(profileQuerySchema, 'query'), wrap(profileCtl.showHandler));
  router.put('/profile', auth, validate(updateProfileSchema), wrap(profileCtl.updateHandler));
  router.put('/profile/password', auth, validate(changePasswordSchema), wrap(profileCtl.passwordHandler));
  router.put('/profile/branch', auth, validate(switchBranchSchema), wrap(profileCtl.branchHandler));
  router.post('/profile/avatar', auth, upload.single('avatar'), wrap(profileCtl.avatarHandler));

  // ---- الحسابات ----
  router.get('/accounting/sections', auth, wrap(accountingCtl.sectionsHandler));
  router.get('/accounting/periods', auth, wrap(accountingCtl.periodsHandler));
  router.get('/accounting/overview', auth, validate(listQuerySchema, 'query'), wrap(accountingCtl.overviewHandler));
  for (const route of Object.keys(SECTION_ROUTES)) {
    router.get(`/accounting/${route}`, auth, validate(listQuerySchema, 'query'), wrap(accountingCtl.listHandler(route)));
  }

  // ---- العملاء (عرضٌ فقط في هذه المرحلة) ----
  router.get('/client/sections', auth, wrap(clientCtl.sectionsHandler));
  router.get('/client/overview', auth, wrap(clientCtl.overviewHandler));
  for (const route of Object.keys(CLIENT_SECTION_ROUTES)) {
    router.get(`/client/${route}`, auth, validate(clientListQuerySchema, 'query'), wrap(clientCtl.listHandler(route)));
  }

  // ---- المخزون (عرضٌ فقط في هذه المرحلة) ----
  router.get('/stock/sections', auth, wrap(stockCtl.sectionsHandler));
  router.get('/stock/overview', auth, wrap(stockCtl.overviewHandler));
  for (const route of Object.keys(STOCK_SECTION_ROUTES)) {
    router.get(`/stock/${route}`, auth, validate(stockListQuerySchema, 'query'), wrap(stockCtl.listHandler(route)));
  }

  // ---- المبيعات (عرضٌ فقط في هذه المرحلة) ----
  router.get('/sales/sections', auth, wrap(salesCtl.sectionsHandler));
  router.get('/sales/overview', auth, validate(salesListQuerySchema, 'query'), wrap(salesCtl.overviewHandler));
  for (const route of Object.keys(SALES_SECTION_ROUTES)) {
    router.get(`/sales/${route}`, auth, validate(salesListQuerySchema, 'query'), wrap(salesCtl.listHandler(route)));
  }

  // إنشاء السجلات في العملاء والمخزون والمبيعات: الخادم يصف النموذج والويب (Laravel) ينفّذ
  const registerForms = (
    prefix: string,
    sections: string[],
    ctl: { definition: (req: Request, res: Response) => Promise<unknown>; options: (req: Request, res: Response) => Promise<unknown>; create: (req: Request, res: Response) => Promise<unknown> },
    optionsQuery: typeof CLIENT_FORM_OPTIONS_QUERY,
    createBody: typeof CLIENT_CREATE_BODY,
  ) => {
    for (const section of sections) {
      router.get(`/${prefix}/forms/${section}`, auth, (req, _res, next) => ((req.params.section = section), next()), wrap(ctl.definition));
      router.get(`/${prefix}/forms/${section}/options`, auth, validate(optionsQuery, 'query'), (req, _res, next) => ((req.params.section = section), next()), wrap(ctl.options));
      router.post(`/${prefix}/forms/${section}`, auth, validate(createBody), (req, _res, next) => ((req.params.section = section), next()), wrap(ctl.create));
    }
  };
  registerForms('client', ['clients', 'competitors'], clientFormsCtl, CLIENT_FORM_OPTIONS_QUERY, CLIENT_CREATE_BODY);
  registerForms('stock', ['warehouses', 'products', 'permits'], stockFormsCtl, STOCK_FORM_OPTIONS_QUERY, STOCK_CREATE_BODY);
  registerForms('sales', ['payments', 'invoices', 'quotes'], salesFormsCtl, SALES_FORM_OPTIONS_QUERY, SALES_CREATE_BODY);

  // إنشاء السجلات: الخادم يصف النموذج والويب (Laravel) ينفّذ — انظر AccountingFormsUseCases
  router.get('/accounting/forms/next-code/:kind', auth, validate(nextCodeQuery, 'query'), wrap(formsCtl.nextCode));
  router.get('/accounting/forms/checkbook/:id', auth, wrap(formsCtl.checkbook));
  for (const section of FORM_SECTIONS) {
    router.get(`/accounting/forms/${section}`, auth, (req, _res, next) => ((req.params.section = section), next()), wrap(formsCtl.definition));
    router.get(`/accounting/forms/${section}/options`, auth, validate(formOptionsQuery, 'query'), (req, _res, next) => ((req.params.section = section), next()), wrap(formsCtl.options));
    router.post(`/accounting/forms/${section}`, auth, validate(createBodySchema), (req, _res, next) => ((req.params.section = section), next()), wrap(formsCtl.create));
  }

  // ---- المنافذ الكاملة: العملاء والمخزون والمبيعات ----
  // تُسجَّل بعد شاشات الأقسام أعلاه: عند تطابق المسار (قوائم /stock/warehouses|permits و/sales/invoices|quotes|returns|credit-notes|payments) تخدم الشاشةُ العامّة
  router.use(clientRoutes(c, auth));
  router.use(stockRoutes(c, auth));
  router.use(salesRoutes(c, auth));
  // ---- الموارد البشرية ----
  router.use(hrRoutes(c, auth));

  return router;
}
