import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';
import { Container } from '../../../container';
import { AppError } from '../../../domain/errors/AppError';
import { ClientsController } from '../controllers/clients/ClientsController';
import { ItineraryController, VisitsController } from '../controllers/clients/VisitsController';
import { FollowUpController } from '../controllers/clients/FollowUpController';
import { InvoiceTransfersController } from '../controllers/clients/InvoiceTransfersController';
import { trackingLimiter } from '../middlewares/rateLimit';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => fn(req, res).catch(next);

/**
 * النماذج المتعدّدة الأجزاء (صور العميل والملاحظات والمسؤولين). حدّ الملف هنا
 * سقفٌ تقنيّ فقط؛ الحدّ الفعليّ من «إعدادات وحدات العملاء» يُفحص في طبقة التطبيق.
 * و`fieldSize` لأن التوقيعات تصل نصّاً base64 (حتى 3MB كما يقبلها الويب).
 */
const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 40, fields: 300, fieldSize: 4 * 1024 * 1024 } }).any();

export function upload(req: Request, res: Response, next: NextFunction) {
  multipart(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من المسموح.' : err.code === 'LIMIT_FILE_COUNT' ? 'عدد الملفات أكبر من المسموح.' : 'تعذّرت قراءة الملفات المرفوعة.';
      return next(AppError.validation({ [err.field ?? 'files']: [message] }, message));
    }
    next(err);
  });
}

/**
 * العملاء — `/api/v1/clients | notes | branches | itinerary | visits | visit-justifications | tracking`
 * وتفاصيل الإشعار والردّ عليه (`/notifications/:id`).
 * الصلاحية والنطاق ومفتاح «العملاء» والاشتراك تُفحص في طبقة التطبيق
 * (`ClientsContextFactory`) بترتيب وسطاء الويب؛ هنا المسارات فقط.
 */
export function clientRoutes(c: Container, auth: RequestHandler): Router {
  const router = Router();
  const ctl = new ClientsController(c.useCases.clients, c.useCases.clientStatuses, c.useCases.clientNotes);
  const it = new ItineraryController(c.useCases.itinerary);
  const vis = new VisitsController(c.useCases.visits);
  const fu = new FollowUpController(c.useCases.followUp, c.useCases.notificationDetails, c.useCases.tracking);

  router.get('/branches', auth, wrap(ctl.branches));

  router.get('/clients/settings', auth, wrap(ctl.settings));
  router.get('/clients/options', auth, wrap(ctl.options));
  router.get('/clients/map', auth, wrap(ctl.map));
  router.get('/clients', auth, wrap(ctl.index));
  router.post('/clients', auth, upload, wrap(ctl.store));
  router.get('/clients/:client', auth, wrap(ctl.show));
  router.post('/clients/:client', auth, upload, wrap(ctl.update));

  router.get('/clients/:client/status-options', auth, wrap(ctl.statusOptions));
  router.post('/clients/:client/status', auth, wrap(ctl.updateStatus));
  router.post('/clients/:client/stage', auth, wrap(ctl.updateStage));

  router.get('/clients/:client/contacts', auth, wrap(ctl.contacts));
  router.post('/clients/:client/contacts', auth, upload, wrap(ctl.addContact));

  router.get('/clients/:client/notes', auth, wrap(ctl.notesIndex));
  router.post('/clients/:client/notes', auth, upload, wrap(ctl.addNote));
  router.post('/notes/:note', auth, upload, wrap(ctl.updateNote));
  router.delete('/notes/:note', auth, wrap(ctl.destroyNote));
  router.delete('/notes/:note/attachments/:index', auth, wrap(ctl.destroyNoteAttachment));

  // ---- خطّ السير اليومي ----
  router.get('/itinerary/day', auth, wrap(it.day));
  router.get('/itinerary/employees', auth, wrap(it.employees));
  router.get('/itinerary/clients', auth, wrap(it.picker));
  router.post('/itinerary/clients', auth, wrap(it.add));
  router.post('/itinerary/:row/postpone', auth, wrap(it.postpone));
  router.post('/clients/:client/return-to-itinerary', auth, wrap(it.returnClient));

  // ---- الزيارات المنسيّة — قبل `/visits/:visit` كي لا يلتقطها ----
  router.get('/visits/forgotten', auth, wrap(fu.forgotten));
  router.post('/visits/forgotten/:visit/close', auth, wrap(fu.closeForgotten));
  router.post('/visits/forgotten/:visit/cancel', auth, wrap(fu.cancelForgotten));

  // ---- مساحة عمل الزيارة ----
  router.post('/clients/:client/visits/open', auth, wrap(vis.open));
  router.get('/visits/current', auth, wrap(vis.current));
  router.get('/visits/:visit', auth, wrap(vis.show));
  router.get('/visits/:visit/receipts/:receipt', auth, wrap(vis.receipt));
  router.post('/visits/:visit/start', auth, upload, wrap(vis.start));
  router.post('/visits/:visit/toggle-pause', auth, wrap(vis.togglePause));
  router.post('/visits/:visit/contact', auth, upload, wrap(vis.contact));
  router.post('/visits/:visit/contact-shift', auth, wrap(vis.contactShift));
  router.post('/visits/:visit/notes', auth, upload, wrap(vis.note));
  router.post('/visits/:visit/competitors', auth, upload, wrap(vis.competitors));
  router.post('/visits/:visit/competitors/quick', auth, wrap(vis.quickCompetitor));
  router.post('/visits/:visit/notifications/:notification/read', auth, wrap(vis.readNotification));
  router.post('/visits/:visit/notifications/:notification/reply', auth, wrap(vis.replyNotification));
  router.post('/visits/:visit/complete', auth, upload, wrap(vis.complete));
  router.post('/visits/:visit/cancel', auth, upload, wrap(vis.cancel));

  // ---- تبريرات الزيارات غير المكتملة ----
  router.get('/visit-justifications/pending', auth, wrap(fu.pendingJustifications));
  router.post('/visit-justifications', auth, wrap(fu.submitJustifications));
  router.get('/visit-justifications', auth, wrap(fu.justifications));
  router.get('/visit-justifications/:visit', auth, wrap(fu.justification));
  router.put('/visit-justifications/:visit', auth, wrap(fu.updateJustification));

  // ---- الإشعار وردوده (القائمة والعدّاد موجودان في routes/index.ts) ----
  router.get('/notifications/:notification', auth, wrap(fu.notification));
  router.post('/notifications/:notification/reply', auth, wrap(fu.replyNotification));

  // ---- تتبّع الموقع ----
  router.post('/tracking/location', auth, trackingLimiter, wrap(fu.sendLocation));
  router.get('/tracking/path', auth, wrap(fu.path));
  router.get('/tracking/team', auth, wrap(fu.team));

  // ---- تسليم واستلام الفواتير والأرصدة (شاشة الويب عبر الجسر) ----
  const tr = new InvoiceTransfersController(c.useCases.invoiceTransfers);
  router.get('/invoice-transfers', auth, wrap(tr.overview));
  router.get('/invoice-transfers/sendable-clients', auth, wrap(tr.sendable));
  router.get('/invoice-transfers/client/:clientId', auth, wrap(tr.forClient));
  router.post('/invoice-transfers', auth, wrap(tr.send));
  router.post('/invoice-transfers/receive-all', auth, wrap(tr.receiveAll));
  router.post('/invoice-transfers/batch/:batch/respond', auth, wrap(tr.respondBatch));
  router.post('/invoice-transfers/:id/respond', auth, wrap(tr.respond));
  router.post('/invoice-transfers/:id/cancel', auth, wrap(tr.cancel));

  return router;
}
