import { AppError } from '../../../domain/errors/AppError';
import { ClientRepository, ClientsReferenceRepository, NamedOption } from '../../../domain/repositories/clients';
import { ItineraryRepository, ItineraryRow } from '../../../domain/repositories/visits';
import { kmBetween, round } from '../../../domain/services/clients/Geo';
import { addDays, parseInputDate, parseLocal, startOfDay, toSqlDate } from '../../../domain/services/clients/LocalTime';
import { getWeekAndYear, dayNameEn, partsFor } from '../../../domain/services/clients/WeekCalendar';
import { ImageStore, UnitOfWork } from '../../ports';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog } from '../../services/clients/ClientsSupport';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { CLIENT_PERMISSIONS, ClientUseCases } from './ClientUseCases';

export const ITINERARY_PERMISSIONS = {
  day: ['clients_daily_itinerary_view', 'clients_daily_itinerary_add_for_others'],
  add: ['clients_daily_itinerary_add_client', 'clients_daily_itinerary_add_for_others'],
  postpone: 'clients_itinerary_edit',
} as const;

const DEFAULT_START = 8 * 60;
const DEFAULT_DURATION = 30;
const CITY_SPEED_KMH = 30;
const LAST_START = 23 * 60 + 55;
export const PICKER_LIMIT = 100;
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const SYSTEM_ROLE_LABELS: Record<string, string> = { owner: 'المالك', manager: 'مدير', admin: 'مسؤول النظام', employee: 'موظف' };
const LOG_MODULE = 'ClientItineraries';

