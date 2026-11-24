import { Knex } from 'knex';
import { env } from './config/env';
import { AccessService } from './application/services/AccessService';
import { DataScopeService } from './application/services/DataScopeService';
import { PeriodResolver } from './application/services/PeriodResolver';
import { AccountingAccess } from './application/services/AccountingAccess';
import { ClientAccess } from './application/services/ClientAccess';
import { StockAccess } from './application/services/StockAccess';
import { SalesAccess } from './application/services/SalesAccess';
import { SalesUseCases } from './application/use-cases/sales/SalesUseCases';
import { ClientFormsUseCases } from './application/use-cases/client/ClientFormsUseCases';
import { StockFormsUseCases } from './application/use-cases/stock/StockFormsUseCases';
import { SalesFormsUseCases } from './application/use-cases/sales/SalesFormsUseCases';
import { PrintTemplateUseCases } from './application/use-cases/sales/PrintTemplateUseCases';
import { InvoiceTransfersUseCases } from './application/use-cases/clients/InvoiceTransfersUseCases';
import { AttendanceUseCases } from './application/use-cases/hr/AttendanceUseCases';
import { KnexSalesCatalogRepository } from './infrastructure/repositories/KnexSalesRepository';
import { StockUseCases } from './application/use-cases/stock/StockUseCases';
import { KnexStockCatalogRepository } from './infrastructure/repositories/KnexStockRepository';
import { ClientUseCases as ClientCatalogUseCases } from './application/use-cases/client/ClientUseCases';
import { KnexClientRepository as KnexClientCatalogRepository } from './infrastructure/repositories/KnexClientRepository';
import { AccountingFormsUseCases } from './application/use-cases/accounting/AccountingFormsUseCases';
import { AccountingUseCases } from './application/use-cases/accounting/AccountingUseCases';
import { HttpErpBridge } from './infrastructure/erp/HttpErpBridge';
import { UserPresenter } from './application/services/UserPresenter';
import { GetCurrentUserUseCase } from './application/use-cases/auth/GetCurrentUserUseCase';
import { LoginUseCase } from './application/use-cases/auth/LoginUseCase';
import { LogoutUseCase } from './application/use-cases/auth/LogoutUseCase';
import { RefreshTokenUseCase } from './application/use-cases/auth/RefreshTokenUseCase';
import { GetHomeModulesUseCase } from './application/use-cases/home/GetHomeModulesUseCase';
import { NotificationUseCases } from './application/use-cases/notifications/NotificationUseCases';
import { ProfileUseCases } from './application/use-cases/profile/ProfileUseCases';
import { GetLanguagesUseCase } from './application/use-cases/settings/GetLanguagesUseCase';
import { GetThemeUseCase } from './application/use-cases/settings/GetThemeUseCase';
import { MemoryCache } from './infrastructure/cache/MemoryCache';
import { createDb } from './infrastructure/db/knex';
import { KnexAccountingRepository } from './infrastructure/repositories/KnexAccountingRepository';
import { KnexFiscalRepository } from './infrastructure/repositories/KnexFiscalRepository';
import { KnexActivityLogRepository } from './infrastructure/repositories/KnexActivityLogRepository';
import { KnexBranchRepository } from './infrastructure/repositories/KnexBranchRepository';
import { KnexDeviceRepository } from './infrastructure/repositories/KnexDeviceRepository';
import { KnexEmployeeRepository } from './infrastructure/repositories/KnexEmployeeRepository';
import { KnexNotificationRepository } from './infrastructure/repositories/KnexNotificationRepository';
import { KnexPointsRepository } from './infrastructure/repositories/KnexPointsRepository';
import { KnexRoleRepository } from './infrastructure/repositories/KnexRoleRepository';
import { KnexSettingsRepository } from './infrastructure/repositories/KnexSettingsRepository';
import { KnexTokenRepository } from './infrastructure/repositories/KnexTokenRepository';
import { KnexUserRepository } from './infrastructure/repositories/KnexUserRepository';
import { BcryptHasher } from './infrastructure/security/BcryptHasher';
import { JwtTokenService } from './infrastructure/security/JwtTokenService';
import { ErpFileStorage, ErpImageStore } from './infrastructure/storage/ErpImageStore';
import { ErpMediaClient } from './infrastructure/storage/ErpMediaClient';
import { ClientForm } from './application/services/clients/ClientForm';
import { ClientNotesService } from './application/services/clients/ClientNotesService';
import { ClientsContextFactory } from './application/services/clients/ClientsContext';
import { ErpGate } from './application/services/access/ErpGate';
import { StockContextFactory } from './application/services/stock/StockContext';
import { WarehouseUseCases } from './application/use-cases/stock/WarehouseUseCases';
import { KnexStockRepository } from './infrastructure/repositories/stock/KnexStockRepository';
import { ClientsLog, NotificationGate } from './application/services/clients/ClientsSupport';
import { ClientVisibility } from './application/services/clients/ClientVisibility';
import { ClientNotesUseCases } from './application/use-cases/clients/ClientNotesUseCases';
import { ClientStatusUseCases } from './application/use-cases/clients/ClientStatusUseCases';
import { ClientUseCases } from './application/use-cases/clients/ClientUseCases';
import { ItineraryUseCases } from './application/use-cases/clients/ItineraryUseCases';
import { VisitUseCases } from './application/use-cases/clients/VisitUseCases';
import { FollowUpUseCases } from './application/use-cases/clients/FollowUpUseCases';
import { NotificationDetailUseCases } from './application/use-cases/clients/NotificationDetailUseCases';
import { TrackingUseCases } from './application/use-cases/clients/TrackingUseCases';
import { KnexForgottenVisitRepository, KnexJustificationRepository, KnexNotificationThreadRepository, KnexTrackingRepository } from './infrastructure/repositories/clients/KnexFollowUpRepositories';
import { KnexItineraryRepository } from './infrastructure/repositories/clients/KnexItineraryRepository';
import { KnexVisitRepository } from './infrastructure/repositories/clients/KnexVisitRepository';
import { KnexUnitOfWork, ZonedClock } from './infrastructure/db/KnexUnitOfWork';
import { KnexClientNotesRepository } from './infrastructure/repositories/clients/KnexClientNotesRepository';
import { KnexClientRepository } from './infrastructure/repositories/clients/KnexClientRepository';
import { KnexClientsReferenceRepository } from './infrastructure/repositories/clients/KnexClientsReferenceRepository';
import { KnexDocumentNumberRepository } from './infrastructure/repositories/clients/KnexDocumentNumberRepository';
import { KnexNotificationWriteRepository } from './infrastructure/repositories/clients/KnexNotificationWriteRepository';
import { KnexOperationLogRepository } from './infrastructure/repositories/clients/KnexOperationLogRepository';
import { KnexPeriodGuardRepository, KnexPermitRepository, KnexUsageCounter } from './infrastructure/repositories/stock/KnexPermitRepository';
import { PermitUseCases } from './application/use-cases/stock/PermitUseCases';
import { KnexSalesRepository } from './infrastructure/repositories/sales/KnexSalesRepository';
import { SalesContextFactory } from './application/services/sales/SalesContext';
import { SalesSettings, TreasuryGuard } from './application/services/sales/SalesSettings';
import { SalesSetupUseCases } from './application/use-cases/sales/SalesSetupUseCases';
import { InvoiceQueryUseCases } from './application/use-cases/sales/InvoiceQueryUseCases';
import { InvoiceCreateUseCase } from './application/use-cases/sales/InvoiceCreateUseCase';
import { PaymentUseCases } from './application/use-cases/sales/PaymentUseCases';
import { KnexSalesPaymentRepository } from './infrastructure/repositories/sales/KnexSalesPaymentRepository';
import { SalesProximity } from './application/services/sales/SalesProximity';
import { ReturnUseCases } from './application/use-cases/sales/ReturnUseCases';
import { SalesInventory } from './application/services/sales/SalesInventory';
import { CreditNoteUseCases } from './application/use-cases/sales/CreditNoteUseCases';
import { KnexCreditNoteRepository } from './infrastructure/repositories/sales/KnexCreditNoteRepository';
import { ExchangeUseCases } from './application/use-cases/sales/ExchangeUseCases';
import { KnexExchangeRepository } from './infrastructure/repositories/sales/KnexExchangeRepository';
import { QuoteUseCases } from './application/use-cases/sales/QuoteUseCases';
import { KnexQuoteRepository } from './infrastructure/repositories/sales/KnexQuoteRepository';
import { DailyClosingUseCases } from './application/use-cases/sales/DailyClosingUseCases';
import { MyPerformanceUseCases } from './application/use-cases/sales/MyPerformanceUseCases';
import { RepsPerformanceUseCases } from './application/use-cases/sales/RepsPerformanceUseCases';
import { CollectionsReportUseCases } from './application/use-cases/sales/CollectionsReportUseCases';
import { KnexDailyClosingRepository } from './infrastructure/repositories/sales/KnexDailyClosingRepository';
import { KnexPerformanceRepository } from './infrastructure/repositories/sales/KnexPerformanceRepository';
import { KnexCollectionsReportRepository } from './infrastructure/repositories/sales/KnexCollectionsReportRepository';
import { SalesJournal } from './application/services/sales/SalesJournal';
import { KnexSalesWriteRepository } from './infrastructure/repositories/sales/KnexSalesWriteRepository';
import { PriceListUseCases } from './application/use-cases/stock/PriceListUseCases';
import { KnexPriceListRepository } from './infrastructure/repositories/stock/KnexPriceListRepository';
import { PermitApprovalUseCases } from './application/use-cases/stock/PermitApprovalUseCases';
import { AccountBalances } from './application/services/stock/AccountBalances';
import { LedgerAccounts } from './application/services/accounting/LedgerAccounts';
import { KnexApprovalRepository, KnexLedgerRepository } from './infrastructure/repositories/stock/KnexApprovalRepository';
import { PlanLimitGuard } from './application/services/access/PlanLimitGuard';
import { AccountingPeriodGuard } from './application/services/stock/AccountingPeriodGuard';
import { StockLog } from './application/services/stock/StockLog';
import { GoogleGeocoder } from './infrastructure/storage/GoogleGeocoder';
import { HrAccess } from './application/services/HrAccess';
import { HrContextFactory } from './application/services/hr/HrContext';
import { KnexHrRepository } from './infrastructure/repositories/hr/KnexHrRepository';
import { KnexHrAdvanceRepository } from './infrastructure/repositories/hr/KnexHrAdvanceRepository';
import { KnexHrDeductionRepository } from './infrastructure/repositories/hr/KnexHrDeductionRepository';
import { KnexHrPayrollRepository } from './infrastructure/repositories/hr/KnexHrPayrollRepository';
import { AdvanceUseCases } from './application/use-cases/hr/AdvanceUseCases';
import { DeductionUseCases } from './application/use-cases/hr/DeductionUseCases';
import { PayslipUseCases } from './application/use-cases/hr/PayslipUseCases';
import { HrUseCases } from './application/use-cases/hr/HrUseCases';

