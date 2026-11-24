import { AppError } from '../../../domain/errors/AppError';
import { SalesWriteRepository } from '../../../domain/repositories/sales';
import { kmBetween } from '../../../domain/services/clients/Geo';
import { phpRound } from '../../../domain/services/sales/SalesMath';
import { SalesContext } from './SalesContext';

/**
 * `ChecksClientProximity::clientProximityBlock()` — الموظّف عند عميله إلا بصلاحية
 * التجاوز. والموقع **الحاليّ** مطلوبٌ في الطلب: الويب يقع على آخر موقعٍ محفوظ
 * إن لم يصله موقع، فيمرّ بموقعٍ قديم.
 */
export class SalesProximity {
  constructor(private readonly writes: SalesWriteRepository) {}

  async assert(ctx: SalesContext, bypassPermission: string, clientId: number | null, latitude: number | null, longitude: number | null) {
    if (!ctx.isEmployee || ctx.can(bypassPermission) || !clientId) return;
    if (latitude === null || longitude === null) {
      throw AppError.validation({ currentLatitude: ['تعذّر تحديد موقعك الحالي. فعّل خدمة الموقع وأعد المحاولة.'] }, 'تعذّر تحديد موقعك الحالي. فعّل خدمة الموقع وأعد المحاولة.');
    }

    const existing = await this.writes.employeeLocation(ctx.user.id);
    await this.writes.saveEmployeeLocation(existing?.id ?? null, ctx.user.id, latitude, longitude, ctx.nowSql);

    const point = await this.writes.clientPoint(clientId);
    const usable = point && point.latitude !== null && point.longitude !== null && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
    if (!usable) throw new AppError('CLIENT_LOCATION_MISSING', 'لم يتم تسجيل موقع العميل! الرجاء التواصل مع الإدارة.', 422);

    const distance = kmBetween(latitude, longitude, point.latitude as number, point.longitude as number);
    const max = await ctx.proximityRadiusKm();
    if (distance > max) throw new AppError('OUT_OF_RANGE', `يجب أن تكون ضمن نطاق ${max} كيلومتر من العميل! المسافة الحالية: ${phpRound(distance, 2)} كم`, 422);
  }
}
