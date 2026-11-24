/** `App\Support\GeoDistance::metersBetween()` — نفس نصف قطر الأرض والصيغة */
const EARTH_RADIUS_METERS = 6371000.0;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return metersBetween(lat1, lon1, lat2, lon2) / 1000;
}

export const round = (value: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
