import { AppError } from '../../../domain/errors/AppError';
import { Choice, FormDef, FormField, FormValues, validateForm } from '../../../domain/services/formsKit';
import { ErpBridge, ErpResponse } from '../../ports';
import { CreateAccessGuard } from '../../services/CreateAccessGuard';

type Lang = 'ar' | 'en';

interface ErpFormData {
  options: Record<string, Array<{ id: number | string; label: string }>>;
  defaults: Record<string, unknown>;
  flags: Record<string, boolean>;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** مفاتيح أخطاء الويب ← مفاتيح حقول النموذج — الافتراضي يُبقيها كما هي، وكل نموذجٍ يترجم ما يخصّه */
export function mapErrorKeys(errors: Record<string, string[]>, mapKey?: (key: string) => string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(errors)) {
    const mapped = mapKey ? mapKey(key) : key;
    out[mapped] = Array.from(new Set([...(out[mapped] ?? []), ...messages]));
  }
  return out;
}

/**
 * الجسر غير منشور على الـ ERP: مسارٌ مجهول (404 برسالة Laravel العامة)، أو 401 باقٍ بعد تجديد الرمز
 * (الرمز لا يُقبل لأن مسارات `api/mobile` غير موجودة). رسالةٌ صريحة بدل «رُفض الطلب» أو «غير موجود».
 * 404 من الجسر نفسه (مثل «نموذج غير معروف») يحمل رسالته فيمرّ كما هو.
 */
export function assertBridgeAvailable(res: ErpResponse): void {
  const message = String(asRecord(res.body).message ?? '');
  const routeMissing = res.status === 404 && (message === '' || /could not be found|not found/i.test(message));
  if (routeMissing || res.status === 401) {
    throw new AppError('ERP_BRIDGE_UNAVAILABLE', 'خدمة الإضافة غير منشورة على نظام الإدارة بعد — يلزم نشر ملفات api/mobile على خادم الـ ERP.', 503);
  }
}

/**
 * نتيجة الويب ← نجاح أو خطأ بشكلٍ موحَّد. لا تُسرَّب تفاصيل الأخطاء الداخلية (5xx) للتطبيق.
 * بعض فروع الويب تُرجع `success:false` بحالة 200، وبعضها تحويلاً حوَّله `MobileApiContext` إلى
 * `{success:false, message}` بلا `errors` (قواعد تجارية بلا خطأ حقلٍ محدَّد) — كلاهما يُعامَل فشلاً.
 */
export function interpretErpResult(res: ErpResponse, mapKey?: (key: string) => string): { message: string } {
  const body = asRecord(res.body);
  const message = typeof body.message === 'string' ? body.message : '';

  if (res.status >= 200 && res.status < 300 && body.success !== false) return { message: message || 'OK' };

  if (res.status === 422 || (res.status < 300 && body.success === false)) {
    const errors = asRecord(body.errors) as Record<string, string[]>;
    throw AppError.validation(mapErrorKeys(errors, mapKey), message || 'Validation failed');
  }
  if (res.status === 402) throw new AppError(typeof body.code === 'string' ? body.code : 'PLAN_LIMIT_REACHED', message || 'حدّ الباقة', 402);
  if (res.status === 403) throw new AppError('ERP_FORBIDDEN', message || 'ليست لديك صلاحية.', 403);
  if (res.status === 404) throw AppError.notFound('ERP_NOT_FOUND', message || 'غير موجود.');
  if (res.status === 429) throw new AppError('ERP_RATE_LIMITED', 'طلبات كثيرة، حاول بعد قليل.', 429);
  if (res.status >= 500) throw new AppError('ERP_ERROR', 'تعذّر تنفيذ العملية في نظام الإدارة.', 502);

  throw new AppError('ERP_REJECTED', message || 'رُفض الطلب.', 422);
}

