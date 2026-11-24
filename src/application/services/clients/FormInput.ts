import { AppError } from '../../../domain/errors/AppError';

/** ملفٌّ مرفوع كما يسلّمه multer (في الذاكرة) */
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** أسماء الحقول بالعربية — `validation_attributes.php` في تكامل لارافل */
const LABELS: Record<string, string> = {
  clientTreeBranchId: 'الفرع أو المنطقة',
  tradeName: 'الاسم التجاري',
  firstName: 'الاسم الأول',
  lastName: 'اسم العائلة',
  phone: 'رقم الهاتف',
  mobile: 'رقم الجوال',
  email: 'البريد الإلكتروني',
  street1: 'العنوان 1',
  street2: 'العنوان 2',
  city: 'المدينة',
  region: 'المنطقة',
  postalCode: 'الرمز البريدي',
  country: 'الدولة',
  currency: 'العملة',
  taxNumber: 'الرقم الضريبي',
  commercialRegistration: 'السجل التجاري',
  categoryId: 'تصنيف العميل',
  clientType: 'نوع العميل',
  registrationStageId: 'وضع العميل',
  printingMethod: 'طريقة الطباعة',
  notes: 'الملاحظات',
  attachments: 'المرفقات',
  latitude: 'خط العرض',
  longitude: 'خط الطول',
  neighborhoodNameManual: 'اسم الحي',
  contacts: 'جهات الاتصال',
  employeeClientIds: 'الموظفون المسؤولون',
  itemQuantityLimit: 'الحد الأقصى للكمية',
  statusId: 'الحالة',
  stageId: 'الوضع',
  managerId: 'المسؤول',
  visitId: 'الزيارة',
  employeeName: 'اسم المسؤول',
  employeePosition: 'المسمّى الوظيفي',
  employeePhone: 'جوال المسؤول',
  shift: 'الدوام',
  isPrimary: 'المسؤول الأساسي',
  invoiceId: 'الفاتورة',
  image: 'الصورة',
  clientEmployeeId: 'مسؤول العميل',
  description: 'نص الملاحظة',
  process: 'الإجراء',
  depositCount: 'عدد العهدة',
  siteType: 'نوع الموقع',
  competitorDocuments: 'مستندات المنافسين',
  currentLatitude: 'خط العرض الحالي',
  currentLongitude: 'خط الطول الحالي',
  perPage: 'عدد العناصر',
  page: 'الصفحة',
  branchId: 'الفرع',
  clientId: 'العميل',
  search: 'البحث',
  status: 'الحالة',
  sort: 'الترتيب',
  type: 'النوع',
  client: 'العميل',
  name: 'الاسم',
  employee: 'الموظف',
  registrationStage: 'الوضع',
  dateFrom: 'من تاريخ',
  dateTo: 'إلى تاريخ',
  customerTargetId: 'الهدف',
  lastInvoicePeriod: 'فترة آخر فاتورة',
  lastPaymentPeriod: 'فترة آخر دفعة',
  lastActivityPeriod: 'فترة آخر نشاط',
  includeDescendants: 'شامل التوابع',
  overCreditLimit: 'تجاوز حدّ الائتمان',
  // المخزون
  permissionType: 'نوع الإذن',
  permissionDate: 'التاريخ',
  warehouseId: 'المستودع',
  fromWarehouseId: 'المستودع المصدر',
  toWarehouseId: 'المستودع الهدف',
  details: 'التفاصيل',
  grandTotal: 'المجموع الإجمالي',
  items: 'الأصناف',
  productId: 'الصنف',
  quantity: 'الكمية',
  unitPrice: 'سعر الوحدة',
  total: 'الإجمالي',
  reason: 'سبب الرفض',
};

export const labelOf = (field: string) => LABELS[field.split('.').pop() ?? field] ?? field;

/** وجهة رسائل التحقّق — الجامع نفسه، أو جامعٌ فرعيّ يُسبق حقولَه بالمسار (`contacts.0.email`) */
export interface ErrorSink {
  add(field: string, message: string): void;
}

/** جامع أخطاء التحقّق — يُرمى 422 بالحقول ورسالةٍ أولى مفهومة */
export class FieldErrors implements ErrorSink {
  readonly errors: Record<string, string[]> = {};

  add(field: string, message: string) {
    (this.errors[field] ??= []).push(message);
  }

  has(field: string) {
    return Boolean(this.errors[field]?.length);
  }

  get empty() {
    return Object.keys(this.errors).length === 0;
  }

  throwIfAny() {
    if (this.empty) return;
    const first = Object.values(this.errors)[0][0];
    throw AppError.validation(this.errors, first);
  }
}

