import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './ConfigError';

/**
 * كل إعدادات الخادم تُقرأ مرّة واحدة هنا وتُتحقَّق بـ zod،
 * فخطأ في `.env` يُوقف الإقلاع برسالة واضحة بدل عطلٍ صامت لاحقاً.
 */
/** عنوانٌ للنظام: يُقبل بلا http(s):// (يُضاف https://) ويُنظَّف من المسافات والشرطة الأخيرة */
const erpUrl = z
  .string()
  .trim()
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`).replace(/\/+$/, ''))
  .pipe(z.string().url());

const schema = z.object({
  // تسامح مع الأخطاء الشائعة في لوحات الاستضافة: مسافات، حروف كبيرة، «prod»
  NODE_ENV: z
    .preprocess(
      (v) => {
        if (typeof v !== 'string') return v;
        const s = v.trim().toLowerCase();
        return s === 'prod' ? 'production' : s === 'dev' ? 'development' : s;
      },
      z.enum(['development', 'test', 'production']),
    )
    .default('development'),
  /** رقم منفذ، أو مسار socket/pipe تمرّره بعض الاستضافات (Passenger, lsnode) */
  PORT: z.string().min(1).default('4000'),
  CORS_ORIGINS: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('1h'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  DB_CLIENT: z.enum(['mysql2', 'sqlite']).default('mysql2'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_DATABASE: z.string().default('fawtra'),
  DB_USERNAME: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_SQLITE_FILE: z.string().optional(),

  // يقبل العنوان بلا http(s):// ويُنظَّف من المسافات والشرطة الأخيرة
  ERP_PUBLIC_URL: z
    .string()
    .trim()
    .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`).replace(/\/+$/, ''))
    .pipe(z.string().url())
    .default('http://127.0.0.1:8000'),
  ERP_ROOT_PATH: z.string().optional(),
  /**
   * عنوان واجهة الجوال في الويب (Laravel) لتنفيذ الإنشاء؛ الافتراضي ERP_PUBLIC_URL. يُنظَّف كـ ERP_PUBLIC_URL:
   * عنوانٌ بلا http(s):// كان يُرسَل كما هو فيفشل كل طلبٍ بـ«تعذّر الاتصال بنظام الإدارة».
   */
  ERP_API_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), erpUrl.optional()),
  ERP_BRIDGE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  /** اسم المنشأة الاحتياطي في رمز QR للفاتورة حين لا «معلومات حساب» — `APP_NAME` في لارافل */
  ERP_APP_NAME: z.string().trim().default('Fawtra'),
  /** عنوان النظام الذي تُرفع إليه الصور (`POST /api/mobile-media`) — افتراضاً `ERP_PUBLIC_URL` */
  ERP_MEDIA_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), erpUrl.optional()),
  /** المفتاح السرّي المشترك مع النظام (`MOBILE_MEDIA_TOKEN` في لارافل) — بدونه لا رفع صور */
  ERP_MEDIA_TOKEN: z.string().min(16).optional(),
  AVATAR_UPLOAD_DIR: z.string().default('uploads/avatars'),
  /** منطقة وقت النظام (`config('app.timezone')` في لارافل) — كل وقتٍ تكتبه وحدة العملاء يُكتب بها كما يكتب الويب */
  APP_TIMEZONE: z.string().default('Asia/Riyadh'),
  /** مفتاح خرائط جوجل لاستنتاج اسم الحيّ من الإحداثيات (اختياري — كما في الويب) */
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  /** `FAWTRA_ENFORCE_SUBSCRIPTION` في الويب — لا عمل بلا اشتراكٍ نشط (402) */
  ENFORCE_SUBSCRIPTION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  CACHE_TTL_PERMISSIONS: z.coerce.number().int().default(60),
  CACHE_TTL_SETTINGS: z.coerce.number().int().default(300),
  CACHE_TTL_THEME: z.coerce.number().int().default(600),
});

/** لوحات الاستضافة تحفظ أحياناً القيم بمسافات أو بين علامتي اقتباس: تُنظَّف قبل التحقق */
const cleaned = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [key, typeof value === 'string' ? value.trim().replace(/^(['"])(.*)\1$/s, '$2').trim() : value]),
);

const parsed = schema.safeParse(cleaned);

if (!parsed.success) {
  // لا نُنهي العملية هنا: server.ts يلتقط الخطأ ويخدم رسالة تشخيص عبر HTTP بدل صمتٍ يظهر كـ503
  throw new ConfigError(parsed.error.flatten().fieldErrors);
}

export const env = parsed.data;

/** المنفذ الرقمي، أو النصّ كما هو إن كان مساراً */
export const listenTarget: number | string = /^\d+$/.test(env.PORT) ? Number(env.PORT) : env.PORT;
export type Env = typeof env;
export const isProduction = env.NODE_ENV === 'production';