/**
 * أساسٌ عام لاستعمالات نماذج الإنشاء عبر أي وحدة: الخادم يصف النموذج (`definition`)، ويبحث في
 * قوائمه الكبيرة (`searchOptions`)، وينفّذ الإنشاء (`create`) باستدعاء متحكّم الويب نفسه عبر الجسر.
 * كل وحدة (حسابات/عملاء/مخزون/مبيعات) تبني `XFormsUseCases extends GenericFormsUseCases<K>` فوق هذا،
 * وتضيف استعلامات النموذج الخاصة بها فقط (كاقتراح كودٍ محاسبي أو دفتر شيكات).
 */
export class GenericFormsUseCases<K extends string> {
  constructor(
    protected readonly guard: CreateAccessGuard<K>,
    protected readonly bridge: ErpBridge,
    /** مقطع مسار الجسر (`/api/mobile/{module}/...`) */
    protected readonly moduleName: string,
    protected readonly forms: Partial<Record<K, FormDef<K>>>,
  ) {}

  protected def(section: string): FormDef<K> {
    const def = this.forms[section as K];
    if (!def) throw AppError.notFound('FORM_NOT_FOUND', 'لا يوجد نموذج إضافة لهذا القسم.');
    return def;
  }

  protected async authorize(userId: number, section: string) {
    const def = this.def(section);
    const { ctx } = await this.guard.load(userId);
    this.guard.assertCanCreate(def.section, ctx);
    return def;
  }

  protected async request(input: { userId: number; method: 'GET' | 'POST'; path: string; body?: unknown; lang: Lang }) {
    const res = await this.bridge.request({ ...input, module: this.moduleName });
    assertBridgeAvailable(res);
    return res;
  }

  /** وصف النموذج + قوائم الاختيار الأولية + القيم الافتراضية */
  async definition(userId: number, section: string, lang: Lang) {
    const def = await this.authorize(userId, section);
    const res = await this.request({ userId, method: 'GET', path: `/forms/${def.optionsForm}/options`, lang });
    interpretErpResult(res, def.mapErrorKey);

    const data = asRecord(asRecord(res.body).data) as unknown as ErpFormData;
    const options = data.options ?? {};
    const defaults = data.defaults ?? {};
    const flags = data.flags ?? {};

    const fields = def.fields.map((f) => this.resolveField(f, options, defaults, flags, def));

    return { section: def.section, title: def.title, submitLabel: def.submitLabel, fields, options, defaults };
  }

  /** يحلّ الافتراضيات الرمزية (`today`, `defaults.x`) ثم يمرّ على تعديل النموذج الخاص إن وُجد */
  private resolveField(f: FormField, options: ErpFormData['options'], defaults: Record<string, unknown>, flags: Record<string, boolean>, def: FormDef<K>): FormField {
    let out: FormField = { ...f };

    if (typeof f.default === 'string') {
      if (f.default === 'today') out.default = new Date().toISOString().slice(0, 10);
      else if (f.default.startsWith('defaults.')) {
        const v = defaults[f.default.slice('defaults.'.length)];
        out.default = v === undefined || v === null ? null : (v as string | number);
      }
    }

    if (def.adjustField) out = def.adjustField(out, options, defaults, flags);

    return out;
  }

  /** بحثٌ على الخادم في قائمةٍ كبيرة (حسابات/منتجات/عملاء…) */
  async searchOptions(userId: number, section: string, field: string, q: string, lang: Lang) {
    const def = await this.authorize(userId, section);
    const res = await this.request({
      userId,
      method: 'GET',
      path: `/forms/${def.optionsForm}/options?field=${encodeURIComponent(field)}&q=${encodeURIComponent(q)}`,
      lang,
    });
    interpretErpResult(res, def.mapErrorKey);
    return asRecord(res.body).data ?? [];
  }

  async create(userId: number, section: string, values: FormValues, lang: Lang): Promise<{ message: string }> {
    const def = await this.authorize(userId, section);

    const errors = validateForm(def, values, lang);
    if (Object.keys(errors).length > 0) throw AppError.validation(errors, Object.values(errors)[0][0]);

    const res = await this.request({ userId, method: 'POST', path: def.path, body: def.toPayload(values, {}), lang });
    return interpretErpResult(res, def.mapErrorKey);
  }
}

export type { Choice };
