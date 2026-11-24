import { AppError } from '../../domain/errors/AppError';
import { logger } from '../logger';

/**
 * رفع الصور إلى النظام — خادم التطبيق مستضافٌ منفصلاً عن الويب، فلا يكتب على
 * قرص النظام؛ يرسل الملف إلى `POST {ERP}/api/mobile-media` (`MobileMediaController`
 * في لارافل) بمفتاحٍ سرّيٍّ مشترك، فيُحفظ تحت `public/` في مجلّدات الويب نفسها.
 */
export class ErpMediaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs = 20_000,
  ) {}

  private endpoint(path: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}/api/mobile-media${path}`;
  }

  private headers() {
    return { Accept: 'application/json', 'X-Media-Token': this.token ?? '' };
  }

  async put(folder: string, filename: string, buffer: Buffer, mimetype: string): Promise<void> {
    if (!this.token) throw new AppError('UPLOADS_NOT_CONFIGURED', 'رفع الصور إلى النظام غير مضبوط على الخادم (ERP_MEDIA_TOKEN).', 503);

    const form = new FormData();
    form.append('folder', folder);
    form.append('filename', filename);
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), filename);

    let status = 0;
    let body = '';
    try {
      const res = await fetch(this.endpoint(''), { method: 'POST', headers: this.headers(), body: form, signal: AbortSignal.timeout(this.timeoutMs) });
      status = res.status;
      if (res.ok) return;
      body = (await res.text()).slice(0, 300);
    } catch (e) {
      logger.warn({ err: e, folder }, 'media upload to ERP failed');
    }

    logger.warn({ status, body, folder }, 'media upload to ERP rejected');
    throw new AppError('MEDIA_UPLOAD_FAILED', 'تعذّر رفع الصورة إلى النظام — حاول مرّةً أخرى.', 502);
  }

  /** حذفٌ لا يُسقط العملية — ملفٌّ بقي على النظام أهون من عمليةٍ فشلت بسببه */
  async remove(folder: string, filename: string): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(this.endpoint('/delete'), {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, filename }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      logger.warn({ err: e, folder, filename }, 'media delete on ERP failed');
    }
  }
}
