import { LocalizedText } from './ModuleCatalog';

/**
 * أساسٌ عام لوصف نماذج الإنشاء عبر الوحدات — كما بدأ في `AccountingForms.ts`. الخادم يصف الحقول
 * والويب (Laravel) ينفّذ الإنشاء بمتحكّماته نفسها، فتبقى كل القواعد التجارية (الترقيم، القيود،
 * الأرصدة، الفترات، حدود الباقة) في مكانٍ واحد. كل وحدة (حسابات/عملاء/مخزون/مبيعات) تبني نماذجها
 * فوق هذه الأنواع العامة.
 */

export type FieldType = 'text' | 'multiline' | 'number' | 'amount' | 'date' | 'select' | 'segmented' | 'switch' | 'lines';

export interface FieldCondition {
  field: string;
  in: string[];
}

export interface Choice {
  value: string;
  label: LocalizedText;
}

export interface FormField {
  key: string;
  label: LocalizedText;
  type: FieldType;
  required?: boolean;
  /** إلزامي فقط عند تحقّق الشرط */
  requiredWhen?: FieldCondition;
  /** يظهر فقط عند تحقّق الشرط */
  visibleWhen?: FieldCondition;
  placeholder?: LocalizedText;
  default?: string | number | boolean | null;
  maxLength?: number;
  /** select: مفتاح القائمة في options، أو خريطة بحسب قيمة حقلٍ آخر */
  optionsKey?: string;
  optionsKeyBy?: { field: string; map: Record<string, string> };
  /** بحثٌ على الخادم (قوائم كبيرة) */
  searchable?: boolean;
  /** segmented / select ثابت */
  choices?: Choice[];
  /** اقتراح كود تلقائي عند اختيار الأب */
  suggestCode?: { kind: string; parentField: string };
  /** بعد اختيار قيمة يُجلب ما يملأ حقولاً أخرى */
  onSelectFill?: { kind: string; fill: Record<string, string> };
  /** حقل lines: وصف أعمدته ونمط إجماليه */
  lines?: LinesSpec;
}

export interface LineColumn {
  key: string;
  label: LocalizedText;
  type: 'select' | 'number' | 'amount' | 'text';
  /** select: مفتاح القائمة في options */
  optionsKey?: string;
  /** بحثٌ على الخادم (قوائم كبيرة كالحسابات/المنتجات) */
  searchable?: boolean;
  required?: boolean;
}

export interface LinesSpec {
  min: number;
  columns: LineColumn[];
  /**
   * نمط إجمالي الأسطر: `debit_credit` (توازن مدين/دائن كقيود اليومية)،
   * `line_amount` (سطرٌ = كميةٌ×سعرٌ يُجمَع إجمالياً كأذون المخزون وفواتير المبيعات)، أو `none`.
   */
  totals: 'debit_credit' | 'line_amount' | 'none';
}

export type FormValues = Record<string, unknown>;
export type FieldErrors = Record<string, string[]>;

export interface FormDef<K extends string> {
  section: K;
  title: LocalizedText;
  submitLabel: LocalizedText;
  createPermission: string | string[];
  /** مسار الإنشاء في جسر Laravel (`/api/mobile/{module}/...`) */
  path: string;
  /** اسم النموذج في `forms/{form}/options` */
  optionsForm: string;
  fields: FormField[];
  toPayload: (values: FormValues, defaults: Record<string, unknown>) => Record<string, unknown>;
  /** يترجم مفتاح خطأٍ من الويب إلى مفتاح حقلٍ في هذا النموذج؛ الافتراضي: يبقى كما هو */
  mapErrorKey?: (key: string) => string;
  /** تحقّقٌ إضافي خاصٌّ بهذا النموذج (كتوازن قيدٍ محاسبي) — يُدمَج فوق التحقّق العام */
  validate?: (values: FormValues, lang: 'ar' | 'en', defaults: Record<string, unknown>) => FieldErrors;
  /** تعديلٌ خاصٌّ بحقلٍ بعد حلّ افتراضاته (كإخفاء خيارٍ بحسب علَمٍ من الخادم) — يُستدعى لكل حقلٍ */
  adjustField?: (field: FormField, options: Record<string, Array<{ id: number | string; label: string }>>, defaults: Record<string, unknown>, flags: Record<string, boolean>) => FormField;
}

