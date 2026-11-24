import { AppError } from '../../../domain/errors/AppError';
import { ForgottenVisitRepository, ForgottenVisitRow, JustificationRepository, JustificationRow } from '../../../domain/repositories/followup';
import { VisitRepository } from '../../../domain/repositories/visits';
import { addHours, diffInSecondsAbs, parseLocal, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { UnitOfWork } from '../../ports';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog, NotificationGate } from '../../services/clients/ClientsSupport';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';

export const FORGOTTEN_AFTER_HOURS = 4;
const FORGOTTEN_LOG = 'ClientVisits';
const JUSTIFICATION_LOG = 'VisitJustification';
const EXEMPT = 'staff_visit_justification_exempt';

export const FOLLOW_UP_PERMISSIONS = {
  forgottenView: ['clients_view_forgotten_visits_own', 'clients_view_forgotten_visits_all'],
  forgottenClose: ['clients_close_forgotten_visits_own', 'clients_force_close_forgotten_visits'],
  forgottenCancel: 'clients_cancel_forgotten_visits',
  justificationsView: ['clients_visit_justifications_view_own', 'clients_visit_justifications_view_all'],
} as const;

/** أقصى طول تبرير — عمود `justification` في القاعدة `varchar(250)` */
const JUSTIFICATION_MAX = 250;

/**
 * المتابعة بعد الزيارة: الزيارات المنسيّة (`ForgottenVisitController`) وتبريرات
 * الزيارات غير المكتملة (`JustificationController`) — بقواعد الويب نفسها.
 */
