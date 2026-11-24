import { randomBytes } from 'crypto';
import { AppError } from '../../../domain/errors/AppError';
import {
  ClientListFilters,
  ClientRepository,
  ClientRow,
  ClientsReferenceRepository,
  DateWindow,
  DocumentNumberRepository,
} from '../../../domain/repositories/clients';
import { BranchTree } from '../../../domain/services/clients/BranchTree';
import { kmBetween, round } from '../../../domain/services/clients/Geo';
import { addDays, addYears, endOfDay, startOfDay, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { FULL_TIME_LABEL, FULL_TIME_VALUE, shiftHourOptions } from '../../../domain/services/clients/ShiftRange';
import { getWeekAndYear, dayNameEn } from '../../../domain/services/clients/WeekCalendar';
import { Geocoder, Hasher, ImageStore, Tx, UnitOfWork } from '../../ports';
import { CLIENT_FIELD_COLUMNS, ClientForm, ValidatedClient } from '../../services/clients/ClientForm';
import { SITE_TYPES } from '../../services/clients/ClientNotesService';
import { ClientPresenter } from '../../services/clients/ClientPresenter';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog, CurrencyFormatter } from '../../services/clients/ClientsSupport';
import { ClientVisibility } from '../../services/clients/ClientVisibility';
import { UploadedFile } from '../../services/clients/FormInput';

// ─────────────────────────── الصلاحيات (مسارات وحدة العملاء في الويب حرفياً) ───────────────────────────

export const CLIENT_PERMISSIONS = {
  view: ['clients_view_all_clients', 'clients_view_own_clients', 'clients_view_by_employee_groups', 'clients_view_by_daily_itinerary'],
  workspace: ['clients_visits_track', 'clients_itinerary_add', 'clients_visit_workspace_access', 'clients_must_visit_before_view'],
  notesView: [
    'client_follow_up_view_notes_attachments_appointments_all',
    'client_follow_up_view_notes_attachments_appointments_assigned',
    'client_follow_up_view_notes_attachments_appointments_own',
  ],
  notesAdd: [
    'client_follow_up_add_notes_attachments_appointments_all',
    'client_follow_up_add_notes_attachments_appointments_assigned',
    'client_follow_up_add_notes_attachments_appointments_own',
    'clients_add_employee_note',
  ],
  notesEdit: [
    'client_follow_up_edit_delete_notes_attachments_appointments_all',
    'client_follow_up_edit_delete_notes_attachments_appointments_assigned',
    'client_follow_up_edit_delete_notes_attachments_appointments_own',
  ],
  form: ['clients_add_client', 'clients_edit_data'],
  add: 'clients_add_client',
  edit: 'clients_edit_data',
  changeStatus: 'clients_change_status',
} as const;

const SYSTEM_ROLE_LABELS: Record<string, string> = { owner: 'المالك', manager: 'مدير', admin: 'مسؤول النظام', employee: 'موظف' };

export const LIST_PERIODS = ['today', 'week', 'two_weeks', 'month', 'three_months', 'six_months', 'year', 'more_than_year'] as const;
export type ListPeriod = (typeof LIST_PERIODS)[number];

export interface ClientListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  branchId?: number;
  includeDescendants?: boolean;
  region?: number;
  client?: number;
  name?: string;
  status?: number | 'no_status';
  registrationStage?: number;
  categoryId?: number;
  type?: number;
  neighborhood?: string;
  employee?: number;
  overCreditLimit?: boolean;
  customerTargetId?: number | 'no_target';
  dateFrom?: string;
  dateTo?: string;
  latitude?: number;
  longitude?: number;
  sort?: 'newest' | 'name';
  lastInvoicePeriod?: ListPeriod;
  lastPaymentPeriod?: ListPeriod;
  lastActivityPeriod?: ListPeriod;
}

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

/**
 * العملاء — القائمة والخريطة والتفصيل والإضافة والتعديل، بقواعد
 * `Modules\Client\Http\Controllers\ClientController` في الويب: نفس «من يرى أيّ
 * عميل»، ونفس الفلاتر، ونفس قاعدة «الزيارة قبل العرض»، ونفس خطوات الحفظ.
 */