/** أيّام Carbon بالعربية (`ar`) — «الاثنين» لا «الإثنين» */
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
/** `translatedFormat('l، j F Y')` */
const dateLabel = (d: Date) => `${AR_DAYS[d.getUTCDay()]}، ${d.getUTCDate()} ${AR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

const toMinutes = (time: string | null | undefined) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const fromMinutes = (minutes: number) => {
  const m = Math.max(0, Math.min(minutes, 23 * 60 + 59));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
/** ساعة ودقيقة وقتٍ مخزَّن (`Y-m-d H:i:s`) */
const clockOf = (value: string | null) => {
  const d = parseLocal(value);
  return d ? d.getUTCHours() * 60 + d.getUTCMinutes() : null;
};

type StopState = 'done' | 'active' | 'planned' | 'missed' | 'cancelled' | 'next' | 'late';

/**
 * «خط سيري اليومي» — يومٌ واحدٌ من خطّ سير مندوب: زياراته بترتيبها وحالتها
 * ووقتها التقديريّ، والإضافة عليه والتأجيل. نسخة `DailyItineraryService` في الويب.
 */
export class ItineraryUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly itinerary: ItineraryRepository,
    private readonly clients: ClientRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly clientUseCases: ClientUseCases,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly images: ImageStore,
  ) {}

  // ═══════════════════════ الحراسة ═══════════════════════

  /** قسم «خطوط السير» مطفأٌ من إعدادات وحدات العملاء ⇒ منعٌ صريح */
  private sectionBlock(ctx: ClientsContext) {
    if (!ctx.settings.module.itineraryEnabled) {
      throw new AppError('SECTION_DISABLED', 'قسم «خطوط السير» معطَّل من إعدادات وحدات العملاء.', 403);
    }
  }

  private canViewOthers(ctx: ClientsContext) {
    return ctx.can('clients_daily_itinerary_add_for_others') || ctx.can('clients_itinerary_view');
  }

  /** `TeamScope::covers()` */
  private async covers(ctx: ClientsContext, userId: number) {
    if (userId === ctx.user.id) return true;
    const team = await ctx.teamUserIds();
    return team === null || team.includes(userId);
  }

  private async mayAdd(ctx: ClientsContext, employeeId: number) {
    return employeeId === ctx.user.id
      ? ctx.can('clients_daily_itinerary_add_client')
      : ctx.can('clients_daily_itinerary_add_for_others') && (await this.covers(ctx, employeeId));
  }

  private async authorizeTarget(ctx: ClientsContext, employeeId: number, adding: boolean) {
    if (adding) {
      if (!(await this.mayAdd(ctx, employeeId))) throw AppError.forbidden('ITINERARY_FORBIDDEN', 'لا تملك إضافة عملاء إلى خطّ سير هذا المندوب.');
      return;
    }
    if (!(employeeId === ctx.user.id || (this.canViewOthers(ctx) && (await this.covers(ctx, employeeId))))) {
      throw AppError.forbidden('ITINERARY_FORBIDDEN', 'لا يمكنك الوصول إلى خطّ سير هذا المندوب.');
    }
  }

  /** `HeaderBranchScope::nodeId()` مع ما تحته — `null` بلا قيد */
  /**
   * فروعُ الموظف كلُّها (`employee_branch`). في الويب يقف الموظف على فرعٍ واحدٍ في الشريط العلوي ويبدّل
   * بينها بمبدّل الفرع، فيبلغ كلَّ فرعٍ مُسنَدٍ إليه. ولا مبدّل في التطبيق — فمن له فرعان أساسيان كان
   * يرى أحدَهما فقط (`users.branch_id`) ولا سبيل له إلى الآخر. تُجمع هنا فيبلغها كلَّها.
   */
  private async assignedNodes(ctx: ClientsContext): Promise<number[]> {
    return ctx.user.employeeId ? this.itinerary.employeeBranchIds(ctx.user.employeeId) : [];
  }

  private async headerNodeIds(ctx: ClientsContext): Promise<number[] | null> {
    const node = await ctx.headerNode();
    if (!node) return null;
    const nodes = [...new Set([node, ...(await this.assignedNodes(ctx))])];
    return [...new Set(nodes.flatMap((n) => (ctx.tree.find(n) ? ctx.tree.subtree(n) : [n])))];
  }

  /** عُقد «تابع لـ» المسموحة: نطاقه بتوابعه التنظيمية، مقصوصاً بفرع الهيدر — على فروع الموظف كلِّها */
  private async nodeScope(ctx: ClientsContext) {
    let allowed = ctx.tree.withOrganisationalChildren(await ctx.selectableBranchIds());
    const assigned = await this.assignedNodes(ctx);
    if (allowed !== null && assigned.length > 0) {
      // ما كان نطاقُه ليكونه لو وقف على كلّ فرعٍ منها: «الفرع» بتوابعه التنظيمية، وغيرُه بشجرته
      const level = (await ctx.scopeState()).level;
      const reach = level === 'branch' ? ctx.tree.withOrganisationalChildren(assigned) ?? [] : assigned.flatMap((n) => (ctx.tree.find(n) ? ctx.tree.subtree(n) : [n]));
      allowed = [...new Set([...allowed, ...reach])];
    }
    const header = await this.headerNodeIds(ctx);
    return { allowed, header };
  }

  /** `scopedClients()` — قيود العقد، أو `null` حين تكون العقدة المطلوبة خارج النطاق */
  private async scopedConstraints(ctx: ClientsContext, nodeId: number | null): Promise<number[][] | null> {
    const { allowed, header } = await this.nodeScope(ctx);
    if (nodeId && ((allowed !== null && !allowed.includes(nodeId)) || (header !== null && !header.includes(nodeId)))) return null;
    if (nodeId) return [ctx.tree.find(nodeId) ? ctx.tree.subtree(nodeId) : []];
    return [allowed, header].filter((ids): ids is number[] => ids !== null);
  }

  private parseDate(ctx: ClientsContext, value: string | undefined): Date {
    if (!value) return startOfDay(ctx.now);
    const d = parseInputDate(value);
    if (!d) throw AppError.validation({ date: ['التاريخ بصيغة YYYY-MM-DD.'] }, 'التاريخ بصيغة YYYY-MM-DD.');
    return startOfDay(d);
  }

  // ═══════════════════════ اليوم ═══════════════════════

  private stateOf(row: ItineraryRow, hasOpenVisit: boolean): Exclude<StopState, 'next' | 'late'> {
    const status = row.visitStatus;
    if (status === 'completed' || (status === null && row.status === 'active')) return 'done';
    if (status === 'started' || hasOpenVisit) return 'active';
    if (status === 'missed') return 'missed';
    if (status === 'cancelled') return 'cancelled';
    return 'planned';
  }

  /** من زاره المندوبُ أوّلاً (بوقته)، ثم الجارية، ثم الخطّة بترتيبها، والملغاةُ آخراً — عرضٌ لا يُكتب */
  private visitedFirst(rows: ItineraryRow[], open: number[]): ItineraryRow[] {
    return rows
      .map((row, index) => {
        const state = this.stateOf(row, open.includes(row.clientId));
        const at = row.startedAt ?? row.completedAt;
        const group = state === 'cancelled' ? 3 : state === 'active' ? (at ? 0 : 1) : state === 'done' ? 0 : 2;
        const key = group === 0 ? (at ? parseLocal(at)!.getTime() : Number.MAX_SAFE_INTEGER) : 0;
        return { row, sort: [group, key, index] };
      })
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2])
      .map((x) => x.row);
  }

  private async describeAdders(ids: number[]) {
    const users = await this.reference.userNames([...new Set(ids)]);
    const out = new Map<number, { id: number; name: string; role: string | null }>();
    for (const [id, u] of users) out.set(id, { id, name: u.name, role: u.roleName ? SYSTEM_ROLE_LABELS[u.roleName] ?? u.roleName : null });
    return out;
  }

  /** آخر ملاحظةٍ لكل عميل وصورُ ملاحظاته الأخيرة — `clientGallery()` */
  private async gallery(clientIds: number[]) {
    const out = new Map<number, { note: { text: string; date: string | null } | null; photos: string[] }>();
    for (const clientId of clientIds) {
      const notes = await this.itinerary.recentNotes(clientId, 8);
      const latest = notes.find((n) => (n.description ?? '').trim() !== '');
      const photos: string[] = [];
      for (const n of notes) {
        let files: unknown = [];
        try {
          files = JSON.parse(n.attachments ?? '[]');
        } catch {
          files = [];
        }
        for (const file of Array.isArray(files) ? files : Object.values((files ?? {}) as Record<string, unknown>)) {
          if (typeof file === 'string' && IMAGE_EXTENSIONS.includes((file.split('.').pop() ?? '').toLowerCase())) {
            photos.push(this.images.publicUrl(`assets/uploads/notes/${file}`) ?? file);
          }
        }
      }
      out.set(clientId, {
        note: latest ? { text: (latest.description ?? '').trim(), date: latest.createdAt ? latest.createdAt.slice(0, 10) : null } : null,
        photos: [...new Set(photos)].slice(0, 8),
      });
    }
    return out;
  }

  /** `DailyItineraryService::day()` */
  private async dayPayload(ctx: ClientsContext, userId: number, date: Date) {
    const day = toSqlDate(date);
    const isToday = day === ctx.today;
    const isPast = day < ctx.today;

    let rows = await this.itinerary.dayRows(userId, day);
    const clientIds = [...new Set(rows.map((r) => r.clientId))];
    const [described, contacts, open, gallery] = await Promise.all([
      this.itinerary.describeClients(clientIds),
      this.itinerary.clientContacts(clientIds),
      isToday ? this.itinerary.startedWorkspaceClientIds(userId, ctx.today) : Promise.resolve([] as number[]),
      this.gallery(clientIds),
    ]);
    rows = this.visitedFirst(rows, open);
    const adders = await this.describeAdders(rows.map((r) => r.addedBy).filter((v): v is number => v !== null));

    type Stop = Record<string, unknown> & { state: StopState; plannedMinutes: number | null };
    const stops: Stop[] = [];
    let cursor = DEFAULT_START;
    const nowMinutes = ctx.now.getUTCHours() * 60 + ctx.now.getUTCMinutes();
    let projected = !isToday;
    let previous: { lat: number; lng: number } | null = null;
    const totals = { km: 0, minutes: 0 };

    for (const row of rows) {
      const client = described.get(row.clientId);
      if (!client) continue;

      const state = this.stateOf(row, open.includes(row.clientId));
      const located = client.lat !== null && client.lng !== null;
      let legKm: number | null = null;
      let legMinutes = 0;

      if (located && previous !== null) {
        legKm = kmBetween(previous.lat, previous.lng, client.lat!, client.lng!);
        legMinutes = Math.ceil(((legKm / CITY_SPEED_KMH) * 60) / 5) * 5;
      }

      const duration = DEFAULT_DURATION;

      // ما بقي من يومٍ جارٍ يُحسب من الآن لا من 08:00
      if (!projected && state === 'planned') {
        cursor = Math.max(cursor, nowMinutes);
        projected = true;
      }

      let start = cursor + legMinutes;
      if (row.plannedTime) start = Math.max(start, toMinutes(row.plannedTime));
      const startedClock = clockOf(row.startedAt);
      if (startedClock !== null) start = startedClock;
      start = Math.min(start, LAST_START);

      const completedClock = clockOf(row.completedAt);
      const end = startedClock !== null && completedClock !== null ? completedClock : Math.min(start + duration, LAST_START + 4);

      if (state !== 'cancelled') {
        cursor = Math.max(cursor, end);
        totals.km += legKm ?? 0;
        totals.minutes += legMinutes + Math.max(0, end - start);
      }
      if (located && state !== 'cancelled') previous = { lat: client.lat!, lng: client.lng! };

      const contact = contacts.get(row.clientId);
      const adder = row.addedBy ? adders.get(row.addedBy) ?? null : null;
      const place = ctx.tree.placeOf(client.nodeId);
      const g = gallery.get(row.clientId);

      stops.push({
        id: row.id,
        clientId: row.clientId,
        name: client.name.replace(/\s+/gu, ' ').trim(),
        code: client.code,
        clientStatus: client.status,
        place: [place.unit, place.branch, place.region].filter(Boolean).join(' - ') || (contact?.city ?? ''),
        address: [contact?.city, contact?.street1].filter(Boolean).join('، '),
        phone: contact ? String(contact.mobile || contact.phone || '') : '',
        lat: client.lat,
        lng: client.lng,
        state,
        start: fromMinutes(start),
        end: fromMinutes(end),
        plannedMinutes: row.plannedTime ? toMinutes(row.plannedTime) + duration : null,
        legKm: legKm !== null ? round(legKm, 1) : null,
        legMinutes: legKm !== null ? legMinutes : null,
        addedBy: adder ? { ...adder, self: row.addedBy === userId } : null,
        note: g?.note ?? null,
        photos: g?.photos ?? [],
      });
    }

    // «التالية» أوّل ما لم يبدأ ما لم تكن زيارةٌ جارية؛ و«متأخرة» لليومٍ الماضي أو لموعدٍ صريحٍ انقضى
    const hasActive = stops.some((s) => s.state === 'active');
    let nextMarked = false;
    for (const stop of stops) {
      if (stop.state !== 'planned') continue;
      if (!hasActive && !nextMarked && !isPast) {
        stop.state = 'next';
        nextMarked = true;
        continue;
      }
      if (isPast || (isToday && stop.plannedMinutes !== null && stop.plannedMinutes < nowMinutes)) stop.state = 'late';
    }

    const counted = stops.filter((s) => s.state !== 'cancelled');
    const done = counted.filter((s) => s.state === 'done').length;

    return {
      date: day,
      dateLabel: dateLabel(date),
      isToday,
      isPast,
      stops: stops.map(({ plannedMinutes: _p, ...rest }) => rest),
      stats: {
        done,
        total: counted.length,
        percent: counted.length ? Math.round((done / counted.length) * 100) : 0,
        km: round(totals.km, 1),
        minutes: totals.minutes,
      },
    };
  }

  /** يوم المندوب بزياراته وإحصاءاته، ومعه ما يحقّ للمستخدم فعلُه عليه */
  async day(userId: number, meta: RequestMeta, q: { employeeId?: number; date?: string }) {
    const ctx = await this.contexts.load(userId, meta, [...ITINERARY_PERMISSIONS.day]);
    this.sectionBlock(ctx);

    const employeeId = q.employeeId ?? ctx.user.id;
    await this.authorizeTarget(ctx, employeeId, false);

    const date = this.parseDate(ctx, q.date);
    const isSelf = employeeId === ctx.user.id;
    const payload = await this.dayPayload(ctx, employeeId, date);

    return {
      ...payload,
      employee: { id: employeeId, name: await this.itinerary.userName(employeeId) },
      isSelf,
      can: {
        add: !payload.isPast && (await this.mayAdd(ctx, employeeId)),
        postpone: !payload.isPast && ctx.can(ITINERARY_PERMISSIONS.postpone),
        start: isSelf && payload.isToday && ctx.can([...CLIENT_PERMISSIONS.workspace]),
      },
    };
  }

  // ═══════════════════════ الأشخاص ═══════════════════════

  /** `employeeOptions()` — هو أوّلاً، ثم مندوبو نطاقه وأقسام موظفي العملاء وفرع الهيدر */
  private async employeeOptions(ctx: ClientsContext): Promise<NamedOption[]> {
    const others = await this.itinerary.employeeOptions({
      scopeUserIds: await ctx.documentUserIds(),
      headerNodeIds: await this.headerNodeIds(ctx),
      departmentIds: ctx.settings.clientEmployeeDepartmentIds(),
      excludeUserId: ctx.user.id,
    });
    return [{ id: ctx.user.id, name: ctx.user.name }, ...others];
  }

  /** المندوبون الذين يفتح المستخدم خطوطهم */
  async employees(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta, [...ITINERARY_PERMISSIONS.day]);
    this.sectionBlock(ctx);

    if (!this.canViewOthers(ctx)) return [{ id: ctx.user.id, name: ctx.user.name }];

    const scope = await ctx.teamUserIds();
    const team = scope === null ? [] : await this.itinerary.usersWithEmployees(scope);
    const seen = new Set<number>();
    return [...(await this.employeeOptions(ctx)), ...team].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }

  /** `isTargetAllowed()` — من أقسام موظفي العملاء ومن فرع الهيدر */
  private async isTargetAllowed(ctx: ClientsContext, userId: number) {
    if (userId === ctx.user.id) return true;
    const departments = ctx.settings.clientEmployeeDepartmentIds();
    const departmentsOk = departments.length === 0 || (await this.itinerary.userInDepartments(userId, departments));
    const header = await this.headerNodeIds(ctx);
    return departmentsOk && (header === null || (await this.itinerary.userInNodes(userId, header)));
  }

  // ═══════════════════════ الإضافة ═══════════════════════

  /** عملاء مُنتقي «إضافة عميل لخطّ السير» — `q` للبحث و`nodeId` لعقدة «تابع لـ» */
  async picker(userId: number, meta: RequestMeta, q: { employeeId?: number; date?: string; nodeId?: number; q?: string }) {
    const ctx = await this.contexts.load(userId, meta, [...ITINERARY_PERMISSIONS.add]);
    this.sectionBlock(ctx);

    const employeeId = q.employeeId ?? ctx.user.id;
    await this.authorizeTarget(ctx, employeeId, true);
    const date = toSqlDate(this.parseDate(ctx, q.date));

    const { allowed, header } = await this.nodeScope(ctx);
    const nodes = ctx.tree
      .pathOptions()
      .filter((o) => (allowed === null || allowed.includes(o.id)) && (header === null || header.includes(o.id)))
      .map((o) => ({ id: o.id, label: o.label, type: o.displayType }));

    const constraints = await this.scopedConstraints(ctx, q.nodeId ?? null);
    if (constraints === null) return { clients: [], total: 0, limit: PICKER_LIMIT, nodes };

    const { ids, total } = await this.itinerary.pickerClients(constraints, (q.q ?? '').trim(), PICKER_LIMIT);
    const [described, inRoute] = await Promise.all([this.itinerary.describeClients(ids), this.itinerary.openClientIds(employeeId, date)]);

    return {
      clients: ids
        .filter((id) => described.has(id))
        .map((id) => {
          const c = described.get(id)!;
          const place = ctx.tree.placeOf(c.nodeId);
          return { id, name: c.name, code: c.code, place: [place.unit, place.branch, place.region].filter(Boolean).join(' - '), inRoute: inRoute.includes(id) };
        }),
      total,
      limit: PICKER_LIMIT,
      nodes,
    };
  }

  async add(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta, [...ITINERARY_PERMISSIONS.add]);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const targetId = input.integer('employeeId', { min: 1 });
    if (targetId !== null && !(await this.itinerary.userExists(targetId))) errors.add('employeeId', 'المندوب المختار غير موجود.');
    const dateText = input.string('date');
    let date = startOfDay(ctx.now);
    if (dateText !== null) {
      const parsed = parseInputDate(dateText);
      if (!parsed) errors.add('date', 'التاريخ بصيغة YYYY-MM-DD.');
      else if (toSqlDate(parsed) < ctx.today) errors.add('date', 'لا يُضاف عميلٌ إلى خطّ يومٍ مضى.');
      else date = startOfDay(parsed);
    }
    const list = input.array('clientIds', { required: true, min: 1, max: PICKER_LIMIT, message: 'اختر عميلاً واحداً على الأقل.' }) ?? [];
    const requested: number[] = [];
    list.forEach((value, i) => {
      const id = typeof value === 'number' ? value : /^\d+$/.test(String(value ?? '').trim()) ? Number(String(value).trim()) : NaN;
      if (!Number.isInteger(id)) errors.add(`clientIds.${i}`, 'معرّف العميل يجب أن يكون عدداً صحيحاً.');
      else if (requested.includes(id)) errors.add(`clientIds.${i}`, 'العميل مكرَّر في القائمة.');
      else requested.push(id);
    });
    errors.throwIfAny();

    this.sectionBlock(ctx);
    const employeeId = targetId ?? ctx.user.id;
    await this.authorizeTarget(ctx, employeeId, true);

    if (!(await this.isTargetAllowed(ctx, employeeId))) {
      throw new AppError('TARGET_NOT_ALLOWED', 'المندوب ليس من «أقسام الموظفين المسموح تعيينهم للعملاء» أو من فرعك الحالي.', 422);
    }

    const targetName = (await this.itinerary.userName(employeeId)) ?? '';
    let result;
    try {
      result = await this.addClients(ctx, employeeId, date, requested, targetName);
    } catch (e) {
      if (e instanceof AppError) throw e;
      await this.log.failure(ctx, e, 'integration.daily_add_clients', null, LOG_MODULE);
      throw new AppError('SAVE_FAILED', 'تعذّرت الإضافة — حاول مرّةً أخرى.', 500);
    }

    if (result.locked) throw new AppError('DAY_LOCKED', 'بدأ المندوب زيارات هذا اليوم وخطُّه مقفلٌ عن التعديل (إعدادات خطوط السير).', 422);

    const skipped = [
      result.already ? `${result.already} في المسار أصلاً` : null,
      result.outOfScope ? `${result.outOfScope} خارج ما يتبعك` : null,
      result.unassigned ? `${result.unassigned} غير مُسنَد للمندوب` : null,
      result.full ? `${result.full} تجاوز سقف اليوم` : null,
    ].filter(Boolean);

    let message = result.added > 0 ? `أُضيف ${result.added} عميل إلى خطّ سير ${employeeId === ctx.user.id ? 'يومك' : `«${targetName}»`}.` : 'لم يُضف أيّ عميل.';
    if (skipped.length) message += ` تُخطّي: ${skipped.join('، ')}.`;

    if (result.added === 0) throw new AppError('NOTHING_ADDED', message, 422, result);
    return { data: result, message };
  }

  /** `addClients()` — إلى آخر خطّ اليوم، مختوماً بمن أضاف */
  private async addClients(ctx: ClientsContext, userId: number, date: Date, requested: number[], targetName: string) {
    const result = { added: 0, already: 0, outOfScope: 0, unassigned: 0, full: 0, locked: false };
    const parts = partsFor(date);
    const day = toSqlDate(date);
    const isSelf = userId === ctx.user.id;

    if (!isSelf && ctx.settings.itineraryLockAfterStart() && (await this.itinerary.isDayStarted(userId, parts.year, parts.weekNumber, parts.dayOfWeek))) {
      return { ...result, locked: true };
    }

    const constraints = (await this.scopedConstraints(ctx, null))!;
    let eligible = await this.itinerary.clientsWithin(constraints, requested);
    result.outOfScope = requested.filter((id) => !eligible.includes(id)).length;

    if (ctx.settings.restrictItineraryToAssignedClients()) {
      const assigned = await this.itinerary.assignedClientIds(userId);
      result.unassigned = eligible.filter((id) => !assigned.includes(id)).length;
      eligible = eligible.filter((id) => assigned.includes(id));
    }

    const open = await this.itinerary.openClientIds(userId, day);
    result.already = eligible.filter((id) => open.includes(id)).length;
    eligible = eligible.filter((id) => !open.includes(id));

    const max = ctx.settings.itineraryMaxClientsPerDay();
    if (max !== null) {
      const room = Math.max(0, max - (await this.itinerary.countDay(userId, day)));
      result.full = Math.max(0, eligible.length - room);
      eligible = eligible.slice(0, room);
    }

    if (!eligible.length) return result;

    await this.uow.run(async (tx) => {
      let sequence = await this.itinerary.renumberDay(userId, day, tx);
      for (const clientId of eligible) {
        const now = ctx.nowSql;
        const rowId = await this.itinerary.insertRow(
          {
            employee_id: userId,
            added_by: ctx.user.id,
            client_id: clientId,
            visit_date: day,
            day_of_week: parts.dayOfWeek,
            year: parts.year,
            week_number: parts.weekNumber,
            sequence: ++sequence,
            status: 'unactive',
            visit_status: 'planned',
            created_at: now,
            updated_at: now,
          },
          tx,
        );
        await this.clientUseCases.afterItineraryRowCreated(ctx, clientId, tx);
        result.added++;
        await this.log.record(
          ctx,
          'visit_added',
          rowId,
          `إضافة العميل #${clientId} إلى خط سير «${targetName}» ليوم ${day} من «خط سيري اليومي»`,
          { new: { client_id: clientId, employee_id: userId, visit_date: day, added_by: ctx.user.id } },
          tx,
          LOG_MODULE,
        );
      }
    });

    return result;
  }

  /** «تأجيل الزيارة» إلى آخر خطّ الغد — بأعمدة النقل نفسها */
  async postpone(userId: number, meta: RequestMeta, rowId: number) {
    const ctx = await this.contexts.load(userId, meta, ITINERARY_PERMISSIONS.postpone);
    this.sectionBlock(ctx);

    const row = await this.itinerary.row(rowId);
    if (!row) throw AppError.notFound('ROW_NOT_FOUND', 'الزيارة غير موجودة في خطّ السير.');
    await this.authorizeTarget(ctx, row.employeeId, false);

    if (this.stateOf(row, false) !== 'planned') throw new AppError('NOT_POSTPONABLE', 'لا تُؤجَّل إلا زيارةٌ لم تبدأ بعد.', 422);

    const from = startOfDay(parseLocal(row.visitDate) ?? ctx.now);
    if (toSqlDate(from) < ctx.today) throw new AppError('NOT_POSTPONABLE', 'زيارةُ يومٍ مضى لا تُؤجَّل — تُبرَّر.', 422);

    const to = addDays(from, 1);
    const toDay = toSqlDate(to);
    const parts = partsFor(to);
    const max = ctx.settings.itineraryMaxClientsPerDay();

    if (max !== null && (await this.itinerary.countDay(row.employeeId, toDay)) >= max) {
      throw new AppError('DAY_FULL', `خطُّ الغد بلغ سقفه (${max} عميلاً) — لا مكان للزيارة فيه.`, 422);
    }
    if (await this.itinerary.existsOnDay(row.employeeId, toDay, row.clientId)) throw new AppError('ALREADY_TOMORROW', 'العميل في خطّ الغد أصلاً.', 422);

    const old = { visit_date: toSqlDate(from), day_of_week: row.dayOfWeek, week_number: row.weekNumber, year: row.year };

    await this.uow.run(async (tx) => {
      const sequence = (await this.itinerary.renumberDay(row.employeeId, toDay, tx)) + 1;
      await this.itinerary.updateRow(
        row.id,
        {
          is_moved: 1,
          moved_from_day: (row.dayOfWeek ?? '').toLowerCase(),
          moved_from_week: row.weekNumber,
          moved_from_year: row.year,
          moved_at: ctx.nowSql,
          visit_date: toDay,
          day_of_week: parts.dayOfWeek,
          week_number: parts.weekNumber,
          year: parts.year,
          sequence,
          updated_at: ctx.nowSql,
        },
        tx,
      );
      await this.log.record(ctx, 'visit_postponed', row.id, `تأجيل الزيارة #${row.id} إلى ${toDay}`, {
        old,
        new: { visit_date: toDay, day_of_week: parts.dayOfWeek, week_number: parts.weekNumber, year: parts.year },
      }, tx, LOG_MODULE);
    });

    return { data: { id: row.id, visitDate: toDay }, message: 'أُجِّلت الزيارة إلى آخر خطّ الغد.' };
  }

  // ═══════════════════════ العودة ═══════════════════════

  /** صفّ خطّ سيرٍ مفتوحٌ اليوم — يُظهر العميل للمندوب من جديد (`createReturnRow()`) */
  async createReturnRow(ctx: ClientsContext, userId: number, clientId: number, plannedTime: string | null) {
    const { week, year } = getWeekAndYear(ctx.now);
    await this.itinerary.insertRow({
      employee_id: userId,
      client_id: clientId,
      day_of_week: dayNameEn(ctx.now).toLowerCase(),
      year,
      week_number: week,
      visit_date: ctx.today,
      planned_time: plannedTime,
      status: 'unactive',
      visit_status: 'planned',
      created_at: ctx.nowSql,
      updated_at: ctx.nowSql,
    });
    await this.clientUseCases.afterItineraryRowCreated(ctx, clientId);
  }

  /** «إرجاع لخطّ السير» — عميلٌ أنهى المندوب زيارته اليوم فأُخفي ويريد العودة إليه */
  async returnClient(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.workspace]);
    const client = await this.clients.find(clientId);
    if (!client) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');

    if (!ctx.settings.allowReturnFinishedClientSameDay()) {
      throw new AppError('RETURN_DISABLED', 'إرجاع العميل لخطّ السير غير مفعَّل في الإعدادات.', 403);
    }
    if (!(await this.clients.finishedTodayClientIds(ctx.user.id, ctx.today)).includes(client.id)) {
      throw new AppError('NOT_FINISHED_TODAY', 'هذا العميل ليس ممّن أنهيت زيارتهم اليوم.', 422);
    }

    await this.createReturnRow(ctx, ctx.user.id, client.id, null);
    await this.log.record(ctx, 'visit_client_returned_to_itinerary', client.id, `إرجاع العميل «${client.tradeName ?? ''}» لخطّ السير اليوم بعد إنهاء زيارته — من تطبيق الجوال`, {}, undefined, 'ClientVisitWorkspace');

    return { data: { clientId: client.id }, message: `أُرجع «${client.tradeName ?? ''}» لخطّ سيرك اليوم — يمكنك زيارته من جديد.` };
  }
}