export class FollowUpUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly forgotten: ForgottenVisitRepository,
    private readonly justifications: JustificationRepository,
    private readonly visits: VisitRepository,
    private readonly notifications: NotificationGate,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
  ) {}

  // ═══════════════════════ الزيارات المنسيّة ═══════════════════════

  private threshold(ctx: ClientsContext) {
    return toSqlDateTime(addHours(ctx.now, -FORGOTTEN_AFTER_HOURS));
  }

  /** `TeamScope::covers()` */
  private async covers(ctx: ClientsContext, userId: number) {
    if (userId === ctx.user.id) return true;
    const team = await ctx.teamUserIds();
    return team === null || team.includes(userId);
  }

  async forgottenList(userId: number, meta: RequestMeta, requested: 'own' | 'all' = 'own') {
    const ctx = await this.contexts.load(userId, meta, [...FOLLOW_UP_PERMISSIONS.forgottenView]);
    const scope = requested === 'all' && ctx.can('clients_view_forgotten_visits_all') ? 'all' : 'own';
    const team = scope === 'all' ? await ctx.teamUserIds() : [ctx.user.id];

    const rows = await this.forgotten.list(this.threshold(ctx), ctx.today, team, 200);
    return {
      scope,
      count: rows.length,
      visits: rows.map((v) => ({
        id: v.id,
        visitNumber: v.visitNumber,
        visitDate: v.visitDate ? v.visitDate.slice(0, 10) : null,
        startedAt: v.startedAt,
        stage: v.stage,
        employee: { id: v.employeeId, name: v.employeeName },
        client: v.clientName !== null ? { id: v.clientId, tradeName: v.clientName, code: v.clientCode } : null,
        isOwn: v.employeeId === ctx.user.id,
      })),
    };
  }

  private async findForgotten(ctx: ClientsContext, id: number): Promise<ForgottenVisitRow> {
    const row = await this.forgotten.find(id, this.threshold(ctx), ctx.today);
    if (!row) throw AppError.notFound('VISIT_NOT_FOUND', 'الزيارة المنسيّة غير موجودة.');
    return row;
  }

  private elapsedMinutes(row: ForgottenVisitRow, departure: Date) {
    const started = parseLocal(row.startedAt);
    if (!started) return 0;
    let elapsed = diffInSecondsAbs(departure, started) - row.totalPausedSeconds;
    const paused = parseLocal(row.pausedAt);
    if (paused) elapsed -= diffInSecondsAbs(departure, paused);
    return Math.round(Math.max(0, elapsed) / 60);
  }

  async closeForgotten(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta, [...FOLLOW_UP_PERMISSIONS.forgottenClose]);
    const row = await this.findForgotten(ctx, id);
    const own = row.employeeId === ctx.user.id;

    if (own && !ctx.can('clients_close_forgotten_visits_own')) throw AppError.forbidden('FORBIDDEN', 'غير مصرّح لك بإنهاء زياراتك المنسيّة.');
    if (!own && (!ctx.can('clients_force_close_forgotten_visits') || !(await this.covers(ctx, row.employeeId)))) {
      throw AppError.forbidden('FORBIDDEN', 'غير مصرّح لك بإنهاء زيارات هذا الموظف.');
    }

    const errors = new FieldErrors();
    const notes = new FormInput(body, errors).string('notes', { max: 1000 });
    errors.throwIfAny();

    const before = { stage: row.stage, departure_time: row.departureTime, outcome: row.outcome, outcome_notes: row.outcomeNotes };
    const now = ctx.nowSql;
    await this.visits.update(row.id, { stage: 'completed', departure_time: now, outcome: 'successful', outcome_notes: notes ?? 'تم إنهاء الزيارة عن بُعد — الموظف لم يعد متاحاً', updated_at: now });

    // مدّةٌ معقولة وحدها تُكتب — زيارةٌ تُركت أيّاماً ليست زيارةً دامت أيّاماً
    const minutes = this.elapsedMinutes(row, ctx.now);
    await this.visits.markCompletedFor(row.employeeId, row.clientId, (row.visitDate ?? ctx.today).slice(0, 10), now, minutes <= FORGOTTEN_AFTER_HOURS * 60 ? minutes : null);

    await this.log.record(ctx, 'closed_forgotten', row.id, `إنهاء زيارة منسيّة: ${row.clientName ?? `#${row.clientId}`} (الموظف: ${row.employeeName ?? ''}) — من تطبيق الجوال`, { old: before }, undefined, FORGOTTEN_LOG);

    if (!own) {
      await this.notifications.send(
        {
          userId: ctx.user.id,
          receiverId: row.employeeId,
          clientId: row.clientId,
          type: 'forgotten_visit_closed',
          title: 'تم إنهاء زيارة منسيّة',
          description: `أنهى ${ctx.user.name} الزيارة المنسيّة عند العميل ${row.clientName ?? ''} (بتاريخ ${(row.visitDate ?? '').slice(0, 10)})`,
          read: false,
        },
        ctx.now,
      );
    }

    return { data: { visitId: row.id }, message: 'أُنهيت الزيارة المنسيّة.' };
  }

  async cancelForgotten(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta, FOLLOW_UP_PERMISSIONS.forgottenCancel);
    const row = await this.findForgotten(ctx, id);
    const own = row.employeeId === ctx.user.id;

    if (!own) {
      const managers = await this.forgotten.usersWithRoleNames(['admin', 'manager']);
      if (!managers.includes(ctx.user.id) || !(await this.covers(ctx, row.employeeId))) throw AppError.forbidden('FORBIDDEN', 'لا يمكنك إلغاء زيارة موظفٍ آخر.');
    }

    const errors = new FieldErrors();
    const reason = new FormInput(body, errors).string('cancelReason', { required: true, max: 500, message: 'اكتب سبب الإلغاء.' });
    errors.throwIfAny();

    const before = { stage: row.stage, cancel_reason: row.cancelReason };
    await this.visits.update(row.id, { stage: 'cancelled', cancel_reason: reason, departure_time: ctx.nowSql, updated_at: ctx.nowSql });
    await this.log.record(ctx, 'cancelled_forgotten', row.id, `إلغاء زيارة منسيّة: ${row.clientName ?? `#${row.clientId}`} — من تطبيق الجوال`, { old: before }, undefined, FORGOTTEN_LOG);

    return { data: { visitId: row.id }, message: 'أُلغيت الزيارة المنسيّة.' };
  }

  // ═══════════════════════ التبريرات ═══════════════════════

  private present(v: JustificationRow) {
    const approved = v.justificationApproved;
    return {
      id: v.id,
      visitDate: v.visitDate,
      client: v.client,
      justification: v.justification,
      justificationDate: v.justificationDate,
      status: approved === 1 ? 'approved' : approved === 2 ? 'rejected' : 'pending',
      approvedBy: v.approvedBy,
    };
  }

  /** الزيارات التي تنتظر تبريراً مني، وعدد ما قُدّم وينتظر الاعتماد */
  async pending(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta);
    if (ctx.can(EXEMPT)) return { exempt: true, pendingCount: 0, awaitingApproval: 0, visits: [] };

    const [rows, awaiting] = await Promise.all([this.justifications.needing(ctx.user.id, ctx.today), this.justifications.awaitingApprovalCount(ctx.user.id, ctx.today)]);
    return {
      exempt: false,
      pendingCount: rows.length,
      awaitingApproval: awaiting,
      visits: rows.map((v) => ({ id: v.id, visitDate: v.visitDate, dayOfWeek: v.dayOfWeek, client: v.client })),
    };
  }

  /** تبريرٌ لكل زيارة: `justifications: { "<رقم صفّ خطّ السير>": "النص" }` */
  async submit(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta);
    if (ctx.can(EXEMPT)) throw new AppError('EXEMPT', 'أنت معفى من تقديم تبريرات الزيارات.', 422);

    const errors = new FieldErrors();
    const raw = body?.justifications;
    const entries: Array<[number, string]> = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
      errors.add('justifications', 'أرسل تبريراً لزيارة واحدة على الأقل.');
    } else if (Object.keys(raw).length > 200) {
      errors.add('justifications', 'حقل «التبريرات» يجب ألّا يحوي أكثر من 200 عنصر.');
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const field = `justifications.${key}`;
        const text = typeof value === 'string' ? value.trim() : '';
        if (!/^\d+$/.test(key)) errors.add(field, 'مفتاح التبرير رقم صفّ الزيارة.');
        else if (!text) errors.add(field, 'التبرير مطلوب لكل زيارة.');
        else if ([...text].length < 5) errors.add(field, 'التبرير 5 أحرف على الأقل.');
        else if ([...text].length > JUSTIFICATION_MAX) errors.add(field, `التبرير لا يتجاوز ${JUSTIFICATION_MAX} حرفاً.`);
        else entries.push([Number(key), text]);
      }
    }
    errors.throwIfAny();

    // لا يُبرَّر إلا ما ينتظر تبريراً مني فعلاً — لا زيارة غيري ولا زيارةٌ أُنجزت
    const eligible = new Map((await this.justifications.needing(ctx.user.id, ctx.today, entries.map(([id]) => id), 200)).map((r) => [r.id, r]));
    const done: number[] = [];
    const rejected: number[] = [];

    await this.uow.run(async (tx) => {
      for (const [id, text] of entries) {
        const visit = eligible.get(id);
        if (!visit) {
          rejected.push(id);
          continue;
        }
        await this.justifications.update(id, { justification: text, justification_date: ctx.nowSql, updated_at: ctx.nowSql }, tx);
        done.push(id);
        await this.log.record(ctx, 'visit_justification_submitted', id, `تقديم تبرير لزيارة العميل «${visit.client?.tradeName ?? visit.clientId}» غير المكتملة — من تطبيق الجوال`, {
          old: { justification: null },
          new: { justification: text },
        }, tx, JUSTIFICATION_LOG);
      }
    });

    if (!done.length) throw new AppError('NOTHING_ACCEPTED', 'لم يُقبل أيّ تبرير — الزيارات المرسلة ليست ممّا ينتظر تبريرك.', 422, { rejected });

    await this.notifyManagers(ctx, done.length);
    return {
      data: { submitted: done, rejected },
      message: `قُدّم ${done.length} تبرير — ستراجعه الإدارة.${rejected.length ? ` تُخطّي ${rejected.length} لا ينتظر تبريراً.` : ''}`,
    };
  }

  /** إشعار المدراء بتبريراتٍ جديدة — مستقبِلو الويب (admin/manager) */
  private async notifyManagers(ctx: ClientsContext, count: number) {
    try {
      for (const managerId of await this.justifications.managerIds()) {
        await this.notifications.send(
          { userId: ctx.user.id, receiverId: managerId, type: 'visit', title: 'تبرير زيارة جديد', description: `قدّم الموظف ${ctx.user.name} ${count} تبرير(ات) لزيارات غير مكتملة.`, read: false },
          ctx.now,
        );
      }
    } catch (e) {
      await this.log.failure(ctx, e, 'notify_managers', null, JUSTIFICATION_LOG);
    }
  }

  /** تبريراتي المقدَّمة بحالتها، وفترات الإعفاء الممنوحة لي */
  async index(userId: number, meta: RequestMeta, page = 1, perPage = 15) {
    const ctx = await this.contexts.load(userId, meta, [...FOLLOW_UP_PERMISSIONS.justificationsView]);
    const [{ rows, total }, periods] = await Promise.all([this.justifications.submitted(ctx.user.id, page, perPage), this.justifications.periods(ctx.user.id, 50)]);
    return { items: rows.map((r) => this.present(r)), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)), periods };
  }

  async show(userId: number, meta: RequestMeta, id: number) {
    const ctx = await this.contexts.load(userId, meta, [...FOLLOW_UP_PERMISSIONS.justificationsView]);
    const row = await this.justifications.own(ctx.user.id, id);
    if (!row) throw AppError.notFound('JUSTIFICATION_NOT_FOUND', 'الزيارة غير موجودة.');
    return this.present(row);
  }

  /** تعديل تبريرٍ لم يُعتمد بعد — والمرفوض يعود «بانتظار الاعتماد» */
  async update(userId: number, meta: RequestMeta, id: number, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta, [...FOLLOW_UP_PERMISSIONS.justificationsView]);
    if (ctx.can(EXEMPT)) throw new AppError('EXEMPT', 'أنت معفى من تقديم تبريرات الزيارات.', 422);

    const errors = new FieldErrors();
    const text = new FormInput(body, errors).string('justification', { required: true, max: JUSTIFICATION_MAX, message: 'التبرير مطلوب.' });
    if (text !== null && [...text].length < 5) errors.add('justification', 'التبرير 5 أحرف على الأقل.');
    errors.throwIfAny();

    const row = await this.justifications.own(ctx.user.id, id);
    if (!row) throw AppError.notFound('JUSTIFICATION_NOT_FOUND', 'الزيارة غير موجودة.');
    if (!row.justification) throw new AppError('NO_JUSTIFICATION', 'لا تبرير مقدَّماً لهذه الزيارة بعد — قدّمه أوّلاً.', 422);
    if (row.justificationApproved === 1) throw new AppError('ALREADY_APPROVED', 'اعتُمد هذا التبرير — لا يُعدَّل بعد الاعتماد.', 422);

    await this.justifications.update(row.id, {
      justification: text!.trim(),
      justification_date: ctx.nowSql,
      justification_approved: row.justificationApproved === 2 ? null : row.justificationApproved,
      updated_at: ctx.nowSql,
    });
    await this.log.record(ctx, 'visit_justification_updated', row.id, `تعديل تبرير زيارة العميل #${row.clientId} — من تطبيق الجوال`, {
      old: { justification: row.justification },
      new: { justification: text!.trim() },
    }, undefined, JUSTIFICATION_LOG);

    return { data: this.present((await this.justifications.own(ctx.user.id, row.id))!), message: 'تم تحديث التبرير.' };
  }
}
