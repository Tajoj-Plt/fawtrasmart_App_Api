import { AppError } from '../../../domain/errors/AppError';
import { CurrentLocation, TrackingRepository } from '../../../domain/repositories/followup';
import { metersBetween, round } from '../../../domain/services/clients/Geo';
import { addDays, addMinutes, diffInSecondsAbs, localNow, parseLocal, toSqlDate, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { UnitOfWork } from '../../ports';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog } from '../../services/clients/ClientsSupport';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';

const MIN_METERS = 2;
const MIN_SECONDS = 60;
const LIVE_MINUTES = 15;

export const TRACKING_PERMISSIONS = {
  send: 'clients_itinerary_edit',
  view: ['clients_itinerary_view', 'clients_view_by_daily_itinerary'],
} as const;

/**
 * تتبّع موقع المندوب — نقاط `employee_tracking` وموقعه الحالي في `locations`
 * (صفّ الموظف بلا عميل)، بصلاحيات شاشة خطوط السير في الويب ومفتاح «تتبّع خط السير».
 */
export class TrackingUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly tracking: TrackingRepository,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly timeZone: string,
  ) {}

  private disabled(ctx: ClientsContext) {
    if (!ctx.settings.isRouteTrackingEnabled()) throw new AppError('TRACKING_DISABLED', 'تتبّع خط السير معطَّل من إعدادات العملاء.', 403);
  }

  /** وقت النقطة كما يقرؤه `Carbon::parse()`: بإزاحةٍ صريحة يُحوَّل لتوقيت النظام، وبلا إزاحة يُقرأ بتوقيته */
  private pointTime(value: string): Date | null {
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : localNow(this.timeZone, d);
    }
    return parseLocal(value.replace('T', ' '));
  }

  async store(userId: number, meta: RequestMeta, body: Record<string, unknown>) {
    const ctx = await this.contexts.load(userId, meta, TRACKING_PERMISSIONS.send);
    this.disabled(ctx);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const batch = input.has('points');
    const points: Array<{ lat: number; lng: number; at: Date }> = [];

    if (batch) {
      const list = input.array('points', { required: true, min: 1, max: 100 }) ?? [];
      list.forEach((item, i) => {
        const p = input.child(item, `points.${i}`);
        const lat = p.number('latitude', { required: true, min: -90, max: 90 });
        const lng = p.number('longitude', { required: true, min: -180, max: 180 });
        const recorded = p.string('recordedAt');
        let at: Date | null = ctx.now;
        if (recorded !== null) {
          at = this.pointTime(recorded);
          if (!at) errors.add(`points.${i}.recordedAt`, 'وقت النقطة غير صالح.');
        }
        if (lat !== null && lng !== null && at) points.push({ lat, lng, at });
      });
    } else {
      const lat = input.number('latitude', { required: true, min: -90, max: 90, message: 'الإحداثيات مطلوبة.' });
      const lng = input.number('longitude', { required: true, min: -180, max: 180, message: 'الإحداثيات مطلوبة.' });
      if (lat !== null && lng !== null) points.push({ lat, lng, at: ctx.now });
    }
    errors.throwIfAny();

    // نقاطٌ من المستقبل أو أقدم من يوم تُسقط — توقيتٌ مصنوع لا يرسم مساراً
    const latest = addMinutes(ctx.now, 2).getTime();
    const earliest = addDays(ctx.now, -1).getTime();
    const valid = points.filter((p) => p.at.getTime() <= latest && p.at.getTime() >= earliest).sort((a, b) => a.at.getTime() - b.at.getTime());
    const rejected = points.length - valid.length;

    if (!valid.length) throw new AppError('NO_VALID_POINTS', 'لم تُقبل أيّ نقطة — توقيت النقاط خارج آخر ٢٤ ساعة.', 422);

    let saved = 0;
    try {
      await this.uow.run(async (tx) => {
        let last = await this.tracking.lastPoint(ctx.user.id, tx);
        for (const point of valid) {
          const day = toSqlDate(point.at);
          if (last && last.trackingDate === day) {
            const meters = metersBetween(last.latitude, last.longitude, point.lat, point.lng);
            const seconds = diffInSecondsAbs(point.at, parseLocal(last.createdAt) ?? point.at);
            if (meters < MIN_METERS && seconds < MIN_SECONDS) continue;
          }
          const row = { latitude: point.lat, longitude: point.lng, trackingDate: day, createdAt: toSqlDateTime(point.at) };
          await this.tracking.insertPoint(ctx.user.id, row, tx);
          last = row;
          saved++;
        }
        const newest = valid[valid.length - 1];
        await this.tracking.saveCurrent(ctx.user.id, newest.lat, newest.lng, ctx.nowSql, tx);
      });
    } catch (e) {
      await this.log.failure(ctx, e, 'integration.update_location', null, 'ClientItineraries');
      throw new AppError('SAVE_FAILED', 'تعذّر حفظ الموقع — أعد الإرسال لاحقاً.', 500);
    }

    return { received: points.length, saved, skipped: valid.length - saved, rejected };
  }

  /** `TeamScope::covers()` */
  private async covers(ctx: ClientsContext, userId: number) {
    if (userId === ctx.user.id) return true;
    const team = await ctx.teamUserIds();
    return team === null || team.includes(userId);
  }

  private presentCurrent(ctx: ClientsContext, l: CurrentLocation) {
    const updated = parseLocal(l.updatedAt);
    return {
      latitude: l.latitude,
      longitude: l.longitude,
      isLive: updated ? updated.getTime() > addMinutes(ctx.now, -LIVE_MINUTES).getTime() : false,
      updatedAt: l.updatedAt,
    };
  }

  /** مسار يوم موظف (أنا افتراضاً) وموقعه الأخير */
  async path(userId: number, meta: RequestMeta, q: { employeeId?: number; date?: string }) {
    const ctx = await this.contexts.load(userId, meta, [...TRACKING_PERMISSIONS.view]);
    this.disabled(ctx);

    const employeeId = q.employeeId ?? ctx.user.id;
    if (!(await this.covers(ctx, employeeId))) throw AppError.forbidden('TRACKING_FORBIDDEN', 'لا يمكنك تتبّع موقع موظفٍ خارج فريقك.');

    const date = q.date ?? ctx.today;
    const [points, current, names] = await Promise.all([this.tracking.path(employeeId, date), this.tracking.current(employeeId), this.tracking.userNames([employeeId])]);

    let distance = 0;
    for (let i = 1; i < points.length; i++) distance += metersBetween(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);

    return {
      employee: { id: employeeId, name: names.get(employeeId) ?? null },
      date,
      current: current ? this.presentCurrent(ctx, current) : null,
      distanceKm: round(distance / 1000, 2),
      pointsCount: points.length,
      points: points.map((p) => ({ latitude: p.latitude, longitude: p.longitude, at: p.createdAt })),
    };
  }

  /** آخر موقع لكل من في فريقي خلال ٢٤ ساعة — و«مباشر» إن حُدِّث خلال ١٥ دقيقة */
  async team(userId: number, meta: RequestMeta) {
    const ctx = await this.contexts.load(userId, meta, [...TRACKING_PERMISSIONS.view]);
    this.disabled(ctx);

    const rows = await this.tracking.team(toSqlDateTime(addDays(ctx.now, -1)), await ctx.teamUserIds());
    const names = await this.tracking.userNames(rows.map((r) => r.employeeId));

    return {
      count: rows.length,
      employees: rows.map((l) => ({
        employee: { id: l.employeeId, name: names.get(l.employeeId) ?? 'موظف' },
        ...this.presentCurrent(ctx, l),
        isMe: l.employeeId === ctx.user.id,
      })),
    };
  }
}