/** خطأ تحقّقٍ لحقلٍ واحد — `ValidationException::withMessages()` */
export function fieldError(field: string, message: string): AppError {
  return AppError.validation({ [field]: [message] }, message);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * قراءة جسم الطلب بقواعد لارافل: النصّ الفارغ = غياب القيمة
 * (`ConvertEmptyStringsToNull`)، والأرقام تصل نصوصاً من النماذج المتعدّدة الأجزاء.
 */
export class FormInput {
  constructor(private readonly body: Record<string, unknown>, readonly errors: ErrorSink = new FieldErrors()) {}

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body ?? {}, key);
  }

  raw(key: string): unknown {
    const v = this.body?.[key];
    if (typeof v === 'string') {
      const t = v.trim();
      return t === '' ? null : t;
    }
    return v === undefined ? null : v;
  }

  filled(key: string): boolean {
    const v = this.raw(key);
    return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
  }

  required(key: string, message?: string): boolean {
    if (this.filled(key)) return true;
    this.errors.add(key, message ?? `حقل «${labelOf(key)}» مطلوب.`);
    return false;
  }

  string(key: string, opts: { required?: boolean; max?: number; message?: string } = {}): string | null {
    if (!this.filled(key)) {
      if (opts.required) this.required(key, opts.message);
      return null;
    }
    const v = this.raw(key);
    if (typeof v !== 'string' && typeof v !== 'number') {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون نصاً.`);
      return null;
    }
    const s = String(v);
    if (opts.max !== undefined && [...s].length > opts.max) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب ألّا يتجاوز ${opts.max} حرفاً.`);
      return null;
    }
    return s;
  }

  integer(key: string, opts: { required?: boolean; min?: number; max?: number; in?: number[]; message?: string } = {}): number | null {
    if (!this.filled(key)) {
      if (opts.required) this.required(key, opts.message);
      return null;
    }
    const v = this.raw(key);
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^[+-]?\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n)) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون عدداً صحيحاً.`);
      return null;
    }
    if (opts.min !== undefined && n < opts.min) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب ألّا يقلّ عن ${opts.min}.`);
      return null;
    }
    if (opts.max !== undefined && n > opts.max) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب ألّا يزيد على ${opts.max}.`);
      return null;
    }
    if (opts.in && !opts.in.includes(n)) {
      this.errors.add(key, opts.message ?? `قيمة «${labelOf(key)}» غير صالحة.`);
      return null;
    }
    return n;
  }

  number(key: string, opts: { required?: boolean; min?: number; max?: number; message?: string } = {}): number | null {
    if (!this.filled(key)) {
      if (opts.required) this.required(key, opts.message);
      return null;
    }
    const v = this.raw(key);
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v) ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون رقماً.`);
      return null;
    }
    if ((opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
      const range = opts.min !== undefined && opts.max !== undefined ? `بين ${opts.min} و${opts.max}` : opts.min !== undefined ? `لا يقلّ عن ${opts.min}` : `لا يزيد على ${opts.max}`;
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون ${range}.`);
      return null;
    }
    return n;
  }

  email(key: string, opts: { required?: boolean; max?: number; message?: string } = {}): string | null {
    const s = this.string(key, opts);
    if (s === null) return null;
    if (!EMAIL.test(s)) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون بريداً إلكترونياً صالحاً.`);
      return null;
    }
    return s;
  }

  /** `boolean` في لارافل: true/false/1/0/"1"/"0" */
  boolean(key: string): boolean | null {
    if (!this.filled(key)) return null;
    const v = this.raw(key);
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون صحّاً أو خطأً.`);
    return null;
  }

  oneOf<T extends string>(key: string, values: readonly T[], opts: { required?: boolean; message?: string } = {}): T | null {
    const s = this.string(key, { required: opts.required });
    if (s === null) return null;
    if (!(values as readonly string[]).includes(s)) {
      this.errors.add(key, opts.message ?? `قيمة «${labelOf(key)}» غير صالحة.`);
      return null;
    }
    return s as T;
  }

  /** مصفوفة — تُقبل مصفوفةً أو كائناً مفهرساً (`contacts[0][x]` من النماذج) */
  array(key: string, opts: { required?: boolean; min?: number; max?: number; message?: string } = {}): unknown[] | null {
    const v = this.body?.[key];
    if (v === undefined || v === null || v === '') {
      if (opts.required) this.required(key, opts.message);
      return null;
    }
    const list = Array.isArray(v) ? v : typeof v === 'object' ? Object.values(v as Record<string, unknown>) : null;
    if (!list) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب أن يكون قائمة.`);
      return null;
    }
    if (opts.min !== undefined && list.length < opts.min) {
      this.errors.add(key, opts.message ?? `حقل «${labelOf(key)}» يجب أن يحوي ${opts.min} عناصر على الأقل.`);
      return null;
    }
    if (opts.max !== undefined && list.length > opts.max) {
      this.errors.add(key, `حقل «${labelOf(key)}» يجب ألّا يحوي أكثر من ${opts.max} عناصر.`);
      return null;
    }
    return list;
  }

  /** عنصرٌ من مصفوفة — أخطاؤه تُكتب باسم `prefix.field` في الجامع نفسه */
  child(value: unknown, prefix: string): FormInput {
    const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return new FormInput(body, { add: (field, message) => this.errors.add(`${prefix}.${field}`, message) });
  }
}

/** نوع الصورة من محتواها لا من اسمها — `image|mimes:jpeg,png,jpg,gif` */
export function imageKind(buffer: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** يتحقّق من صورةٍ مرفوعة: نوعها من المسموح وحجمها ضمن الحدّ (بالكيلوبايت) */
export function checkImage(errors: ErrorSink, field: string, file: UploadedFile, allowed: string[], maxKb: number, messages: { mimes?: string; max?: string } = {}) {
  const kind = imageKind(file.buffer);
  if (!kind || !allowed.includes(kind)) {
    errors.add(field, messages.mimes ?? `يجب أن تكون الصورة من نوع: ${allowed.join(', ')}`);
    return false;
  }
  if (file.size > maxKb * 1024) {
    errors.add(field, messages.max ?? `حجم الملف يتجاوز الحدّ المسموح (${maxKb} كيلوبايت).`);
    return false;
  }
  return true;
}
