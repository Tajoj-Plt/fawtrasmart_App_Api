import { Geocoder } from '../../application/ports';

/** `getNeighborhoodFromGoogle()` — اسم الحيّ من الإحداثيات، بمهلة خمس ثوانٍ كي لا يعلق الحفظ */
export class GoogleGeocoder implements Geocoder {
  constructor(private readonly apiKey: string | undefined) {}

  async neighborhood(lat: number | null, lng: number | null): Promise<string | null> {
    if (!this.apiKey || lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(this.apiKey)}&language=ar`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = (await res.json()) as { results?: Array<{ address_components?: Array<{ long_name?: string; types?: string[] }> }> };
      for (const c of json.results?.[0]?.address_components ?? []) {
        if (c.types?.includes('sublocality') || c.types?.includes('neighborhood')) return c.long_name ?? null;
      }
    } catch {
      // الحيّ تفصيلٌ لا يُسقط الحفظ
    }

    return null;
  }
}
