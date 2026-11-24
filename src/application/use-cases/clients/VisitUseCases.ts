import { AppError } from '../../../domain/errors/AppError';
import { ClientNotesRepository, ClientRepository, ClientRow, ClientsReferenceRepository, DocumentNumberRepository } from '../../../domain/repositories/clients';
import { VisitRepository, VisitRow } from '../../../domain/repositories/visits';
import { kmBetween } from '../../../domain/services/clients/Geo';
import { diffInSecondsAbs, parseLocal, startOfDay, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { hasShift, parseShiftRange, shiftRangeValue } from '../../../domain/services/clients/ShiftRange';
import { ImageStore, UnitOfWork } from '../../ports';
import { ClientNotesService, MEDIA, SHIFT_INVALID } from '../../services/clients/ClientNotesService';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog, NotificationGate } from '../../services/clients/ClientsSupport';
import { ClientVisibility } from '../../services/clients/ClientVisibility';
import { checkImage, FieldErrors, FormInput, UploadedFile } from '../../services/clients/FormInput';
import { CLIENT_PERMISSIONS, ClientUseCases } from './ClientUseCases';
import { ItineraryUseCases } from './ItineraryUseCases';

export const VISIT_LOG_MODULE = 'ClientVisitWorkspace';
const DOCS_LIMIT = 20;

export const VISIT_PERMISSIONS = {
  complete: 'clients_visit_complete',
  cancel: 'clients_visit_cancel',
  reply: 'notifications_reply_to_notifications',
} as const;

export interface VisitSteps {
  hasContact: boolean;
  hasShift: boolean;
  hasNote: boolean;
  competitorStep: boolean;
  hasCompetitors: boolean;
  docsUnlocked: boolean;
  hasSale: boolean;
  canComplete: boolean;
  canReturn: boolean;
  outcome: 'success' | 'failed';
}

/**
 * مساحة عمل الزيارة — `VisitWorkspaceController` في الويب بسلسلة خطواتها:
 *
 *   فتح ← بدء (من موقع العميل) ← مسؤول العميل ← دوامه ← ملاحظة الزيارة
 *   ← رصد المنافسين ← (المستندات) ← إنهاء، أو إلغاء بسبب.
 *
 * كل خطوةٍ تُكتب بعد «البدء» فقط، ولا تُكتب في زيارةٍ مغلقة. والإنهاء لا يقبل
 * نتيجةً يدوية: فاتورةٌ أو تحصيلٌ بعد البدء ⇐ ناجحة، وإلا ⇐ سلبيّة.
 */