/** تركيب الاعتماديات يدوياً — بلا حاوية سحرية، كل شيء ظاهر هنا */
export function buildContainer(db: Knex = createDb()) {
  const cache = new MemoryCache();
  const hasher = new BcryptHasher();
  const tokenService = new JwtTokenService(env.JWT_SECRET, env.JWT_ACCESS_TTL);
  // الصور تُرفع إلى النظام — لا تُحفظ على خادم التطبيق
  const media = new ErpMediaClient(env.ERP_MEDIA_URL ?? env.ERP_PUBLIC_URL, env.ERP_MEDIA_TOKEN);
  const storage = new ErpFileStorage(media, env.AVATAR_UPLOAD_DIR);

  const users = new KnexUserRepository(db);
  const employees = new KnexEmployeeRepository(db);
  const roles = new KnexRoleRepository(db);
  const branches = new KnexBranchRepository(db);
  const settings = new KnexSettingsRepository(db);
  const notifications = new KnexNotificationRepository(db);
  const tokens = new KnexTokenRepository(db);
  const devices = new KnexDeviceRepository(db);
  const activity = new KnexActivityLogRepository(db);
  const points = new KnexPointsRepository(db);

  const accountingRepo = new KnexAccountingRepository(db);
  // قوائم الأقسام العامّة (العرض) — غير مستودعات المنافذ الكاملة أدناه
  const clientCatalogRepo = new KnexClientCatalogRepository(db);
  const stockCatalogRepo = new KnexStockCatalogRepository(db);
  const salesCatalogRepo = new KnexSalesCatalogRepository(db);
  const fiscal = new KnexFiscalRepository(db);
  const access = new AccessService(roles, employees, branches, cache, env.CACHE_TTL_PERMISSIONS);
  const dataScope = new DataScopeService({ users, employees, branches });
  const periods = new PeriodResolver(fiscal);
  const accountingAccess = new AccountingAccess(users, settings, access, cache, env.CACHE_TTL_SETTINGS);
  const clientAccess = new ClientAccess(users, settings, access, db, cache, env.CACHE_TTL_SETTINGS);
  const stockAccess = new StockAccess(users, settings, access, cache, env.CACHE_TTL_SETTINGS);
  const salesAccess = new SalesAccess(users, settings, access, cache, env.CACHE_TTL_SETTINGS);
  // جسرٌ واحدٌ مشتركٌ لكل الوحدات — رمز Sanctum بصلاحية `mobile:erp` واحدٌ يخدم إنشاء أيّ وحدة
  const erpBridge = new HttpErpBridge(env.ERP_API_URL || env.ERP_PUBLIC_URL, tokens, env.ERP_BRIDGE_TIMEOUT_MS);
  const presenter = new UserPresenter(employees, branches, roles, access, env.ERP_PUBLIC_URL);

  // ---- العملاء: وقت النظام بمنطقته، ومعاملاتٌ كلّها أو لا شيء، وصورٌ تُرفع إلى مجلّدات الويب ----
  const clock = new ZonedClock(env.APP_TIMEZONE);
  const uow = new KnexUnitOfWork(db);
  const images = new ErpImageStore(media, env.ERP_PUBLIC_URL);
  const clientRefs = new KnexClientsReferenceRepository(db);
  const clientRepo = new KnexClientRepository(db);
  const clientNotesRepo = new KnexClientNotesRepository(db);
  const documentNumbers = new KnexDocumentNumberRepository(db);
  const clientsLog = new ClientsLog(new KnexOperationLogRepository(db, clock));
  const notificationGate = new NotificationGate(new KnexNotificationWriteRepository(db), clientRefs, cache);
  const gate = new ErpGate(users, settings, clientRefs, access, cache, { settingsTtl: env.CACHE_TTL_SETTINGS, enforceSubscription: env.ENFORCE_SUBSCRIPTION });
  const clientContexts = new ClientsContextFactory(gate, clientRefs, dataScope, cache, clock);

  // ---- المخزون ----
  const stockRepo = new KnexStockRepository(db);
  const stockContexts = new StockContextFactory(gate, clientRefs, dataScope, employees, users, stockRepo, cache, clock);
  const permitRepo = new KnexPermitRepository(db);
  const ledgerRepo = new KnexLedgerRepository(db);
  const planLimits = new PlanLimitGuard(clientRefs, new KnexUsageCounter(db), cache);
  const periodGuard = new AccountingPeriodGuard(new KnexPeriodGuardRepository(db), cache);
  const stockLog = new StockLog(new KnexOperationLogRepository(db, clock));
  const permitApprovals = new PermitApprovalUseCases(stockContexts, permitRepo, new KnexApprovalRepository(db), ledgerRepo, new AccountBalances(ledgerRepo), new LedgerAccounts(ledgerRepo), stockRepo, clientRefs, periodGuard, planLimits, notificationGate, stockLog, uow);
  const clientVisibility = new ClientVisibility(clientRepo);
  const salesRepo = new KnexSalesRepository(db, env.ERP_APP_NAME);
  const salesContexts = new SalesContextFactory(gate, () => clientRefs.treeNodes(), { dataScope, sales: salesRepo, stock: stockRepo, clients: clientRepo, clientContexts, visibility: clientVisibility }, cache, clock);
  const salesSettings = new SalesSettings(salesRepo, cache);
  const treasuryGuard = new TreasuryGuard(salesRepo);
  const salesWrites = new KnexSalesWriteRepository(db);
  const salesProximity = new SalesProximity(salesWrites);
  const salesInventory = new SalesInventory(salesWrites, stockRepo);
  const salesPaymentRepo = new KnexSalesPaymentRepository(db);
  const salesJournal = new SalesJournal(ledgerRepo, new AccountBalances(ledgerRepo), stockRepo, planLimits);
  const salesInvoiceQueries = new InvoiceQueryUseCases(salesContexts, salesRepo, clientRefs, clientContexts, clientVisibility);
  const clientForm = new ClientForm(clientRepo, clientRefs, documentNumbers);
  const clientNotes = new ClientNotesService(clientRepo, clientNotesRepo, notificationGate, clientsLog, uow, images);
  const itineraryRepo = new KnexItineraryRepository(db);
  const visitRepo = new KnexVisitRepository(db);
  const salesInvoiceCreate = new InvoiceCreateUseCase(salesContexts, salesRepo, salesWrites, stockRepo, ledgerRepo, new LedgerAccounts(ledgerRepo), new AccountBalances(ledgerRepo), salesSettings, treasuryGuard, periodGuard, planLimits, documentNumbers, notificationGate, visitRepo, new KnexOperationLogRepository(db, clock), clientRefs, salesInvoiceQueries, salesJournal, salesProximity, uow);
  // ---- الموارد البشرية: نطاقُها محورُه الموظف لا منشئُ السجل (انظر HrContext) ----
  const hrAccess = new HrAccess(users, settings, access, cache, env.CACHE_TTL_SETTINGS);
  const hrContexts = new HrContextFactory(gate, employees, branches, clock);
  const hrReference = new KnexHrRepository(db);
  const hrAdvanceRepo = new KnexHrAdvanceRepository(db);
  const hrDeductionRepo = new KnexHrDeductionRepository(db);
  const hrPayrollRepo = new KnexHrPayrollRepository(db);
  const hrDeductions = new DeductionUseCases(hrContexts, hrDeductionRepo);
  const hrPayslips = new PayslipUseCases(hrContexts, hrPayrollRepo, hrReference, cache);

  const clientsUseCase = new ClientUseCases(clientContexts, clientRepo, clientRefs, documentNumbers, clientVisibility, clientForm, clientsLog, uow, images, new GoogleGeocoder(env.GOOGLE_MAPS_API_KEY), hasher);
  const itineraryUseCase = new ItineraryUseCases(clientContexts, itineraryRepo, clientRepo, clientRefs, clientsUseCase, clientsLog, uow, images);

  return {
    db,
    cache,
    tokenService,
    repos: { users, employees, roles, branches, settings, notifications, tokens, devices, activity, points },
    useCases: {
      login: new LoginUseCase(users, employees, tokens, devices, activity, hasher, tokenService, presenter, env.REFRESH_TOKEN_TTL_DAYS),
      refresh: new RefreshTokenUseCase(users, tokens, tokenService, presenter, env.REFRESH_TOKEN_TTL_DAYS),
      logout: new LogoutUseCase(tokens, activity, tokenService),
      me: new GetCurrentUserUseCase(users, presenter),
      homeModules: new GetHomeModulesUseCase(users, settings, access, cache, env.CACHE_TTL_SETTINGS),
      theme: new GetThemeUseCase(settings, cache, env.CACHE_TTL_THEME, env.ERP_PUBLIC_URL),
      languages: new GetLanguagesUseCase(settings, cache, env.CACHE_TTL_SETTINGS),
      notifications: new NotificationUseCases(users, notifications, access),
      accounting: new AccountingUseCases(accountingAccess, dataScope, periods, accountingRepo),
      accountingForms: new AccountingFormsUseCases(accountingAccess, erpBridge),
      profile: new ProfileUseCases(users, points, activity, access, presenter, hasher, storage),
      client: new ClientCatalogUseCases(clientAccess, dataScope, clientCatalogRepo),
      stock: new StockUseCases(stockAccess, dataScope, stockCatalogRepo),
      sales: new SalesUseCases(salesAccess, dataScope, periods, salesCatalogRepo),
      clientForms: new ClientFormsUseCases(clientAccess, erpBridge),
      invoiceTransfers: new InvoiceTransfersUseCases(erpBridge),
      stockForms: new StockFormsUseCases(stockAccess, erpBridge),
      salesForms: new SalesFormsUseCases(salesAccess, erpBridge),
      clients: clientsUseCase,
      stockWarehouses: new WarehouseUseCases(stockContexts, stockRepo, periods),
      stockPermits: new PermitUseCases(stockContexts, permitRepo, stockRepo, clientRefs, documentNumbers, periods, periodGuard, planLimits, notificationGate, images, stockLog, uow, () => permitApprovals),
      stockPermitApprovals: permitApprovals,
      stockPriceLists: new PriceListUseCases(stockContexts, new KnexPriceListRepository(db), planLimits, uow),
      salesSetup: new SalesSetupUseCases(salesContexts, salesRepo, stockRepo, salesSettings, treasuryGuard, documentNumbers, clientRefs),
      salesInvoiceQueries,
      salesPrints: new PrintTemplateUseCases(salesContexts, erpBridge),
      salesDailyClosing: new DailyClosingUseCases(salesContexts, new KnexDailyClosingRepository(db), periodGuard, new KnexOperationLogRepository(db, clock), uow),
      salesMyPerformance: new MyPerformanceUseCases(salesContexts, new KnexPerformanceRepository(db)),
      salesRepsPerformance: new RepsPerformanceUseCases(salesContexts, erpBridge),
      salesCollectionsReport: new CollectionsReportUseCases(salesContexts, new KnexCollectionsReportRepository(db), salesRepo),
      salesExchanges: new ExchangeUseCases(salesContexts, new KnexExchangeRepository(db), salesRepo, salesWrites, stockRepo, new LedgerAccounts(ledgerRepo), salesJournal, salesInventory, periodGuard, planLimits, documentNumbers, new KnexOperationLogRepository(db, clock), clientRefs, images, uow),
      salesCreditNotes: new CreditNoteUseCases(salesContexts, new KnexCreditNoteRepository(db), salesRepo, salesWrites, stockRepo, ledgerRepo, new LedgerAccounts(ledgerRepo), salesJournal, salesInventory, salesProximity, salesSettings, periodGuard, planLimits, documentNumbers, visitRepo, new KnexOperationLogRepository(db, clock), clientRefs, salesInvoiceQueries, uow),
      salesReturns: new ReturnUseCases(salesContexts, salesRepo, salesWrites, salesPaymentRepo, stockRepo, ledgerRepo, new LedgerAccounts(ledgerRepo), salesJournal, salesInventory, salesProximity, salesSettings, treasuryGuard, periodGuard, planLimits, documentNumbers, visitRepo, new KnexOperationLogRepository(db, clock), clientRefs, salesInvoiceQueries, uow),
      salesPayments: new PaymentUseCases(salesContexts, salesPaymentRepo, salesRepo, salesWrites, stockRepo, ledgerRepo, new LedgerAccounts(ledgerRepo), salesJournal, treasuryGuard, periodGuard, planLimits, documentNumbers, notificationGate, new KnexOperationLogRepository(db, clock), clientRefs, salesInvoiceQueries, uow),
      salesInvoiceCreate: salesInvoiceCreate,
      salesQuotes: new QuoteUseCases(salesContexts, new KnexQuoteRepository(db), salesRepo, salesSettings, planLimits, periodGuard, documentNumbers, new KnexOperationLogRepository(db, clock), clientRefs, salesInvoiceCreate, uow),
      itinerary: itineraryUseCase,
      followUp: new FollowUpUseCases(clientContexts, new KnexForgottenVisitRepository(db), new KnexJustificationRepository(db), visitRepo, notificationGate, clientsLog, uow),
      notificationDetails: new NotificationDetailUseCases(clientContexts, new KnexNotificationThreadRepository(db), clientRefs, notificationGate),
      tracking: new TrackingUseCases(clientContexts, new KnexTrackingRepository(db), clientsLog, uow, env.APP_TIMEZONE),
      visits: new VisitUseCases(clientContexts, visitRepo, clientRepo, clientNotesRepo, clientRefs, documentNumbers, clientVisibility, clientNotes, notificationGate, clientsUseCase, itineraryUseCase, clientsLog, uow, images),
      clientStatuses: new ClientStatusUseCases(clientContexts, clientRepo, clientRefs, clientVisibility, notificationGate, clientsLog, uow),
      hr: new HrUseCases(hrAccess, hrContexts, hrReference, hrAdvanceRepo, hrDeductions, hrPayslips),
      hrAttendance: new AttendanceUseCases(hrAccess, erpBridge),
      hrAdvances: new AdvanceUseCases(hrContexts, hrAdvanceRepo, hrReference, clientRefs, planLimits, cache, uow),
      hrDeductions,
      hrPayslips,
      clientNotes: new ClientNotesUseCases(clientContexts, clientRepo, clientNotesRepo, clientNotes, clientVisibility, clientsLog, uow, images),
    },
  };
}

export type Container = ReturnType<typeof buildContainer>;
