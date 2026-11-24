import { LocalizedText } from './ModuleCatalog';
import { ClientSectionKey } from './ClientCatalog';
import { compact, FormDef as GenericFormDef, num } from './formsKit';

export type FormDef = GenericFormDef<ClientSectionKey>;

const t = (ar: string, en: string): LocalizedText => ({ ar, en });

/**
 * نماذج الإنشاء في وحدة العملاء. `ClientController::store()` يحسم الكثير من الحقول بنفسه
 * (الكود، الفرع المحاسبي المشتق، تخصيص الموظف الذاتي إن لم يكن للمستخدم صلاحية التخصيص) —
 * ما هنا هو ما يملؤه المستخدم فقط. الحقول التي «تُطلب بحسب إعداد» (`ClientSettingsHelper`) تصل
 * علاماتٍ (`flags`) من الخادم في وقت التعريف، ويعدّلها `adjustField` أدناه.
 */
export const CLIENT_FORMS: Partial<Record<ClientSectionKey, FormDef>> = {
  clients: {
    section: 'clients',
    title: t('عميل جديد', 'New client'),
    submitLabel: t('حفظ العميل', 'Save client'),
    createPermission: 'clients_add_client',
    path: '/clients',
    optionsForm: 'clients',
    fields: [
      { key: 'trade_name', label: t('اسم العميل / المنشأة', 'Client / business name'), type: 'text', required: true, maxLength: 255 },
      { key: 'client_tree_branch_id', label: t('الفرع', 'Branch'), type: 'select', required: true, optionsKey: 'client_tree_branch_id' },
      { key: 'category_id', label: t('التصنيف', 'Category'), type: 'select', optionsKey: 'category_id' },
      { key: 'phone', label: t('الهاتف', 'Phone'), type: 'text', maxLength: 20 },
      { key: 'mobile', label: t('الجوال', 'Mobile'), type: 'text', maxLength: 20 },
      { key: 'email', label: t('البريد الإلكتروني', 'Email'), type: 'text', maxLength: 255 },
      { key: 'tax_number', label: t('الرقم الضريبي', 'Tax number'), type: 'text', maxLength: 50 },
      { key: 'commercial_registration', label: t('السجل التجاري', 'Commercial registration'), type: 'text', maxLength: 100 },
      { key: 'city', label: t('المدينة', 'City'), type: 'text', maxLength: 100 },
      { key: 'latitude', label: t('خط العرض', 'Latitude'), type: 'number' },
      { key: 'longitude', label: t('خط الطول', 'Longitude'), type: 'number' },
      { key: 'credit_limit', label: t('حد الائتمان', 'Credit limit'), type: 'amount' },
      { key: 'credit_period', label: t('فترة السماح (أيام)', 'Credit period (days)'), type: 'number' },
      { key: 'opening_balance', label: t('الرصيد الافتتاحي', 'Opening balance'), type: 'amount' },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 1000 },
    ],
    // حقولٌ «تُطلب بحسب إعداد» — الخادم يرسل حالتها الفعلية عَلَماً بدل تثبيتها هنا
    adjustField: (f, _options, _defaults, flags) => {
      const requiredByFlag: Record<string, string> = {
        phone: 'requirePhone',
        mobile: 'requireMobile',
        email: 'requireEmail',
        tax_number: 'requireTaxNumber',
        commercial_registration: 'requireCommercialRegistration',
        category_id: 'requireCategory',
        latitude: 'locationRequired',
        longitude: 'locationRequired',
      };
      const flagKey = requiredByFlag[f.key];
      if (flagKey) return { ...f, required: Boolean(flags[flagKey]) };
      return f;
    },
    toPayload: (v) =>
      compact({
        trade_name: v.trade_name,
        client_tree_branch_id: v.client_tree_branch_id,
        category_id: v.category_id,
        phone: v.phone,
        mobile: v.mobile,
        email: v.email,
        tax_number: v.tax_number,
        commercial_registration: v.commercial_registration,
        city: v.city,
        latitude: num(v.latitude),
        longitude: num(v.longitude),
        credit_limit: num(v.credit_limit),
        credit_period: num(v.credit_period),
        opening_balance: num(v.opening_balance),
        notes: v.notes,
      }),
  },

  competitors: {
    section: 'competitors',
    title: t('منافس جديد', 'New competitor'),
    submitLabel: t('حفظ المنافس', 'Save competitor'),
    createPermission: 'clients_competitors_add',
    path: '/competitors',
    optionsForm: 'competitors',
    fields: [
      { key: 'name', label: t('اسم المنافس', 'Competitor name'), type: 'text', required: true, maxLength: 255 },
      { key: 'notes', label: t('ملاحظات', 'Notes'), type: 'multiline', maxLength: 255 },
    ],
    toPayload: (v) => compact({ name: v.name, notes: v.notes }),
  },
};