export class VisitUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly visits: VisitRepository,
    private readonly clients: ClientRepository,
    private readonly notes: ClientNotesRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly numbers: DocumentNumberRepository,
    private readonly visibility: ClientVisibility,
    private readonly notesService: ClientNotesService,
    private readonly notifications: NotificationGate,
    private readonly clientUseCases: ClientUseCases,
    private readonly itinerary: ItineraryUseCases,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly images: ImageStore,
  ) {}

  // ═══════════════════════ القواعد (VisitRules) ═══════════════════════

  private async load(userId: number, meta: RequestMeta, visitId: number, extra: Array<string | string[]> = []) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.workspace]);
    for (const p of extra) if (!ctx.can(p)) throw AppError.forbidden('FORBIDDEN', 'ليس لديك صلاحية لتنفيذ هذا الإجراء.');
    const visit = await this.visits.find(visitId);
    if (!visit) throw AppError.notFound('VISIT_NOT_FOUND', 'الزيارة غير موجودة.');
    await this.authorizeOwner(ctx, visit);
    return { ctx, visit };
  }

  /** صاحب الزيارة، أو متتبّع الزيارات، أو دور admin */
  private async authorizeOwner(ctx: ClientsContext, visit: VisitRow) {
    const allowed = visit.employeeId === ctx.user.id || ctx.can('clients_visits_track') || (await this.visits.hasSpatieRole(ctx.user.id, 'admin'));
    if (!allowed) throw AppError.forbidden('VISIT_FORBIDDEN', 'لا يمكنك الوصول إلى زيارة لا تخصّك.');
  }

  private closedMessage(visit: VisitRow) {
    return visit.departureTime ? 'هذه الزيارة مغلقة (أُنهيت أو أُلغيت) — افتح زيارةً جديدة للعميل.' : null;
  }

  /** ما يُمنع قبل الكتابة: زيارةٌ مغلقة، أو لم تبدأ بعد */
  private writeBlock(visit: VisitRow) {
    const closed = this.closedMessage(visit);
    if (closed) throw new AppError('VISIT_CLOSED', closed, 422);
    if (!visit.startedAt) throw new AppError('VISIT_NOT_STARTED', 'لم تبدأ الزيارة بعد — اضغط «بدء الزيارة» من موقع العميل قبل تنفيذ أي إجراء.', 422);
  }

  private isClientExempt(ctx: ClientsContext, client: ClientRow | null) {
    return client !== null && ctx.settings.module.exemptLocationEnabled && client.exemptVisitLocation;
  }

  private anyLocation(ctx: ClientsContext, client: ClientRow | null) {
    return ctx.can('clients_visit_any_location') || this.isClientExempt(ctx, client);
  }

  /** إحداثيات العميل: المحفوظة مع الزيارة، وإلا موقعه المسجَّل */
  private async clientCoordinates(visit: VisitRow): Promise<[number, number] | null> {
    if (visit.clientLatitude && visit.clientLongitude) return [visit.clientLatitude, visit.clientLongitude];
    const client = await this.clients.find(visit.clientId);
    const location = client ? (await this.clients.extras([client])).get(client.id)?.location : null;
    return location && location.latitude && location.longitude ? [location.latitude, location.longitude] : null;
  }

  /** نطاق القرب لصاحب الزيارة — `visitProximityRadiusKmFor($visit->employee)` */
  private async ownerRadius(ctx: ClientsContext, visit: VisitRow) {
    return ctx.settings.visitProximityRadiusKmFor(await this.reference.userProximityRadius(visit.employeeId));
  }

  /** الموقع الحالي بقاعدة الويب: إلزاميّ لمن لا يُعفى، ثم فحص النطاق */
  private async checkLocation(ctx: ClientsContext, visit: VisitRow, client: ClientRow | null, input: FormInput, errors: FieldErrors, action: string) {
    const required = !this.anyLocation(ctx, client);
    const message = `يجب تحديد موقعك الحالي ${action} — فعّل GPS.`;
    const lat = input.number('currentLatitude', { required, min: -90, max: 90, message });
    const lng = input.number('currentLongitude', { required, min: -180, max: 180, message });
    return { lat, lng };
  }

  private async outOfRange(ctx: ClientsContext, visit: VisitRow, client: ClientRow | null, lat: number | null, lng: number | null, action: string) {
    if (this.anyLocation(ctx, client)) return;
    const coords = await this.clientCoordinates(visit);
    if (!coords) {
      throw new AppError('OUT_OF_RANGE', 'لا يوجد موقعٌ مسجَّل لهذا العميل، فلا يمكن التحقّق من وجودك عنده. حدّث بيانات العميل بموقعه على الخريطة، أو ألغِ الزيارة.', 422);
    }
    const distance = kmBetween(lat ?? 0, lng ?? 0, coords[0], coords[1]);
    const max = await this.ownerRadius(ctx, visit);
    if (distance > max) {
      throw new AppError('OUT_OF_RANGE', `يجب أن تكون ضمن نطاق ${max.toFixed(1)} كم من موقع العميل ${action}. المسافة الحالية: ${distance.toFixed(2)} كم.`, 422);
    }
  }

  /** حالة الخطوات — مصدرٌ واحدٌ يقرؤه التطبيق ويحرس به الإنهاء */
  async steps(ctx: ClientsContext, visit: VisitRow, userId: number): Promise<VisitSteps> {
    const contacts = await this.visits.contactShifts(visit.clientId);
    const since = visit.startedAt ?? toSqlDateTime(startOfDay(ctx.now));

    const hasContact = contacts.length > 0;
    const shifted = contacts.some((c) => hasShift(c.shiftStart, c.shiftEnd));
    const [hasNote, hasSale] = await Promise.all([this.visits.hasNoteSince(visit.clientId, userId, since), this.visits.hasSaleOrCollectionSince(visit.clientId, userId, since)]);
    const competitorStep = ctx.settings.competitorCaptureEnabled();
    const hasCompetitors = !competitorStep || (await this.visits.hasObservations(visit.id));
    const basics = hasContact && shifted && hasNote;

    return {
      hasContact,
      hasShift: hasContact && shifted,
      hasNote,
      competitorStep,
      hasCompetitors,
      docsUnlocked: basics && hasCompetitors,
      hasSale,
      canComplete: basics && hasCompetitors,
      canReturn: basics,
      outcome: hasSale ? 'success' : 'failed',
    };
  }

  private missingStepMessage(steps: VisitSteps, returnLater: boolean) {
    if (!steps.hasContact) return 'أضِف مسؤول العميل أولاً.';
    if (!steps.hasShift) return 'سجّل دوام المسؤول أولاً.';
    if (!steps.hasNote) return 'سجّل ملاحظة الزيارة أولاً.';
    return returnLater ? 'أكمل خطوات الزيارة أولاً.' : 'سجّل رصد المنافسين أولاً — أو اختر «سأعود لهذا العميل اليوم».';
  }

  /** المدّة المنقضية — `elapsed_seconds`: من البدء، بلا فترات الإيقاف */
  private elapsedSeconds(visit: VisitRow, now: Date) {
    const started = parseLocal(visit.startedAt);
    if (!started) return 0;
    const end = parseLocal(visit.departureTime) ?? now;
    let elapsed = diffInSecondsAbs(end, started) - visit.totalPausedSeconds;
    const paused = parseLocal(visit.pausedAt);
    if (paused) elapsed -= diffInSecondsAbs(now, paused);
    return Math.max(0, Math.trunc(elapsed));
  }

  private isPaused(visit: VisitRow) {
    return visit.stage === 'paused' && visit.pausedAt !== null;
  }

  private timer(ctx: ClientsContext, visit: VisitRow) {
    return { visitId: visit.id, stage: visit.stage, startedAt: visit.startedAt, paused: this.isPaused(visit), elapsedSeconds: this.elapsedSeconds(visit, ctx.now) };
  }

  /** إشعار الوصول/الانصراف — `sendVisitNotifications()`؛ تعثّره لا يُسقط العملية */
  private async notifyArrivalOrDeparture(ctx: ClientsContext, visit: VisitRow, type: 'arrival' | 'departure') {
    try {
      const arrival = type === 'arrival';
      const client = await this.clients.find(visit.clientId);
      const at = parseLocal(arrival ? visit.arrivalTime : visit.departureTime) ?? ctx.now;
      const time = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
      const employee = visit.employeeName ?? 'غير معروف';
      const clientName = client?.tradeName ?? 'غير معروف';
      await this.notifications.send(
        {
          userId: visit.employeeId,
          receiverId: null,
          type: 'visit',
          title: arrival ? 'وصول موظف إلى عميل' : 'انصراف موظف من عميل',
          description: arrival ? `الموظف ${employee} وصل إلى العميل ${clientName} — ${time}` : `الموظف ${employee} انصرف من العميل ${clientName} — ${time}`,
          clientId: visit.clientId,
          read: false,
        },
        ctx.now,
      );
    } catch (e) {
      await this.log.failure(ctx, e, 'visit_notification', visit.id, VISIT_LOG_MODULE);
    }
  }

  // ═══════════════════════ الشاشة ═══════════════════════

  /** الزيارة كاملةً كما تعرضها شاشة «إتمام الزيارة» */
  private async payload(ctx: ClientsContext, visit: VisitRow) {
    const client = await this.clients.find(visit.clientId);
    const presenter = await this.clientUseCases.presenter(ctx);
    const [extras, due] = client ? await Promise.all([this.clients.extras([client]), this.clients.dueBalances([client.id])]) : [new Map(), new Map()];
    const steps = await this.steps(ctx, visit, ctx.user.id);
    const capture = ctx.settings.competitorCaptureEnabled();
    const canChangeStatus = ctx.can('clients_change_status');
    const statusNeedsApproval = canChangeStatus && !ctx.can('clients_approve_status') && ctx.settings.statusChangeRequiresApproval();
    const stageNeedsApproval = canChangeStatus && !ctx.can('clients_approve_stage');
    const coords = await this.clientCoordinates(visit);

    const [statusApprovers, stageApprovers, contacts, notes, observed, competitorOptions, clientNotifications, visitDocs, clientDocs] = await Promise.all([
      statusNeedsApproval ? this.reference.approvers('clients_approve_status') : Promise.resolve([]),
      stageNeedsApproval ? this.reference.approvers('clients_approve_stage') : Promise.resolve([]),
      this.notesService.listContacts(visit.clientId),
      this.notes.notes(visit.clientId, null, 1, 20),
      this.visits.observations(visit.id),
      capture ? this.reference.activeCompetitors() : Promise.resolve([]),
      this.visits.clientNotifications(visit.clientId, ctx.user.id, ctx.nowSql),
      visit.startedAt ? this.documents(ctx, visit, true) : Promise.resolve([]),
      this.documents(ctx, visit, false),
    ]);

    const grouped: Record<string, unknown[]> = {};
    for (const d of clientDocs) (grouped[d.group] ??= []).push(d);

    return {
      ...this.timer(ctx, visit),
      visitNumber: visit.visitNumber,
      visitDate: visit.visitDate ? visit.visitDate.slice(0, 10) : null,
      departureTime: visit.departureTime,
      outcome: visit.outcome,
      cancelReason: visit.cancelReason,
      employee: { id: visit.employeeId, name: visit.employeeName },
      client: client ? presenter.summary(client, extras.get(client.id), due.get(client.id) ?? 0) : null,
      clientLocation: coords ? { latitude: coords[0], longitude: coords[1] } : null,
      steps,
      rules: {
        proximityMeters: Math.round((await this.ownerRadius(ctx, visit)) * 1000),
        anyLocation: this.anyLocation(ctx, client),
        competitorCapture: capture,
        signatureRequired: ctx.settings.signatureRequired(),
        noteDepositCount: ctx.settings.visitWorkspaceSectionVisible('note_deposit_count'),
        notePhoto: ctx.settings.visitWorkspaceSectionVisible('note_photo'),
        noteMinPhotos: ctx.settings.noteMinPhotos(),
        maxUploadKb: ctx.settings.maxUploadSizeKb(),
      },
      can: {
        complete: ctx.can(VISIT_PERMISSIONS.complete),
        cancel: ctx.can(VISIT_PERMISSIONS.cancel),
        changeShift: ctx.can('clients_change_contact_shift'),
        replyNotifications: ctx.can(VISIT_PERMISSIONS.reply),
        changeStatus: canChangeStatus,
        statusNeedsApproval,
        stageNeedsApproval,
      },
      statusApprovers,
      stageApprovers,
      contacts,
      notes: notes.rows.map((n) => this.notesService.presentNote(n, null, false, false)),
      competitorsObserved: observed.map((o) => ({ competitorId: o.competitorId, name: o.name, assetCount: o.assetCount, photoUrl: this.images.url(MEDIA.competitors, o.photoPath) })),
      competitorOptions,
      clientNotifications: clientNotifications.map(({ userId: _u, clientId: _c, ...n }) => n),
      visitDocuments: visitDocs,
      clientDocuments: grouped,
    };
  }

  /** مستندات الزيارة (نافذتها ومنشئوها) أو آخر مستندات العميل */
  private documents(ctx: ClientsContext, visit: VisitRow, visitOnly: boolean) {
    return this.visits.documents({
      clientId: visit.clientId,
      creators: [...new Set([visit.employeeId, ctx.user.id])],
      since: visit.startedAt,
      until: visit.departureTime,
      visitOnly,
      limit: DOCS_LIMIT,
    });
  }

  /** يجد زيارة اليوم المفتوحة لهذا العميل أو يُنشئها — ويعيدها كاملة */
  async open(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.workspace]);
    const client = await this.clients.find(clientId);
    if (!client) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await this.visibility.assertAccess(ctx, client.id, 'لا يمكنك فتح زيارة لعميلٍ غير مسموح لك بالوصول إليه.');

    let visit = await this.visits.openToday(ctx.user.id, client.id, ctx.today);
    let created = false;

    if (!visit) {
      const location = (await this.clients.extras([client])).get(client.id)?.location ?? null;
      // نقرٌ مزدوج على «فتح الزيارة»: الطلب الثاني ينتظر قفل صفّ العميل ثم يجد زيارة الأوّل
      const opened = await this.uow.run(async (tx) => {
        await this.visits.lockClient(client.id, tx);
        const existing = await this.visits.openToday(ctx.user.id, client.id, ctx.today, tx);
        if (existing) return { id: existing.id, created: false };
        const id = await this.clients.createVisit(
          {
            employee_id: ctx.user.id,
            client_id: client.id,
            visit_date: ctx.nowSql,
            visit_number: await this.numbers.next('visit', ctx.now, tx),
            client_latitude: location?.latitude ?? null,
            client_longitude: location?.longitude ?? null,
            recording_method: 'manual',
            is_approved: 0,
            stage: 'arrived',
            created_at: ctx.nowSql,
            updated_at: ctx.nowSql,
          },
          tx,
        );
        return { id, created: true };
      });
      created = opened.created;
      const visitId = opened.id;
      if (created) await this.log.record(ctx, 'visit_registered', visitId, `فتح زيارة للعميل «${client.tradeName ?? ''}» — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
      visit = (await this.visits.find(visitId))!;
    } else if (!(visit.recordingMethod === 'manual' || visit.startedAt !== null)) {
      // زيارةٌ سجّلها التتبّع الآلي تُتبنّى فلا يغلقها الانصراف التلقائي
      await this.visits.update(visit.id, { recording_method: 'manual', updated_at: ctx.nowSql });
      visit = (await this.visits.find(visit.id))!;
    }

    return { data: await this.payload(ctx, visit), message: created ? 'فُتحت زيارة جديدة — اضغط «بدء الزيارة» من موقع العميل.' : null, created };
  }

  /**
   * الزيارة التي تقفل التنقّل الآن (أو null) — نفس شرط `LockToOpenVisit` في الويب: زيارة المستخدم نفسه،
   * بتاريخ اليوم، بدأت ولم تُنهَ ولم تُلغَ. لا صلاحية مطلوبة: القفل يسري على كل من بدأ زيارة.
   */
  async current(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta);
    const visit = await this.visits.startedOpenToday(ctx.user.id, ctx.today);
    if (!visit) return null;
    return { ...this.timer(ctx, visit), clientId: visit.clientId, visitDate: visit.visitDate };
  }

  /**
   * سند قبضٍ ماليّ من مستندات العميل في الزيارة. قائمة سندات القبض تُقيَّد بمنشئها (سنداتي وفريقي)،
   * ومستندات الزيارة تعرض كلّ سندات العميل — فالسند هنا يُجاز بالزيارة نفسها: صاحبها (أو من يتتبّع
   * الزيارات) يرى سندات عميلها، بصلاحية عرض سندات القبض.
   */
  async receipt(userId: number, meta: RequestMeta, visitId: number, receiptId: number) {
    const { visit } = await this.load(userId, meta, visitId, ['account.incomes.view']);
    const receipt = await this.visits.clientReceipt(receiptId, visit.clientId);
    if (!receipt) throw AppError.notFound('RECEIPT_NOT_FOUND', 'السند غير موجود لهذا العميل.');
    return receipt;
  }

  async show(userId: number, meta: RequestMeta, visitId: number) {
    const { ctx, visit } = await this.load(userId, meta, visitId);
    return this.payload(ctx, visit);
  }

  async start(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>) {
    const { ctx, visit } = await this.load(userId, meta, visitId);
    const closed = this.closedMessage(visit);
    if (closed) throw new AppError('VISIT_CLOSED', closed, 422);
    if (visit.startedAt) return { data: this.timer(ctx, visit), message: 'الزيارة بدأت من قبل.' };

    const client = await this.clients.find(visit.clientId);
    const errors = new FieldErrors();
    const { lat, lng } = await this.checkLocation(ctx, visit, client, new FormInput(body, errors), errors, 'لبدء الزيارة');
    errors.throwIfAny();
    await this.outOfRange(ctx, visit, client, lat, lng, 'لبدء الزيارة');

    const now = ctx.nowSql;
    // مشروطٌ بألّا تكون بدأت: النقر المزدوج لا يُسجّل البدء مرّتين
    if (!(await this.visits.updateIf(visit.id, 'notStarted', { started_at: now, arrival_time: now, stage: 'in_progress', employee_latitude: lat, employee_longitude: lng, updated_at: now }))) {
      const current = (await this.visits.find(visit.id))!;
      if (current.departureTime) throw new AppError('VISIT_CLOSED', this.closedMessage(current)!, 422);
      return { data: this.timer(ctx, current), message: 'الزيارة بدأت من قبل.' };
    }
    await this.visits.markStartedFor(visit.employeeId, visit.clientId, (visit.visitDate ?? ctx.today).slice(0, 10), now);
    await this.log.record(ctx, 'visit_started', visit.id, `بدء زيارة العميل «${client?.tradeName ?? visit.clientId}» — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);

    const fresh = (await this.visits.find(visit.id))!;
    await this.notifyArrivalOrDeparture(ctx, fresh, 'arrival');
    return { data: this.timer(ctx, fresh), message: 'بدأت الزيارة.' };
  }

  /** إيقاف/استئناف المؤقّت — حين يخرج المندوب من نطاق العميل ويعود */
  async togglePause(userId: number, meta: RequestMeta, visitId: number) {
    const { ctx, visit } = await this.load(userId, meta, visitId);
    this.writeBlock(visit);

    const now = ctx.nowSql;
    if (this.isPaused(visit)) {
      const paused = parseLocal(visit.pausedAt)!;
      await this.visits.update(visit.id, { total_paused_seconds: visit.totalPausedSeconds + Math.trunc(diffInSecondsAbs(paused, ctx.now)), paused_at: null, stage: 'in_progress', updated_at: now });
    } else {
      await this.visits.update(visit.id, { paused_at: now, stage: 'paused', updated_at: now });
    }

    const fresh = (await this.visits.find(visit.id))!;
    const paused = this.isPaused(fresh);
    await this.log.record(ctx, paused ? 'visit_paused' : 'visit_resumed', visit.id, `${paused ? 'إيقاف مؤقّت لزيارة العميل #' : 'استئناف زيارة العميل #'}${visit.clientId} — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
    return { data: this.timer(ctx, fresh), message: paused ? 'أُوقف مؤقّت الزيارة.' : 'استُؤنفت الزيارة.' };
  }

  // ═══════════════════════ الخطوات ═══════════════════════

  /** الخطوة الأولى — إضافة مسؤول العميل (بدوامه) */
  async storeContact(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [[...CLIENT_PERMISSIONS.notesAdd]]);
    this.writeBlock(visit);

    const contact = await this.notesService.createContact(ctx, visit.clientId, body, files, VISIT_LOG_MODULE);
    return { data: { ...this.notesService.presentContact(contact), steps: await this.steps(ctx, visit, ctx.user.id) }, message: 'تمت إضافة مسؤول العميل.' };
  }

  /** الخطوة الثانية — دوام مسؤولٍ مسجَّل؛ تغييره بعد أوّل تسجيل يحتاج صلاحية */
  async storeContactShift(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>) {
    const { ctx, visit } = await this.load(userId, meta, visitId);
    this.writeBlock(visit);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const contactId = input.integer('clientEmployeeId', { required: true, message: 'اختر المسؤول الذي تسجّل دوامه.' });
    const contact = contactId !== null ? await this.notes.contactOfClient(contactId, visit.clientId) : null;
    if (contactId !== null && !contact) errors.add('clientEmployeeId', 'هذا المسؤول لا يتبع هذا العميل.');
    const shift = input.string('shift', { required: true });
    const range = shift !== null ? parseShiftRange(shift) : null;
    if (shift !== null && !range) errors.add('shift', SHIFT_INVALID);
    errors.throwIfAny();

    const wasSet = hasShift(contact!.shiftStart, contact!.shiftEnd);
    if (wasSet && !ctx.can('clients_change_contact_shift')) {
      throw AppError.forbidden('SHIFT_LOCKED', 'دوام هذا المسؤول مسجَّل من قبل، وتغييره يحتاج صلاحية «تغيير دوام مسؤول العميل بعد تسجيله».');
    }

    const [start, end] = range!;
    await this.visits.updateContactShift(contact!.id, start, end, ctx.nowSql);
    await this.log.record(
      ctx,
      wasSet ? 'visit_contact_shift_changed' : 'visit_contact_shift_set',
      visit.id,
      `${wasSet ? 'تغيير دوام مسؤول العميل «' : 'تسجيل دوام مسؤول العميل «'}${contact!.employeeName}» (${start} — ${end}) — من تطبيق الجوال`,
      {},
      undefined,
      VISIT_LOG_MODULE,
    );

    const fresh = (await this.notes.contactOfClient(contact!.id, visit.clientId))!;
    return {
      data: { ...this.notesService.presentContact(fresh), steps: await this.steps(ctx, visit, ctx.user.id) },
      message: wasSet ? 'تم تغيير دوام المسؤول.' : 'تم تسجيل دوام المسؤول — أكمل الزيارة.',
    };
  }

  /** الخطوة الثالثة — ملاحظة الزيارة مع دوام المسؤول (يُسجَّل أوّل مرّة، أو يُعدَّل بصلاحية) */
  async storeNote(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [[...CLIENT_PERMISSIONS.notesAdd]]);
    this.writeBlock(visit);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const contactId = input.integer('clientEmployeeId', { required: true, message: 'اختر مسؤول العميل الذي قابلته.' });
    const contact = contactId !== null ? await this.notes.contactOfClient(contactId, visit.clientId) : null;
    if (contactId !== null && !contact) errors.add('clientEmployeeId', 'المسؤول المختار لا يتبع هذا العميل.');
    errors.throwIfAny();

    const submitted = String(body.shift ?? '').trim();
    let newShift: [string, string] | null = null;
    const current = shiftRangeValue(contact!.shiftStart, contact!.shiftEnd);
    const wasSet = hasShift(contact!.shiftStart, contact!.shiftEnd);

    if (submitted !== '' && submitted !== current) {
      newShift = parseShiftRange(submitted);
      if (!newShift) throw AppError.validation({ shift: ['فترة الدوام غير صالحة.'] }, SHIFT_INVALID);
      if (wasSet && !ctx.can('clients_change_contact_shift')) {
        throw AppError.forbidden('SHIFT_LOCKED', `دوام «${contact!.employeeName}» مسجَّل من قبل، وتغييره يحتاج صلاحية «تغيير دوام مسؤول العميل بعد تسجيله».`);
      }
    } else if (!wasSet) {
      throw AppError.validation({ shift: ['دوام المسؤول مطلوب.'] }, `اختر دوام المسؤول «${contact!.employeeName}» — يُسجَّل مع هذه الملاحظة.`);
    }

    const [start, end] = newShift ?? [contact!.shiftStart!, contact!.shiftEnd!];
    const client = (await this.clients.find(visit.clientId))!;
    const noteId = await this.notesService.createNote(ctx, client, body, files, { shiftStart: start, shiftEnd: end, competitorDocuments: 0 });

    if (newShift) {
      await this.visits.updateContactShift(contact!.id, start, end, ctx.nowSql);
      await this.log.record(
        ctx,
        wasSet ? 'visit_contact_shift_changed' : 'visit_contact_shift_set',
        visit.id,
        `${wasSet ? 'تغيير دوام مسؤول العميل «' : 'تسجيل دوام مسؤول العميل «'}${contact!.employeeName}» (${start} — ${end}) مع ملاحظة الزيارة — من تطبيق الجوال`,
        {},
        undefined,
        VISIT_LOG_MODULE,
      );
    }

    return { data: { noteId, steps: await this.steps(ctx, visit, ctx.user.id) }, message: 'سُجّلت ملاحظة الزيارة.' };
  }

  /** الخطوة الرابعة — رصد المنافسين: منافسٌ + عدد قطع عهدته + صورته لكل صف، أو «لا يوجد منافس» بصورة */
  async storeCompetitors(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [[...CLIENT_PERMISSIONS.notesAdd]]);
    this.writeBlock(visit);

    if (!ctx.settings.competitorCaptureEnabled()) throw new AppError('STEP_DISABLED', 'رصد المنافسين غير مفعَّل في إعدادات الزيارات — تجاوز هذه الخطوة.', 422);
    if (!(await this.steps(ctx, visit, ctx.user.id)).hasNote) throw new AppError('NOTE_REQUIRED', 'سجّل ملاحظة الزيارة أولاً — رصد المنافسين يأتي بعدها.', 422);

    const maxKb = ctx.settings.maxUploadSizeKb();
    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const none = input.boolean('noCompetitors') === true;
    const fileAt = (field: string) => files.find((f) => f.fieldname === field) ?? null;
    const rows: Array<{ competitorId: number; assetCount: number; photo: UploadedFile }> = [];
    let nonePhoto: UploadedFile | null = null;

    if (none) {
      nonePhoto = fileAt('noCompetitorsPhoto');
      if (!nonePhoto) errors.add('noCompetitorsPhoto', 'صورة إثبات البحث إلزامية عند اختيار «لا يوجد منافس».');
      else checkImage(errors, 'noCompetitorsPhoto', nonePhoto, ['jpeg', 'png', 'webp'], maxKb);
    } else {
      const list = input.array('competitors', { required: true, min: 1, max: 30, message: 'اختر منافساً واحداً على الأقل وعدد قطع عهدته — أو أرسل noCompetitors=1 مع صورة.' }) ?? [];
      const ids = list.map((item) => Number((item as Record<string, unknown>)?.competitorId));
      const active = await this.visits.activeCompetitors(ids.filter((id) => Number.isInteger(id)));
      const seen = new Set<number>();
      list.forEach((item, i) => {
        const row = input.child(item, `competitors.${i}`);
        const competitorId = row.integer('competitorId', { required: true, message: 'اختر المنافس في كل صفّ.' });
        const assetCount = row.integer('assetCount', { required: true, min: 0, max: 100000, message: 'اكتب عدد قطع عهدة كل منافس (0 إن لا عهدة له).' });
        const photo = fileAt(`competitors[${i}][photo]`);
        if (competitorId !== null) {
          if (seen.has(competitorId)) errors.add(`competitors.${i}.competitorId`, 'لا تختر المنافس نفسه مرّتين.');
          else if (!active.has(competitorId)) errors.add(`competitors.${i}.competitorId`, 'أحد المنافسين المختارين غير موجودٍ أو معطَّل.');
          seen.add(competitorId);
        }
        if (!photo) errors.add(`competitors.${i}.photo`, 'صورة المنافس إلزامية لكل صف.');
        else checkImage(errors, `competitors.${i}.photo`, photo, ['jpeg', 'png', 'webp'], maxKb);
        if (competitorId !== null && assetCount !== null && photo) rows.push({ competitorId, assetCount, photo });
      });
    }
    errors.throwIfAny();

    const noteId = await this.visits.latestNoteIdSince(visit.clientId, ctx.user.id, visit.startedAt!);
    const scope = await this.visits.observationScope(visit.id, noteId, ctx.user.id);
    const names = none ? new Map<number, string>() : await this.visits.activeCompetitors(rows.map((r) => r.competitorId));
    const stored: string[] = [];
    let saved = 0;

    try {
      await this.uow.run(async (tx) => {
        const now = ctx.nowSql;
        const base = { visit_id: visit.id, client_relation_id: noteId, client_id: visit.clientId, employee_id: ctx.user.id, created_at: now, updated_at: now };
        if (none) {
          if (scope.any) return;
          const photo = await this.images.savePhoto(MEDIA.competitors, nonePhoto!);
          stored.push(photo);
          await this.visits.insertObservation({ ...base, competitor_id: null, competitor_name: 'لا يوجد منافس', asset_count: 0, photo_path: photo }, tx);
          saved = 1;
          return;
        }
        for (const row of rows) {
          if (scope.competitorIds.includes(row.competitorId)) continue;
          const photo = await this.images.savePhoto(MEDIA.competitors, row.photo);
          stored.push(photo);
          await this.visits.insertObservation({ ...base, competitor_id: row.competitorId, competitor_name: names.get(row.competitorId) ?? '', asset_count: row.assetCount, photo_path: photo }, tx);
          saved++;
        }
      });
    } catch (e) {
      for (const file of stored) await this.images.delete(MEDIA.competitors, file);
      throw e;
    }

    if (noteId) await this.visits.setNoteCompetitorDocuments(noteId, await this.visits.countNoteCompetitors(noteId));

    await this.log.record(
      ctx,
      'visit_competitors_observed',
      visit.id,
      none ? `رصد المنافسين للعميل #${visit.clientId}: لا يوجد منافس — من تطبيق الجوال` : `رصد ${saved} منافساً عند العميل #${visit.clientId} — من تطبيق الجوال`,
      {},
      undefined,
      VISIT_LOG_MODULE,
    );

    return {
      data: { saved, steps: await this.steps(ctx, visit, ctx.user.id) },
      message: saved ? 'تم رصد المنافسين — المستندات مفتوحة الآن.' : 'لا جديد — المنافسون مرصودون في هذه الزيارة من قبل.',
    };
  }

  /** منافسٌ جديد يضيفه المندوب من داخل الزيارة */
  async storeQuickCompetitor(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [[...CLIENT_PERMISSIONS.notesAdd]]);
    this.writeBlock(visit);

    const errors = new FieldErrors();
    const name = (new FormInput(body, errors).string('name', { required: true, max: 255, message: 'اكتب اسم المنافس.' }) ?? '').trim();
    errors.throwIfAny();

    const existing = await this.visits.competitorByName(name);
    if (existing) {
      if (!existing.isActive) throw new AppError('COMPETITOR_DISABLED', `المنافس «${existing.name}» معطَّل في القائمة — راجع مدير النظام لتفعيله.`, 422);
      return { data: { id: existing.id, name: existing.name, existed: true }, message: `المنافس «${existing.name}» موجودٌ في القائمة — اخترناه لك.`, created: false };
    }

    const id = await this.visits.insertCompetitor({ name, is_active: 1, notes: `أُضيف من زيارة العميل #${visit.clientId} (تطبيق الجوال)`, created_at: ctx.nowSql, updated_at: ctx.nowSql });
    await this.log.record(ctx, 'competitor_added_from_visit', visit.id, `إضافة منافس «${name}» من مساحة عمل الزيارة — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
    return { data: { id, name, existed: false }, message: `أُضيف «${name}» إلى قائمة المنافسين.`, created: true };
  }

  // ═══════════════════════ إشعارات الإدارة عن العميل ═══════════════════════

  private async ownedNotification(ctx: ClientsContext, visit: VisitRow, id: number) {
    const row = await this.visits.ownedClientNotification(id, visit.clientId, ctx.user.id);
    if (!row) throw AppError.notFound('NOTIFICATION_NOT_FOUND', 'الإشعار غير موجود.');
    return row;
  }

  async readNotification(userId: number, meta: RequestMeta, visitId: number, notificationId: number) {
    const { ctx, visit } = await this.load(userId, meta, visitId);
    const row = await this.ownedNotification(ctx, visit, notificationId);
    await this.visits.markNotificationRead(row.id, ctx.nowSql);
    await this.log.record(ctx, 'client_notification_read', visit.id, `اطّلاع على إشعار العميل «${row.title ?? ''}» — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
    return { data: { id: row.id, read: true }, message: 'عُلِّم الإشعار مقروءاً.' };
  }

  async replyNotification(userId: number, meta: RequestMeta, visitId: number, notificationId: number, body: Record<string, unknown>) {
    const errors = new FieldErrors();
    const message = new FormInput(body, errors).string('replyMessage', { required: true, max: 500, message: 'اكتب نصّ الردّ.' });
    const { ctx, visit } = await this.load(userId, meta, visitId, [VISIT_PERMISSIONS.reply]);
    errors.throwIfAny();

    const original = await this.ownedNotification(ctx, visit, notificationId);
    await this.uow.run(async (tx) => {
      await this.notifications.send(
        { userId: ctx.user.id, receiverId: original.userId, title: `رد عميل: ${original.title ?? ''}`, description: message, type: 'reply', clientId: original.clientId, read: false, isSent: true, parentId: original.id },
        ctx.now,
        tx,
      );
      await this.visits.markNotificationRead(original.id, ctx.nowSql, tx);
    });
    await this.log.record(ctx, 'client_notification_replied', visit.id, `ردٌّ على إشعار العميل «${original.title ?? ''}» — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
    return { data: { id: original.id }, message: 'أُرسل ردّك.' };
  }

  // ═══════════════════════ الإنهاء والإلغاء ═══════════════════════

  /** إنهاء الزيارة — بعد اكتمال خطواتها ومن موقع العميل؛ «سأعود» يكفيه المسؤول ودوامه والملاحظة */
  async complete(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [VISIT_PERMISSIONS.complete]);
    this.writeBlock(visit);

    const client = await this.clients.find(visit.clientId);
    const signatureRequired = ctx.settings.signatureRequired();
    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const clientSignature = input.string('clientSignature', { required: signatureRequired, max: 3_000_000, message: 'توقيع العميل إلزامي (إعدادات الزيارات).' });
    const employeeSignature = input.string('employeeSignature', { required: signatureRequired, max: 3_000_000, message: 'توقيعك إلزامي (إعدادات الزيارات).' });
    const outcomeNotes = input.string('outcomeNotes', { max: 2000 });
    const returnLater = input.boolean('returnLater') === true;
    let returnTime: string | null = null;
    if (returnLater) {
      returnTime = input.string('returnTime', { required: true, message: 'حدّد وقت العودة المتوقَّع لهذا العميل (HH:MM).' });
      if (returnTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(returnTime)) errors.add('returnTime', 'اكتب وقت العودة بصيغة 24 ساعة مثل 18:30.');
    } else if (input.filled('returnTime') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.raw('returnTime')))) {
      errors.add('returnTime', 'اكتب وقت العودة بصيغة 24 ساعة مثل 18:30.');
    }
    const { lat, lng } = await this.checkLocation(ctx, visit, client, input, errors, 'لإنهاء الزيارة');
    errors.throwIfAny();

    const steps = await this.steps(ctx, visit, ctx.user.id);
    if (!(returnLater ? steps.canReturn : steps.canComplete)) {
      throw new AppError('STEPS_INCOMPLETE', `لا يمكن إنهاء الزيارة قبل إتمام خطواتها: ${this.missingStepMessage(steps, returnLater)}`, 422, { steps });
    }
    await this.outOfRange(ctx, visit, client, lat, lng, 'لإنهاء الزيارة');

    const clientSig = await this.images.saveSignature(clientSignature, 'client');
    const employeeSig = await this.images.saveSignature(employeeSignature, 'employee');
    if (signatureRequired && (!clientSig || !employeeSig)) {
      await this.images.delete(MEDIA.signatures, clientSig);
      await this.images.delete(MEDIA.signatures, employeeSig);
      throw new AppError('BAD_SIGNATURE', 'التوقيع يجب أن يكون صورةً (data:image/png;base64,...).', 422);
    }

    const now = ctx.nowSql;
    const closedNow = await this.visits.updateIf(visit.id, 'open', {
      departure_time: now,
      stage: 'completed',
      outcome: steps.outcome,
      outcome_notes: outcomeNotes ?? visit.outcomeNotes,
      client_signature_path: clientSig,
      employee_signature_path: employeeSig,
      updated_at: now,
    });
    if (!closedNow) {
      await this.images.delete(MEDIA.signatures, clientSig);
      await this.images.delete(MEDIA.signatures, employeeSig);
      throw new AppError('VISIT_CLOSED', 'هذه الزيارة مغلقة (أُنهيت أو أُلغيت) — افتح زيارةً جديدة للعميل.', 422);
    }

    const fresh = (await this.visits.find(visit.id))!;
    const durationMinutes = Math.round(this.elapsedSeconds(fresh, ctx.now) / 60);
    await this.visits.markCompletedFor(visit.employeeId, visit.clientId, (visit.visitDate ?? ctx.today).slice(0, 10), now, durationMinutes);

    if (returnLater) {
      try {
        await this.itinerary.createReturnRow(ctx, visit.employeeId, visit.clientId, returnTime);
        await this.log.record(ctx, 'visit_return_scheduled', visit.id, `جدولة عودة إلى العميل #${visit.clientId} الساعة ${returnTime ?? ''} — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);
      } catch (e) {
        await this.log.failure(ctx, e, 'schedule_return_visit', visit.id, VISIT_LOG_MODULE);
      }
    }

    await this.log.record(
      ctx,
      'visit_completed',
      visit.id,
      `إنهاء زيارة العميل «${client?.tradeName ?? visit.clientId}» — ${steps.outcome === 'success' ? 'ناجحة (فاتورة أو تحصيل)' : 'سلبيّة (بلا فاتورة ولا تحصيل)'} — من تطبيق الجوال`,
      {},
      undefined,
      VISIT_LOG_MODULE,
    );
    await this.notifyArrivalOrDeparture(ctx, fresh, 'departure');

    let message = steps.outcome === 'success' ? 'انتهت الزيارة — زيارة ناجحة (سُجّلت فاتورة أو تحصيل).' : 'انتهت الزيارة — زيارة سلبيّة (بلا فاتورة ولا تحصيل).';
    if (returnLater) message += ' وسُجّلت لك عودةٌ إليه اليوم.';
    else if (ctx.settings.hideFinishedVisitClients() && !ctx.can('clients_view_all_clients')) message += ' أُخفي العميل من قائمتك بقيّة اليوم.';

    return { data: { visitId: visit.id, outcome: steps.outcome, durationMinutes, returnLater }, message };
  }

  /** إلغاء الزيارة — بسببٍ مكتوب ومن موقع العميل، ومتاحٌ قبل البدء أيضاً */
  async cancel(userId: number, meta: RequestMeta, visitId: number, body: Record<string, unknown>) {
    const { ctx, visit } = await this.load(userId, meta, visitId, [VISIT_PERMISSIONS.cancel]);
    const closed = this.closedMessage(visit);
    if (closed) throw new AppError('VISIT_CLOSED', closed, 422);

    const client = await this.clients.find(visit.clientId);
    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const reason = input.string('cancelReason', { required: true, max: 255, message: 'اكتب سبب إلغاء الزيارة — هو كلّ ما يبقى منها في التقرير.' });
    const { lat, lng } = await this.checkLocation(ctx, visit, client, input, errors, 'لإلغاء الزيارة');
    errors.throwIfAny();
    await this.outOfRange(ctx, visit, client, lat, lng, 'لإلغاء الزيارة');

    const now = ctx.nowSql;
    if (!(await this.visits.updateIf(visit.id, 'open', { departure_time: now, stage: 'cancelled', cancel_reason: reason, employee_latitude: lat, employee_longitude: lng, updated_at: now }))) {
      throw new AppError('VISIT_CLOSED', 'هذه الزيارة مغلقة (أُنهيت أو أُلغيت) — افتح زيارةً جديدة للعميل.', 422);
    }
    await this.log.record(ctx, 'visit_cancelled', visit.id, `إلغاء زيارة العميل «${client?.tradeName ?? visit.clientId}» — من تطبيق الجوال`, {}, undefined, VISIT_LOG_MODULE);

    return { data: { visitId: visit.id }, message: 'أُلغيت الزيارة.' };
  }
}

