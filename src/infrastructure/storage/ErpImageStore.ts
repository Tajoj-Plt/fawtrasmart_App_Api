import { randomBytes } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { FileStorage, ImageStore } from '../../application/ports';
import { AppError } from '../../domain/errors/AppError';
import { logger } from '../logger';
import { ErpMediaClient } from './ErpMediaClient';

const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

const clean = (folder: string) => folder.replace(/^\/+|\/+$/g, '');

/**
 * صور وحدة العملاء — تُضغط هنا ثم تُرفع إلى النظام (`ErpMediaClient`) في مجلّدات
 * الويب نفسها، فتظهر في شاشات الموقع بلا فرق. الضغط نسخة `compressAndSaveImage()`:
 * أقصى بُعدٍ 1920px، وجودة JPEG تنزل كلّما كبر الملف.
 */
export class ErpImageStore implements ImageStore {
  constructor(
    private readonly media: ErpMediaClient,
    private readonly publicUrlBase: string,
  ) {}

  private static stamp(): string {
    return `${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString('hex')}`;
  }

  private static qualityFor(bytes: number): number {
    if (bytes > 10 * 1024 * 1024) return 40;
    if (bytes > 5 * 1024 * 1024) return 50;
    if (bytes > 2 * 1024 * 1024) return 60;
    return 75;
  }

  /** نوع الصورة من محتواها — الامتداد يتبعه لا اسمَ الملف المرسَل */
  private static async format(buffer: Buffer): Promise<string | null> {
    try {
      const f = (await sharp(buffer).metadata()).format;
      return f && EXT[f] ? f : null;
    } catch {
      return null;
    }
  }

  async savePhoto(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }): Promise<string> {
    const format = await ErpImageStore.format(file.buffer);

    if (format === 'jpeg' || format === 'png') {
      let out: Buffer | null = null;
      try {
        out = await sharp(file.buffer)
          .rotate()
          .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: ErpImageStore.qualityFor(file.size) })
          .toBuffer();
      } catch (e) {
        logger.warn({ err: e }, 'image compression failed — uploaded as is');
      }
      if (out) {
        const filename = `${ErpImageStore.stamp()}.jpg`;
        await this.media.put(clean(folder), filename, out, 'image/jpeg');
        return filename;
      }
    }

    return this.saveAsIs(folder, file);
  }

  async saveAsIs(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string> {
    const format = await ErpImageStore.format(file.buffer);
    if (!format) throw new AppError('UNSUPPORTED_IMAGE', 'الملف ليس صورةً صالحة.', 422);
    const filename = `${ErpImageStore.stamp()}.${EXT[format]}`;
    await this.media.put(clean(folder), filename, file.buffer, MIME[format]);
    return filename;
  }

  /** `uploadImage()` لمرفق الإذن — كما هو بلا ضغط: JPEG/PNG أو PDF، والنوع من المحتوى لا من الاسم */
  async saveDocument(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string> {
    const isPdf = file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    const format = isPdf ? 'pdf' : await ErpImageStore.format(file.buffer);
    if (format !== 'pdf' && format !== 'jpeg' && format !== 'png') throw new AppError('UNSUPPORTED_FILE', 'صيغة المرفق غير مدعومة: PDF أو صورة.', 422);
    const filename = `${ErpImageStore.stamp()}.${format === 'pdf' ? 'pdf' : EXT[format]}`;
    await this.media.put(clean(folder), filename, file.buffer, format === 'pdf' ? 'application/pdf' : MIME[format]);
    return filename;
  }

  async saveSignature(dataUrl: string | null | undefined, who: string): Promise<string | null> {
    if (!dataUrl || !dataUrl.startsWith('data:image')) return null;
    const encoded = dataUrl.split(',', 2)[1];
    if (!encoded) return null;

    const binary = Buffer.from(encoded, 'base64');
    const format = await ErpImageStore.format(binary); // صورةٌ حقيقية فقط
    if (!format) return null;

    const safeWho = who.replace(/[^A-Za-z0-9_-]/g, '') || 'x';
    const filename = `sig_${safeWho}_${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString('hex')}.${EXT[format]}`;
    await this.media.put('assets/uploads/visit_signatures', filename, binary, MIME[format]);
    return filename;
  }

  async delete(folder: string, filename: string | null | undefined): Promise<void> {
    if (!filename) return;
    await this.media.remove(clean(folder), path.basename(filename));
  }

  url(folder: string, filename: string | null | undefined): string | null {
    return filename ? `${this.publicUrlBase}/${clean(folder)}/${encodeURIComponent(filename)}` : null;
  }

  publicUrl(relativePath: string | null | undefined): string | null {
    return relativePath ? `${this.publicUrlBase}/${relativePath.replace(/^\/+/, '')}` : null;
  }
}

const AVATAR_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** الصورة الشخصية — تُرفع إلى النظام ويقرؤها الويب من `users.avatar` مباشرة */
export class ErpFileStorage implements FileStorage {
  constructor(
    private readonly media: ErpMediaClient,
    private readonly avatarDir: string,
  ) {}

  async saveAvatar(userId: number, buffer: Buffer, mimeType: string): Promise<string> {
    const ext = AVATAR_EXT[mimeType];
    if (!ext) throw new AppError('UNSUPPORTED_IMAGE', 'صيغة الصورة غير مدعومة (jpg, png, webp).', 422);

    const dir = clean(this.avatarDir);
    const filename = `u${userId}_${Date.now()}.${ext}`;
    await this.media.put(dir, filename, buffer, mimeType);
    return `${dir}/${filename}`;
  }
}
