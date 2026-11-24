/** منافذ طبقة التطبيق — تُنفَّذ في infrastructure */

export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlSeconds: number): void;
  del(key: string | string[]): void;
  /** يقرأ من الذاكرة أو ينفّذ الدالة ويحفظ نتيجتها */
  wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T>;
}

export interface Hasher {
  compare(plain: string, hash: string): Promise<boolean>;
  /** يُنتج تجزئة يقبلها Laravel (`$2y$`) */
  hash(plain: string): Promise<string>;
}

export interface AccessTokenPayload {
  sub: number;
  rid: number | null;
  /** يتغيّر عند تغيير كلمة المرور فتسقط الرموز القديمة */
  pv: string;
}

export interface TokenService {
  signAccess(payload: AccessTokenPayload): { token: string; expiresIn: number };
  verifyAccess(token: string): AccessTokenPayload;
  /** رمز تجديد عشوائي؛ يُحفظ مجزّأً فقط */
  generateRefresh(): { plain: string; hash: string };
  hashRefresh(plain: string): string;
}

export interface FileStorage {
  /** يحفظ الملف تحت المجلد العام للنسخة الويب ويعيد المسار النسبي المحفوظ في القاعدة */
  saveAvatar(userId: number, buffer: Buffer, mimeType: string): Promise<string>;
}

export interface ErpResponse {
  status: number;
  body: unknown;
}

/**
 * جسر إلى الويب (Laravel): كل عملية إنشاء محاسبية تُنفَّذ هناك بمتحكّمات الويب نفسها،
 * فتبقى قواعد الترقيم والقيود والأرصدة والفترات وحدود الباقة في مكانٍ واحد.
 * تُرمى `AppError` عند تعذّر الوصول أو عند رفض الويب الطلب.
 */
export interface ErpBridge {
  request(input: { userId: number; method: 'GET' | 'POST'; module: string; path: string; body?: unknown; lang: string }): Promise<ErpResponse>;
}

// ─────────────────────────── وحدة العملاء ───────────────────────────

/** سياق معاملة قاعدة البيانات — معتمٌ لطبقة التطبيق، تفكّه المستودعات وحدها */
export interface Tx {
  readonly __tx: unique symbol;
}

/** تنفيذ عدّة كتاباتٍ كلّها أو لا شيء (`DB::transaction`) */
export interface UnitOfWork {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/** الوقت المحلّي للنظام («وقتٌ ساذج»، انظر domain/services/clients/LocalTime) */
export interface Clock {
  now(): Date;
}

/** صور وحدة العملاء — تُحفظ تحت `public/` في مشروع لارافل بمجلّدات الويب نفسها */
export interface ImageStore {
  /** صورة مضغوطة (أقصى بُعد 1920 وجودة بحسب الحجم) — يعيد اسم الملف */
  savePhoto(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }): Promise<string>;
  /** الملف كما هو بلا ضغط (صورة العميل في الويب لا تُضغط) — يعيد اسم الملف */
  saveAsIs(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string>;
  /** توقيع `data:image/...;base64,...` — يعيد اسم الملف أو null إن لم يكن صورة */
  saveSignature(dataUrl: string | null | undefined, who: string): Promise<string | null>;
  delete(folder: string, filename: string | null | undefined): Promise<void>;
  url(folder: string, filename: string | null | undefined): string | null;
  /** مستندٌ كما هو — صورة JPEG/PNG أو PDF (مرفق الإذن المخزني) — يعيد اسم الملف */
  saveDocument(folder: string, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string>;
  /** رابط مسارٍ نسبيّ كامل تحت public (مثل `uploads/client_notes/x.jpg`) */
  publicUrl(relativePath: string | null | undefined): string | null;
}

/** اسم الحيّ من الإحداثيات — خرائط جوجل كما في الويب، ومهلةٌ قصيرة كي لا يعلق الحفظ */
export interface Geocoder {
  neighborhood(lat: number | null, lng: number | null): Promise<string | null>;
}
