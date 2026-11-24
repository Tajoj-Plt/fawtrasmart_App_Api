import { createHash, randomBytes } from 'node:crypto';
import { ErpBridge, ErpResponse } from '../../application/ports';
import { AppError } from '../../domain/errors/AppError';
import { TokenRepository } from '../../domain/repositories';
import { logger } from '../logger';

const TOKEN_NAME = 'erp-bridge';
const TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * انتهاء الرمز في قاعدة البيانات: مهلة أمان فقط. يُخزَّن الوقت بتوقيت هذا الخادم (UTC) بينما يقارنه Laravel
 * بتوقيت تطبيقه، فمهلةٌ قصيرة قد تبدو منتهيةً عنده فور إنشائها. التدوير الفعلي كل 15 دقيقة (أعلاه)
 * ويحذف الرمز السابق.
 */
const DB_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** يُجدَّد قبل الانتهاء بدقيقة */
const REFRESH_MARGIN_MS = 60 * 1000;

interface CachedToken {
  bearer: string;
  expiresAt: number;
}

/**
 * ينفّذ الطلبات على الويب برمز Sanctum قصير العمر لكل مستخدم، يُنشأ في `personal_access_tokens`
 * (الجدول نفسه الذي يقرأه Laravel)، فيعمل الطلب بصلاحيات هذا المستخدم ونطاقه كما لو دخل من الويب.
 */
export class HttpErpBridge implements ErpBridge {
  private readonly cache = new Map<number, CachedToken>();
  private readonly minting = new Map<number, Promise<CachedToken>>();

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenRepository,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async mint(userId: number): Promise<CachedToken> {
    // رموز الجسر القديمة لهذا المستخدم تُحذف كي لا تتراكم
    await this.tokens.deleteAllForUser(userId, TOKEN_NAME);

    const plain = randomBytes(40).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const id = await this.tokens.create({
      userId,
      name: TOKEN_NAME,
      tokenHash: createHash('sha256').update(plain).digest('hex'),
      abilities: ['mobile:erp'],
      expiresAt: new Date(Date.now() + DB_EXPIRY_MS),
    });

    return { bearer: `${id}|${plain}`, expiresAt };
  }

  private async token(userId: number, force = false): Promise<string> {
    const hit = this.cache.get(userId);
    if (!force && hit && hit.expiresAt - Date.now() > REFRESH_MARGIN_MS) return hit.bearer;

    // طلبان متزامنان لنفس المستخدم يشتركان في إنشاء رمزٍ واحد
    let pending = this.minting.get(userId);
    if (!pending) {
      pending = this.mint(userId).finally(() => this.minting.delete(userId));
      this.minting.set(userId, pending);
    }

    const fresh = await pending;
    this.cache.set(userId, fresh);
    return fresh.bearer;
  }

  private async send(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      const aborted = (e as { name?: string }).name === 'AbortError';
      logger.warn({ err: e, cause: (e as { cause?: unknown }).cause, url }, 'ERP bridge request failed');
      if (aborted) throw new AppError('ERP_TIMEOUT', 'انتهت مهلة الاتصال بنظام الإدارة، حاول مجدداً.', 503);
      throw new AppError('ERP_UNREACHABLE', 'تعذّر الاتصال بنظام الإدارة، حاول مجدداً.', 503);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(input: { userId: number; method: 'GET' | 'POST'; module: string; path: string; body?: unknown; lang: string }): Promise<ErpResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/mobile/${input.module}${input.path}`;

    const attempt = async (force: boolean) =>
      this.send(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${await this.token(input.userId, force)}`,
          Accept: 'application/json',
          'Accept-Language': input.lang,
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      });

    let res = await attempt(false);
    // رمزٌ منتهٍ أو محذوف: يُنشأ غيره مرّة واحدة
    if (res.status === 401) res = await attempt(true);

    let body: unknown;
    try {
      body = res.text ? JSON.parse(res.text) : {};
    } catch {
      // ردٌّ ليس JSON: صفحة خطأ من الاستضافة أو الويب — لا يُعرض للمستخدم
      logger.error({ status: res.status, snippet: res.text.slice(0, 200), url }, 'ERP bridge returned a non-JSON response');
      throw new AppError('ERP_BAD_RESPONSE', 'ردّ غير متوقَّع من نظام الإدارة.', 502);
    }

    return { status: res.status, body };
  }
}