const t = (ar: string, en: string): LocalizedText => ({ ar, en });

export const MESSAGES = {
  required: t('هذا الحقل مطلوب', 'This field is required'),
  amount: t('أدخل مبلغاً أكبر من صفر', 'Enter an amount greater than zero'),
  number: t('أدخل رقماً صحيحاً', 'Enter a valid number'),
  date: t('التاريخ غير صالح (YYYY-MM-DD)', 'Invalid date (YYYY-MM-DD)'),
  lines: t('أضف على الأقل سطرين', 'Add at least two lines'),
  lineAmount: t('أدخل مديناً أو دائناً في كل سطر لا كليهما', 'Enter either a debit or a credit per line, not both'),
  balance: t('مجموع المدين يجب أن يساوي مجموع الدائن', 'Total debit must equal total credit'),
};

/** يحذف الفارغ (`''`/null/undefined) كي لا تُرسَل حقولٌ بلا قيمة */
export const compact = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

export const today = () => new Date().toISOString().slice(0, 10);

function inCondition(cond: FieldCondition | undefined, values: FormValues, defaults: Record<string, unknown>): boolean {
  if (!cond) return true;
  const v = values[cond.field] ?? defaults[cond.field];
  return cond.in.includes(String(v ?? ''));
}

/** تحقّقٌ مبدئي سريع يوفّر رحلة الشبكة؛ التحقّق النهائي دائماً في الويب */
export function validateForm<K extends string>(def: FormDef<K>, values: FormValues, lang: 'ar' | 'en', defaults: Record<string, unknown> = {}): FieldErrors {
  const errors: FieldErrors = {};
  const msg = (k: keyof typeof MESSAGES) => MESSAGES[k][lang];
  const add = (key: string, m: string) => (errors[key] = [...(errors[key] ?? []), m]);

  for (const f of def.fields) {
    if (!inCondition(f.visibleWhen, values, defaults)) continue;

    const value = values[f.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    const required = Boolean(f.required) || (f.requiredWhen ? inCondition(f.requiredWhen, values, defaults) : false);

    if (f.type === 'switch') continue;

    if (empty) {
      if (required) add(f.key, msg('required'));
      continue;
    }

    if (f.type === 'amount') {
      const n = num(value);
      if (n === undefined || n <= 0) add(f.key, msg('amount'));
    } else if (f.type === 'number') {
      if (num(value) === undefined) add(f.key, msg('number'));
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(Date.parse(String(value)))) add(f.key, msg('date'));
    } else if (f.type === 'lines') {
      const lines = value as Array<Record<string, unknown>>;
      const spec = f.lines;
      const min = spec?.min ?? 2;
      const requiredCols = spec?.columns.filter((c) => c.required).map((c) => c.key) ?? [];
      const filled = lines.filter((l) => requiredCols.every((k) => l[k] !== undefined && l[k] !== null && l[k] !== ''));
      if (filled.length < min) add(f.key, msg('lines'));
    }
  }

  if (def.validate) {
    for (const [key, messages] of Object.entries(def.validate(values, lang, defaults))) {
      errors[key] = [...(errors[key] ?? []), ...messages];
    }
  }

  return errors;
}

/** توازن أسطر قيدٍ محاسبي (مدين/دائن) — يُستعمل عبر `FormDef.validate` لنماذج القيود */
export function validateDebitCreditLines(linesField: string, lines: Array<Record<string, unknown>>, min: number, lang: 'ar' | 'en'): FieldErrors {
  const msg = (k: keyof typeof MESSAGES) => MESSAGES[k][lang];
  const errors: FieldErrors = {};
  const add = (m: string) => (errors[linesField] = [...(errors[linesField] ?? []), m]);

  const filled = lines.filter((l) => l.account_id);
  if (filled.length < min) return errors;

  let debit = 0;
  let credit = 0;
  for (const l of filled) {
    const d = num(l.debit) ?? 0;
    const c = num(l.credit) ?? 0;
    if ((d > 0) === (c > 0)) add(msg('lineAmount'));
    debit += d;
    credit += c;
  }
  if (Math.abs(debit - credit) > 0.001) add(msg('balance'));

  return errors;
}

export function findFormItem<K extends string>(forms: Partial<Record<K, FormDef<K>>>, key: string): FormDef<K> | null {
  return (forms as Record<string, FormDef<K> | undefined>)[key] ?? null;
}