export class ClientUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly clients: ClientRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly numbers: DocumentNumberRepository,
    private readonly visibility: ClientVisibility,
    private readonly form: ClientForm,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly images: ImageStore,
    private readonly geocoder: Geocoder,
    private readonly hasher: Hasher,
  ) {}

  async presenter(ctx: ClientsContext): Promise<ClientPresenter> {
    const currency = await this.reference.defaultCurrency();
    return new ClientPresenter(new CurrencyFormatter(currency), ctx.tree, (p) => this.images.publicUrl(p) ?? p);
  }

  // ═══════════════════════ القائمة والخريطة ═══════════════════════

  /** فترات «آخر فاتورة/دفعة/نشاط» — `getPeriodDates()` في الويب */
  private period(ctx: ClientsContext, period: ListPeriod): DateWindow {
    const now = ctx.now;
    const w = (from: Date, to: Date): DateWindow => ({ from: toSqlDateTime(from), to: toSqlDateTime(to) });
    switch (period) {
      case 'today':
        return w(startOfDay(now), endOfDay(now));
      case 'week':
        return w(startOfDay(addDays(now, -7)), endOfDay(addDays(now, -1)));
      case 'two_weeks':
        return w(startOfDay(addDays(now, -14)), endOfDay(addDays(now, -8)));
      case 'month':
        return w(startOfDay(addDays(now, -30)), endOfDay(addDays(now, -15)));
      case 'three_months':
        return w(startOfDay(addDays(now, -90)), endOfDay(addDays(now, -31)));
      case 'six_months':
        return w(startOfDay(addDays(now, -180)), endOfDay(addDays(now, -91)));
      case 'year':
        return w(startOfDay(addDays(now, -365)), endOfDay(addDays(now, -181)));
      default:
        return w(addYears(now, -100), endOfDay(addDays(now, -365)));
    }
  }

  private async filters(ctx: ClientsContext, q: ClientListQuery): Promise<ClientListFilters> {
    const withDescendants = q.includeDescendants !== false;
    return {
      search: q.search,
      clientId: q.client,
      name: q.name,
      status: q.status,
      registrationStageId: q.registrationStage,
      regionNodeIds: q.region ? this.visibility.treeNodeIds(ctx, q.region, withDescendants) : undefined,
      branchNodeIds: await this.visibility.branchFilter(ctx, q.branchId, withDescendants),
      neighborhood: q.neighborhood,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      categoryId: q.categoryId,
      clientType: q.type,
      employeeId: q.employee,
      overCreditLimit: q.overCreditLimit,
      customerTarget: q.customerTargetId,
      lastInvoice: q.lastInvoicePeriod ? this.period(ctx, q.lastInvoicePeriod) : undefined,
      lastPayment: q.lastPaymentPeriod ? this.period(ctx, q.lastPaymentPeriod) : undefined,
      lastActivity: q.lastActivityPeriod ? this.period(ctx, q.lastActivityPeriod) : undefined,
      sort: q.sort,
    };
  }

  /**
   * «الزيارة قبل العرض» لكل صفّ — من يُلزَم بها يحتاج زيارةً ما لم تكتمل
   * زيارته اليوم (والعودة المجدولة تُعيد الحاجة)، ومعها رقم الزيارة المفتوحة.
   */
  private async visitState(ctx: ClientsContext, clientIds: number[]) {
    const mustVisit = ctx.can('clients_must_visit_before_view') && !ctx.can('clients_exempt_visit_before_view');
    const completed = new Set<number>();
    const open = new Map<number, number>();

    if (clientIds.length) {
      for (const v of await this.clients.todayVisits(ctx.user.id, clientIds, ctx.today)) {
        if (v.stage === 'completed') completed.add(v.clientId);
        else if (!v.departed && !open.has(v.clientId)) open.set(v.clientId, v.id);
      }
      for (const pending of await this.clients.pendingItineraryClientIds(ctx.user.id, ctx.today)) completed.delete(pending);
      for (const id of completed) open.delete(id);
    }

    return {
      needsVisit: (id: number) => mustVisit && !completed.has(id),
      openVisitId: (id: number) => open.get(id) ?? null,
    };
  }

  async list(userId: number, meta: RequestMeta, q: ClientListQuery) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.view]);
    const page = q.page ?? 1;
    const perPage = q.perPage ?? 20;

    const scope = await this.visibility.scope(ctx);
    const filters = await this.filters(ctx, q);
    filters.excludeIds = await this.visibility.excludedIds(ctx);

    const { rows, total } = await this.clients.page(scope, filters, page, perPage);
    const presenter = await this.presenter(ctx);
    const ids = rows.map((r) => r.id);
    const [extras, due, state] = await Promise.all([this.clients.extras(rows), this.clients.dueBalances(ids), this.visitState(ctx, ids)]);

    const items = rows.map((c) => {
      const ex = extras.get(c.id);
      const distanceKm =
        q.latitude !== undefined && q.longitude !== undefined && ex?.location
          ? round(kmBetween(q.latitude, q.longitude, ex.location.latitude, ex.location.longitude), 2)
          : null;
      return presenter.summary(c, ex, due.get(c.id) ?? 0, {
        needsVisit: state.needsVisit(c.id),
        openVisitId: state.openVisitId(c.id),
        distanceKm,
      });
    });

    /* شريط «أُنهيت زياراتهم اليوم» — `ClientController::index()`: العملاء المُخفَون أعلاه بأسمائهم
       لمن لا يرى الكلّ، فيعرف المندوب أين ذهب العميل ويُرجعه. في الصفحة الأولى وحدها (التمرير
       اللانهائي يُبقيها)، وفارغٌ متى أُطفئ الإخفاء في الإعدادات. */
    const finishedToday =
      page === 1 && !ctx.can('clients_view_all_clients') ? await this.clients.briefs(await this.visibility.hiddenFinishedClientIds(ctx)) : [];

    return { items, total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)), finishedToday };
  }

  /** مَن أضاف العميل لخطّ السير — `DailyItineraryService::describeAdders()` */
  private async describeAdders(ids: number[]) {
    const users = await this.reference.userNames(uniq(ids));
    const out = new Map<number, { name: string; role: string | null }>();
    for (const [id, u] of users) out.set(id, { name: u.name, role: u.roleName ? SYSTEM_ROLE_LABELS[u.roleName] ?? u.roleName : null });
    return out;
  }

  /**
   * الخريطة — `getMapData()`: من له خطّ سيرٍ اليوم لا يرى إلا عملاءه فيه
   * (ومصدرُ كلٍّ منهم: الخطّة / أضافه هو / أضافه غيره)، وغيره يرى نطاقه.
   */
  async map(userId: number, meta: RequestMeta, q: ClientListQuery) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.view]);

    const itineraryRows = await this.clients.todayItineraryRows(ctx.user.id, ctx.today);
    const itineraryMode = itineraryRows.length > 0;
    const scope = itineraryMode ? { kind: 'ids' as const, ids: uniq(itineraryRows.map((r) => r.clientId)) } : await this.visibility.scope(ctx);

    const filters = await this.filters(ctx, q);
    filters.excludeIds = await this.visibility.excludedIds(ctx, itineraryMode);
    filters.withLocation = true;

    if (scope.kind === 'none') return { clients: [], total: 0, itineraryOnly: false };

    const rows = await this.clients.list(scope, filters, 2000);
    const presenter = await this.presenter(ctx);
    const ids = rows.map((r) => r.id);
    const [extras, due, state] = await Promise.all([this.clients.extras(rows), this.clients.dueBalances(ids), this.visitState(ctx, ids)]);

    const sources = new Map<number, { tone: string; label: string }>();
    if (itineraryMode) {
      const adders = await this.describeAdders(itineraryRows.map((r) => r.addedBy).filter((v): v is number => v !== null));
      for (const row of itineraryRows) {
        let source: { tone: string; label: string };
        if (!row.addedBy) source = { tone: 'plan', label: 'من خط السير المخطَّط' };
        else if (row.addedBy === ctx.user.id) source = { tone: 'self', label: 'أضفتَه أنت لخط سيرك' };
        else {
          const by = adders.get(row.addedBy);
          source = { tone: 'other', label: `أضافه: ${by?.name ?? '—'}${by?.role ? ` · ${by.role}` : ''}` };
        }
        sources.set(row.clientId, source);
      }
    }

    const markers = rows.map((c) => {
      const ex = extras.get(c.id);
      return presenter.summary(c, ex, due.get(c.id) ?? 0, {
        branchPath: presenter.branchPath(c, ex),
        needsVisit: state.needsVisit(c.id),
        openVisitId: state.openVisitId(c.id),
        itinerarySource: sources.get(c.id) ?? null,
      });
    });

    return { clients: markers, total: markers.length, itineraryOnly: itineraryMode };
  }

  // ═══════════════════════ التفصيل ═══════════════════════

  private async findOrFail(id: number): Promise<ClientRow> {
    const client = await this.clients.find(id);
    if (!client) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    return client;
  }

  async show(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.view]);
    const client = await this.findOrFail(clientId);
    await this.visibility.assertAccess(ctx, client.id);

    // «الزيارة قبل العرض» — من يُلزَم بها لا يرى ملفّ العميل؛ يُوجَّه إلى زيارته
    if (ctx.can('clients_must_visit_before_view') && !ctx.can('clients_exempt_visit_before_view')) {
      if ((await this.visibility.hiddenFinishedClientIds(ctx)).includes(client.id)) {
        throw new AppError('VISIT_FINISHED_TODAY', 'انتهت زيارة هذا العميل اليوم. لفتحه من جديد أرجِعه لخط سيرك أو سجّل له زيارة في يومٍ آخر.', 403);
      }

      const openVisitId = await this.clients.openVisitId(ctx.user.id, client.id, ctx.today);
      if (openVisitId || ctx.can([...CLIENT_PERMISSIONS.workspace])) {
        throw new AppError('MUST_VISIT_FIRST', 'يجب تسجيل زيارة هذا العميل قبل عرض ملفّه — افتح الزيارة.', 403, { clientId: client.id, openVisitId });
      }
    }

    const presenter = await this.presenter(ctx);
    const [extras, due, category, stageName, employees, contacts] = await Promise.all([
      this.clients.extras([client]),
      this.clients.dueBalances([client.id]),
      this.clients.category(client.categoryId),
      this.reference.statusName(client.registrationStageId),
      this.clients.assignedEmployees(client.id),
      this.clients.contacts(client.id),
    ]);

    return {
      ...presenter.detail(client, extras.get(client.id), due.get(client.id) ?? 0, {
        category,
        registrationStage: client.registrationStageId && stageName !== null ? { id: client.registrationStageId, name: stageName } : null,
        employees,
        contacts,
      }),
      can: {
        edit: ctx.can(CLIENT_PERMISSIONS.edit),
        changeStatus: ctx.can(CLIENT_PERMISSIONS.changeStatus),
        addNote: ctx.can([...CLIENT_PERMISSIONS.notesAdd]),
        viewNotes: ctx.can([...CLIENT_PERMISSIONS.notesView]),
        openVisit: ctx.can([...CLIENT_PERMISSIONS.workspace]),
      },
    };
  }

  /** قوائم نموذج الإضافة/التعديل — `clientId` لتمهيد نموذج تعديل عميلٍ بعينه */
  async options(userId: number, meta: RequestMeta, clientId?: number) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.form]);
    let client: ClientRow | null = null;
    let nodeId: number | null = null;

    if (clientId) {
      client = await this.findOrFail(clientId);
      await this.visibility.assertAccess(ctx, client.id);
      const presenter = await this.presenter(ctx);
      nodeId = presenter.treeNodeOf(client, (await this.clients.extras([client])).get(client.id));
    }

    return this.form.options(ctx, client, nodeId);
  }

  // ═══════════════════════ الحفظ ═══════════════════════

  private async summaryOf(ctx: ClientsContext, id: number, extra: Record<string, unknown> = {}) {
    const client = await this.findOrFail(id);
    const presenter = await this.presenter(ctx);
    const [extras, due] = await Promise.all([this.clients.extras([client]), this.clients.dueBalances([client.id])]);
    return presenter.summary(client, extras.get(client.id), due.get(client.id) ?? 0, extra);
  }

  /** `defaultNewClientStatusId()` — المضبوط، وإلا أوّل حالةٍ قابلة للإسناد */
  private async defaultStatusId(ctx: ClientsContext): Promise<number | null> {
    return ctx.settings.configuredDefaultStatusId() ?? (await this.reference.assignableStatuses())[0]?.id ?? null;
  }

  /** حساب العميل في شجرة الحسابات — `ensureClientLedgerAccount()` (الرصيد الافتتاحي صفر) */
  private async ensureLedgerAccount(clientId: number, name: string, now: string, tx: Tx) {
    const existing = await this.clients.ledgerAccountId(clientId, tx);
    if (existing) return existing;
    const parent = await this.reference.ledgerParent('clients_account');
    if (!parent) return null;
    return this.clients.createLedgerAccount(clientId, name, parent, now, tx);
  }

  private async storeAttachment(file: UploadedFile | null): Promise<string | null> {
    return file ? this.images.saveAsIs('assets/uploads', file) : null;
  }

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.contexts.load(userId, meta, CLIENT_PERMISSIONS.add);
    const data = await this.form.validate(ctx, body, files, null, null);
    const node = ctx.tree.find(data.treeNodeId)!;
    const now = ctx.nowSql;

    // «بدء زيارة عند الإضافة» لمن يستطيع دخول مساحة الزيارة — شرط الويب نفسه
    const startVisit = ctx.can('clients_start_visit_on_create') && ctx.can([...CLIENT_PERMISSIONS.workspace]);
    const attachment = await this.storeAttachment(data.attachment);

    let clientId: number;
    try {
      clientId = await this.uow.run(async (tx) => {
        const fields: Record<string, unknown> = {
          status_id: await this.defaultStatusId(ctx),
          ...data.fields,
          tree_node_id: node.id,
          branch_id: ctx.tree.resolveAccountingBranchId(node.id) ?? node.id,
          registration_stage_id: data.fields.registration_stage_id ? Number(data.fields.registration_stage_id) : ctx.settings.defaultRegistrationStageId(),
          code: await this.numbers.next('customer', ctx.now, tx),
          created_at: now,
          updated_at: now,
        };
        if (attachment) fields.attachments = attachment;

        const id = await this.clients.insert(fields, tx);
        const tradeName = (fields.trade_name as string | null) ?? null;

        await this.clients.createContact(id, { first_name: tradeName, phone: fields.phone ?? null, mobile: fields.mobile ?? null, email: fields.email ?? null }, now, tx);

        if (ctx.can('clients_assign_employees')) {
          for (const employeeId of uniq(data.employeeIds ?? [])) await this.clients.addAssignment(id, employeeId, now, tx);
        } else if (ctx.isEmployee) {
          await this.clients.addAssignment(id, ctx.user.employeeId!, now, tx);
        }

        await this.clients.addLocation(id, data.latitude, data.longitude, now, tx);

        await this.clients.createNeighborhood(
          id,
          data.neighborhoodManual ?? (await this.geocoder.neighborhood(data.latitude, data.longitude)) ?? 'غير محدد',
          ctx.tree.resolveTerritoryForNeighborhood(node.id),
          now,
          tx,
        );

        if (data.email) {
          await this.clients.createLoginUser(
            id,
            {
              name: `${tradeName ?? ''} ${fields.first_name ?? ''} ${fields.last_name ?? ''}`.trim(),
              email: data.email,
              // `users.phone` لا يقبل null — الويب يسقط هنا حين يُرسَل بريدٌ بلا هاتف
              phone: data.phone ?? '',
            },
            await this.hasher.hash(randomBytes(12).toString('base64url')),
            now,
            tx,
          );
        }

        await this.log.record(ctx, 'created', id, `إضافة عميل «${tradeName ?? ''}» — من تطبيق الجوال`, {
          new: { code: fields.code, trade_name: tradeName, phone: fields.phone ?? null, status_id: fields.status_id, branch_id: fields.branch_id },
        }, tx);

        await this.ensureLedgerAccount(id, tradeName ?? '', now, tx);

        for (const contact of data.contacts ?? []) {
          const { id: _ignored, ...values } = contact;
          await this.clients.createContact(id, values, now, tx);
        }

        if (startVisit) {
          const { week, year } = getWeekAndYear(ctx.now);
          const row = await this.clients.upsertItineraryRow(
            { employeeId: ctx.user.id, clientId: id, dayOfWeek: dayNameEn(ctx.now).toLowerCase(), year, weekNumber: week, visitDate: ctx.today },
            now,
            tx,
          );
          if (row.created) await this.afterItineraryRowCreated(ctx, id, tx);
        }

        return id;
      });
    } catch (e) {
      await this.images.delete('assets/uploads', attachment);
      if (e instanceof AppError) throw e;
      await this.log.failure(ctx, e, 'integration.store');
      throw new AppError('SAVE_FAILED', 'تعذّر حفظ العميل — لم يُحفظ شيء. حاول مرّةً أخرى.', 500);
    }

    // الزيارة بعد الحفظ لا داخله: تعثّرُها لا يُسقط عميلاً حُفظ للتوّ
    let visitId: number | null = null;
    if (startVisit) {
      try {
        visitId = await this.uow.run(async (tx) =>
          this.clients.createVisit(
            {
              employee_id: ctx.user.id,
              client_id: clientId,
              visit_date: ctx.nowSql,
              visit_number: await this.numbers.next('visit', ctx.now, tx),
              client_latitude: data.latitude,
              client_longitude: data.longitude,
              recording_method: 'manual',
              is_approved: 0,
              stage: 'arrived',
              created_at: ctx.nowSql,
              updated_at: ctx.nowSql,
            },
            tx,
          ),
        );
        const name = (data.fields.trade_name as string | null) ?? '';
        await this.log.record(ctx, 'visit_registered', clientId, `تسجيل زيارة فور إضافة العميل «${name}» — من تطبيق الجوال`);
      } catch (e) {
        await this.log.failure(ctx, e, 'start_visit_on_create', clientId);
      }
    }

    const message =
      visitId !== null
        ? 'تمت إضافة العميل وفتح زيارته — أضِف مسؤول العميل لتبدأ.'
        : startVisit
          ? 'تمت إضافة العميل، لكن تعذّر فتح زيارته — افتحها من زرّ الزيارة.'
          : 'تمت إضافة العميل بنجاح.';

    return { client: await this.summaryOf(ctx, clientId, { visitId }), message };
  }

  /** خطّاف `EmployeeClientVisit::created` — زيارةٌ جديدة تُلغي «استبعاد الموقع» للعميل */
  async afterItineraryRowCreated(ctx: ClientsContext, clientId: number, tx?: Tx) {
    const name = await this.clients.clearExemptLocation(clientId, ctx.nowSql, tx);
    if (name !== null) {
      await this.log.record(ctx, 'exempt_location_toggled', clientId, `إلغاء استبعاد الموقع للعميل «${name}» تلقائياً — أُضيفت له زيارةٌ جديدة إلى خطّ السير`, {}, tx);
    }
  }

  async update(userId: number, meta: RequestMeta, clientId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.contexts.load(userId, meta, CLIENT_PERMISSIONS.edit);
    const client = await this.findOrFail(clientId);
    await this.visibility.assertAccess(ctx, client.id);

    const presenter = await this.presenter(ctx);
    const currentNode = presenter.treeNodeOf(client, (await this.clients.extras([client])).get(client.id));
    const data: ValidatedClient = await this.form.validate(ctx, body, files, client, currentNode);
    const node = ctx.tree.find(data.treeNodeId)!;
    const now = ctx.nowSql;
    const attachment = await this.storeAttachment(data.attachment);

    const trackedColumns = [...CLIENT_FIELD_COLUMNS, 'tree_node_id', 'branch_id'];
    const before = await this.clients.find(client.id);

    try {
      await this.uow.run(async (tx) => {
        const fields: Record<string, unknown> = {
          ...data.fields,
          tree_node_id: node.id,
          branch_id: ctx.tree.resolveAccountingBranchId(node.id) ?? node.id,
          updated_at: now,
        };

        if (ctx.can('clients_assign_employees')) {
          if (data.employeeIds !== undefined) await this.clients.replaceAssignments(client.id, data.employeeIds, now, tx);
        } else if (ctx.isEmployee) {
          await this.clients.ensureAssignment(client.id, ctx.user.employeeId!, now, tx);
        }

        if (attachment) fields.attachments = attachment;

        await this.clients.update(client.id, fields, tx);
        const fresh = (await this.clients.find(client.id, tx))!;

        const accountId = await this.ensureLedgerAccount(client.id, fresh.tradeName ?? '', now, tx);
        if (accountId) await this.clients.renameLedgerAccount(accountId, fresh.tradeName ?? '', now, tx);

        // الموقع يُستبدل حين يُرسَل فقط — لا يُمسح موقعٌ مسجَّل لأن الطلب لم يحمله
        const moved = data.latitude !== null && data.longitude !== null;
        if (moved) await this.clients.replaceLocation(client.id, data.latitude, data.longitude, now, tx);

        const territory = ctx.tree.resolveTerritoryForNeighborhood(node.id);
        const hood = await this.clients.neighborhood(client.id, tx);
        if (moved || data.neighborhoodManual || !hood || hood.regionId !== territory) {
          const name =
            data.neighborhoodManual ?? (moved ? await this.geocoder.neighborhood(data.latitude, data.longitude) : null) ?? hood?.name ?? 'غير محدد';
          await this.clients.upsertNeighborhood(client.id, name, territory, now, tx);
        }

        if (data.email) {
          const payload = {
            name: [fresh.tradeName, fresh.firstName, fresh.lastName].filter((v) => v !== null && v !== '').join(' '),
            email: data.email,
            phone: data.phone ?? '',
          };
          const loginId = await this.clients.loginUserId(client.id);
          if (loginId) await this.clients.updateLoginUser(loginId, payload, now, tx);
          else await this.clients.createLoginUser(client.id, payload, await this.hasher.hash(randomBytes(12).toString('base64url')), now, tx);
        }

        if (data.contacts !== undefined) await this.clients.syncContacts(client.id, data.contacts, now, tx);

        const pick = (row: ClientRow | null) => {
          const snake = row ? rowToColumns(row) : {};
          return Object.fromEntries(trackedColumns.map((col) => [col, snake[col] ?? null]));
        };
        await this.log.record(ctx, 'updated', client.id, `تحديث بيانات العميل «${fresh.tradeName ?? ''}» — من تطبيق الجوال`, { old: pick(before), new: pick(fresh) }, tx);
      });
    } catch (e) {
      await this.images.delete('assets/uploads', attachment);
      if (e instanceof AppError) throw e;
      await this.log.failure(ctx, e, 'integration.update', client.id);
      throw new AppError('SAVE_FAILED', 'تعذّر تعديل العميل — لم يُحفظ شيء. حاول مرّةً أخرى.', 500);
    }

    if (attachment && client.attachments) await this.images.delete('assets/uploads', client.attachments);

    return { client: await this.summaryOf(ctx, client.id), message: 'تم تحديث بيانات العميل بنجاح.' };
  }

  // ═══════════════════════ الإعدادات والفروع ═══════════════════════

  /** ما يحتاجه التطبيق من «إعدادات وحدات العملاء» ليبني شاشاته بقواعد الخادم */
  async settings(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta);
    const s = ctx.settings;
    return {
      sections: {
        visits: s.module.visitsEnabled,
        itinerary: s.module.itineraryEnabled,
        notes: s.module.notesEnabled,
        routeTracking: s.isRouteTrackingEnabled(),
      },
      requiredFields: this.form.requiredFields(s),
      clientTypeScope: s.clientTypeScope(),
      visit: {
        proximityMeters: Math.round((await ctx.proximityRadiusKm()) * 1000),
        competitorCapture: s.visitWorkspaceSectionVisible('show_competitor_capture'),
        signatureRequired: s.visitWorkspaceSectionVisible('show_signature_section'),
        noteDepositCount: s.visitWorkspaceSectionVisible('note_deposit_count'),
        notePhoto: s.visitWorkspaceSectionVisible('note_photo'),
        noteMinPhotos: s.noteMinPhotos(),
        hideFinishedClients: s.hideFinishedVisitClients(),
        allowReturnSameDay: s.allowReturnFinishedClientSameDay(),
      },
      statusChangeRequiresApproval: s.statusChangeRequiresApproval(),
      itineraryMaxClientsPerDay: s.itineraryMaxClientsPerDay(),
      maxUploadKb: s.maxUploadSizeKb(),
      imageQuality: s.uploadImageQuality(),
      imageMaxDimension: s.uploadImageMaxDimension(),
      siteTypes: SITE_TYPES,
      shift: {
        fullTimeValue: FULL_TIME_VALUE,
        fullTimeLabel: FULL_TIME_LABEL,
        hours: shiftHourOptions(),
        format: 'HH:00|HH:00',
      },
    };
  }

  /**
   * الفروع (عقد الشجرة) التي يحقّ للمستخدم اختيارها — منسدلة الفروع في الويب
   * (`DataScope::branchOptions()`)؛ لفلتر `branchId` في القائمة والخريطة.
   */
  async branches(userId: number, meta: RequestMeta, search?: string) {
    const ctx = await this.contexts.load(userId, meta, undefined, { module: false });
    const allowed = await ctx.selectableBranchIds();
    const current = ctx.user.branchId ?? null;
    const term = search?.trim().toLowerCase();

    const nodes = ctx.tree
      .all()
      .filter((n) => allowed === null || allowed.includes(n.id))
      .filter((n) => !term || n.name.toLowerCase().includes(term))
      .sort((a, b) => Number(b.isMain) - Number(a.isMain) || ((a.code ?? '') < (b.code ?? '') ? -1 : (a.code ?? '') > (b.code ?? '') ? 1 : 0) || a.id - b.id);

    return {
      currentBranchId: current,
      restricted: allowed !== null,
      branches: nodes.map((b) => {
        const type = BranchTree.nodeTypeKey(b);
        return { id: b.id, name: b.name, code: b.code, parentId: b.parentId, nodeType: type, typeLabel: BranchTree.typeLabel(type), isMain: b.isMain, isCurrent: b.id === current };
      }),
    };
  }
}

/** صفّ العميل بأسماء أعمدته — لفرق القيم في سجلّ النشاط */
function rowToColumns(r: ClientRow): Record<string, unknown> {
  return {
    trade_name: r.tradeName,
    first_name: r.firstName,
    last_name: r.lastName,
    phone: r.phone,
    mobile: r.mobile,
    email: r.email,
    street1: r.street1,
    street2: r.street2,
    city: r.city,
    region: r.region,
    postal_code: r.postalCode,
    country: r.country,
    currency: r.currency,
    tax_number: r.taxNumber,
    commercial_registration: r.commercialRegistration,
    category_id: r.categoryId,
    client_type: r.clientType,
    registration_stage_id: r.registrationStageId,
    printing_method: r.printingMethod,
    notes: r.notes,
    item_quantity_limit: r.itemQuantityLimit,
    tree_node_id: r.treeNodeId,
    branch_id: r.branchId,
  };
}
