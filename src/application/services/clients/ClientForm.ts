import { ClientRepository, ClientRow, ClientsReferenceRepository, DocumentNumberRepository } from '../../../domain/repositories/clients';
import { BranchTree, TreeNode } from '../../../domain/services/clients/BranchTree';
import { ClientSettings } from '../../../domain/services/clients/ClientSettings';
import { ClientsContext } from './ClientsContext';
import { checkImage, FieldErrors, FormInput, UploadedFile } from './FormInput';

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

/** حقول نموذج الويب التي يكتبها التطبيق — لا غيرها (اسم التطبيق ← عمود الجدول) */
const FIELDS: Record<string, string> = {
  tradeName: 'trade_name',
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  mobile: 'mobile',
  email: 'email',
  street1: 'street1',
  street2: 'street2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  country: 'country',
  currency: 'currency',
  taxNumber: 'tax_number',
  commercialRegistration: 'commercial_registration',
  categoryId: 'category_id',
  clientType: 'client_type',
  registrationStageId: 'registration_stage_id',
  printingMethod: 'printing_method',
  notes: 'notes',
  itemQuantityLimit: 'item_quantity_limit',
};

export const CLIENT_FIELD_COLUMNS = Object.values(FIELDS);

const CONTACT_FIELDS: Record<string, string> = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', mobile: 'mobile' };

export interface ValidatedClient {
  /** الأعمدة المرسَلة فعلاً (المحذوف من الطلب لا يُلمس في التعديل) */
  fields: Record<string, unknown>;
  treeNodeId: number;
  latitude: number | null;
  longitude: number | null;
  neighborhoodManual: string | null;
  email: string | null;
  phone: string | null;
  /** `undefined` = لم تُرسَل (لا تُمسّ في التعديل) */
  contacts?: Array<Record<string, unknown>>;
  employeeIds?: number[];
  attachment: UploadedFile | null;
}

/**
 * نموذج «إضافة/تعديل عميل» — `ClientForm` و`ClientRequest` في تكامل لارافل:
 * شجرة «تابع لـ» بحدود فرع المستخدم ومجموعات مناطقه، والموظفون من الأقسام
 * المسموح إسنادها، والحقول الإلزامية من «إعدادات وحدات العملاء».
 */
export class ClientForm {
  constructor(
    private readonly clients: ClientRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly numbers: DocumentNumberRepository,
  ) {}

  /**
   * `selectableNodes()` — التقاطع بين فرع الترويسة ومجموعات مناطق الموظف،
   * والتقاطع الفارغ يعود إلى مجموعاته وحدها كي لا تخلو القائمة.
   */
  async selectableNodes(ctx: ClientsContext): Promise<TreeNode[]> {
    const tree = ctx.tree;
    const header = ctx.user.branchId ? tree.find(ctx.user.branchId) : null;
    const headerScope = header && !header.isMain ? tree.subtree(header.id) : null;

    let userScope: number[] | null = null;
    if (ctx.isEmployee && ctx.user.employeeId) {
      const groups = await this.reference.regionGroupIds(ctx.user.employeeId);
      if (groups.length) userScope = uniq(groups.flatMap((g) => [g, ...tree.descendantIds(g)]));
    }

    let scope: number[] | null = null;
    if (headerScope !== null && userScope !== null) {
      const both = headerScope.filter((id) => userScope!.includes(id));
      scope = both.length ? both : userScope;
    } else {
      scope = headerScope ?? userScope;
    }

    const nodes = scope === null ? tree.all() : tree.all().filter((n) => scope!.includes(n.id));
    return [...nodes].sort((a, b) => {
      const ca = a.code ?? '';
      const cb = b.code ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id - b.id;
    });
  }

  /** عميلٌ قائم يبقى على عقدته الحالية ولو خرجت من نطاق المعدِّل */
  async selectableNodeIds(ctx: ClientsContext, currentNodeId: number | null): Promise<number[]> {
    const ids = (await this.selectableNodes(ctx)).map((n) => n.id);
    if (currentNodeId && !ids.includes(currentNodeId)) ids.push(currentNodeId);
    return ids;
  }

  /** الشجرة مسطّحةً للتطبيق: كل عقدة بأبيها ونوعها، و`selectable` لما يُختار */
  async treeNodes(ctx: ClientsContext, keepId: number | null) {
    const nodes = new Map<number, { id: number; name: string; parentId: number | null; selectable: boolean; nodeType: string; typeLabel: string }>();
    const put = (node: TreeNode, selectable: boolean) => {
      const type = BranchTree.nodeTypeKey(node);
      nodes.set(node.id, {
        id: node.id,
        name: node.name,
        parentId: node.parentId,
        selectable: selectable || (nodes.get(node.id)?.selectable ?? false),
        nodeType: type,
        typeLabel: BranchTree.typeLabel(type),
      });
    };

    for (const node of await this.selectableNodes(ctx)) put(node, true);

    if (keepId && !nodes.has(keepId) && ctx.tree.find(keepId)) {
      for (const ancestor of ctx.tree.lineageFromRoot(keepId)) put(ancestor, ancestor.id === keepId);
    }

    return [...nodes.values()];
  }

  requiredFields(settings: ClientSettings) {
    return {
      tradeName: settings.requireTradeName(),
      phone: settings.requirePhone(),
      mobile: settings.requireMobile(),
      taxNumber: settings.requireTaxNumber(),
      email: settings.requireEmail(),
      commercialRegistration: settings.requireCommercialRegistration(),
      categoryId: settings.requireCategory(),
      registrationStageId: settings.requireRegistrationStage(),
      location: settings.isLocationRequired(),
      // `clients` بلا عمود `group_id` في هذا التثبيت — كما يفحصه الويب بـ`Schema::hasColumn`
      groupId: false,
      attachments: settings.isImageFieldEnabled(),
    };
  }

  /** قوائم النموذج كلّها في ردٍّ واحد */
  async options(ctx: ClientsContext, client: ClientRow | null, clientNodeId: number | null) {
    const canAssign = ctx.can('clients_assign_employees');
    const assigned = client ? (await this.clients.assignedEmployees(client.id)).map((e) => e.id) : [];

    const [branchTree, categories, statuses, stages, employees, nextCode] = await Promise.all([
      this.treeNodes(ctx, clientNodeId),
      this.reference.categories(),
      this.reference.assignableStatuses(),
      this.reference.registrationStages(),
      canAssign ? this.reference.assignableEmployees(ctx.settings.clientEmployeeDepartmentIds(), assigned) : Promise.resolve([]),
      client ? Promise.resolve(null) : this.numbers.peek('customer', ctx.now),
    ]);

    return {
      branchTree,
      categories,
      statuses,
      registrationStages: stages.map((s) => ({ id: s.id, name: s.name })),
      canAssignEmployees: canAssign,
      employees: employees.map((e) => ({ id: e.id, name: e.name, department: e.department })),
      clientTypeScope: ctx.settings.clientTypeScope(),
      nextCode,
      requiredFields: this.requiredFields(ctx.settings),
      maxUploadKb: ctx.settings.maxUploadSizeKb(),
    };
  }

  /**
   * قواعد `ClientRequest` كلّها، ومعها ما يتحقّق منه `store()/update()` في الويب:
   * عقدة «تابع لـ» ضمن النطاق، الإحداثيات، والموظفون المسؤولون.
   * `code` ليس هنا: رقم العميل يصدره الخادم وحده.
   */
  async validate(
    ctx: ClientsContext,
    body: Record<string, unknown>,
    files: UploadedFile[],
    client: ClientRow | null,
    clientNodeId: number | null,
  ): Promise<ValidatedClient> {
    const s = ctx.settings;
    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const isUpdate = client !== null;
    const req = (flag: boolean) => ({ required: flag });

    // ── التبعيّة في الشجرة ──
    const treeNodeId = input.integer('clientTreeBranchId', { required: true, message: 'يرجى اختيار الفرع أو المنطقة التي يتبع لها العميل.' });
    if (treeNodeId !== null && !(await this.selectableNodeIds(ctx, clientNodeId)).includes(treeNodeId)) {
      errors.add('clientTreeBranchId', 'الفرع أو المنطقة المختارة خارج صلاحيتك.');
    }

    // ── الحقول ──
    input.string('tradeName', { ...req(s.requireTradeName()), max: 255, message: 'الاسم التجاري مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    input.string('firstName', { max: 100 });
    input.string('lastName', { max: 100 });

    const phone = input.string('phone', { ...req(s.requirePhone()), max: 20, message: 'رقم الهاتف مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    if (phone !== null && s.uniquePhone() && (await this.clients.phoneTaken(phone, client?.id ?? null))) {
      errors.add('phone', 'رقم الهاتف مسجَّلٌ لعميل آخر، وتكرارُه ممنوع في إعدادات وحدات العملاء');
    }
    input.string('mobile', { ...req(s.requireMobile()), max: 20, message: 'رقم الجوّال مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });

    const email = input.email('email', { ...req(s.requireEmail()), max: 255, message: 'البريد الإلكتروني مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    if (email !== null) {
      const ignore = client ? await this.clients.loginUserId(client.id) : null;
      if (await this.clients.emailTaken(email, ignore)) {
        errors.add('email', 'هذا البريد الإلكتروني مستعمَلٌ في حسابٍ آخر بالنظام (موظّف أو عميل). اختر بريداً غير مستعمَل.');
      }
    }

    input.string('street1', { max: 255 });
    input.string('street2', { max: 255 });
    input.string('city', { max: 100 });
    input.string('region', { max: 100 });
    input.string('postalCode', { max: 20 });
    input.string('country', { max: 100 });
    input.string('currency', { max: 50 });
    input.string('taxNumber', { ...req(s.requireTaxNumber()), max: 50, message: 'الرقم الضريبي مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    input.string('commercialRegistration', { ...req(s.requireCommercialRegistration()), max: 100, message: 'السجل التجاري مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });

    const categoryId = input.integer('categoryId', { ...req(s.requireCategory()), message: 'تصنيف العميل مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    if (categoryId !== null && !(await this.reference.categories()).some((c) => c.id === categoryId)) {
      errors.add('categoryId', 'تصنيف العميل المختار غير موجود.');
    }

    const scope = s.clientTypeScope();
    const allowedTypes = scope === 'individual' ? [1] : scope === 'commercial' ? [2] : [1, 2];
    input.integer('clientType', { in: allowedTypes, message: 'نوع العميل غير مسموح — نطاق الأنواع محدَّد في إعدادات وحدات العملاء' });

    const stageId = input.integer('registrationStageId', { ...req(s.requireRegistrationStage()), message: 'وضع العميل مطلوب — الحقل إلزاميّ في إعدادات وحدات العملاء' });
    if (stageId !== null && !(await this.reference.registrationStages()).some((st) => st.id === stageId)) {
      errors.add('registrationStageId', 'وضع العميل المحدَّد غير موجود في قائمة أوضاع العملاء');
    }

    input.integer('printingMethod', { in: [1, 2] });
    input.string('notes', { max: 5000 });
    if (isUpdate) input.number('itemQuantityLimit', { min: 0 });

    // ── الصورة ──
    const attachment = files.find((f) => f.fieldname === 'attachments') ?? null;
    if (!attachment && !isUpdate && s.isImageFieldEnabled()) {
      errors.add('attachments', 'صورة العميل مطلوبة');
    } else if (attachment) {
      checkImage(errors, 'attachments', attachment, ['jpeg', 'png', 'gif'], s.maxUploadSizeKb(), {
        mimes: 'يجب أن تكون الصورة من نوع: jpeg, png, jpg, gif',
        max: 'حجم الصورة يتجاوز الحد المسموح في إعدادات وحدات العملاء',
      });
    }

    // ── الموقع ──
    const locationRequired = s.isLocationRequired();
    const locationMessage = 'حدّد موقع العميل على الخريطة — الموقع إلزاميّ في إعدادات وحدات العملاء.';
    const latitude = input.number('latitude', { required: locationRequired, min: -90, max: 90, message: locationMessage });
    const longitude = input.number('longitude', { required: locationRequired, min: -180, max: 180, message: locationMessage });
    const neighborhoodManual = input.string('neighborhoodNameManual', { max: 255 });

    // ── جهات الاتصال ──
    let contacts: Array<Record<string, unknown>> | undefined;
    if (input.has('contacts')) {
      const list = input.array('contacts', { max: 20 }) ?? [];
      contacts = list.map((item, i) => {
        const c = input.child(item, `contacts.${i}`);
        const row: Record<string, unknown> = {};
        const id = c.integer('id');
        if (id !== null) row.id = id;
        for (const [key, column] of Object.entries(CONTACT_FIELDS)) {
          if (!c.has(key)) continue;
          row[column] = key === 'email' ? c.email(key, { max: 255 }) : c.string(key, { max: key === 'firstName' || key === 'lastName' ? 100 : 20 });
        }
        return row;
      });
    }

    // ── الموظفون المسؤولون ──
    let employeeIds: number[] | undefined;
    if (input.has('employeeClientIds')) {
      const list = input.array('employeeClientIds') ?? [];
      const allowedDepartments = s.clientEmployeeDepartmentIds();
      const current = client ? (await this.clients.assignedEmployees(client.id)).map((e) => e.id) : [];
      const seen = new Set<number>();
      employeeIds = [];
      for (let i = 0; i < list.length; i++) {
        const key = `employeeClientIds.${i}`;
        const id = typeof list[i] === 'number' ? (list[i] as number) : /^\d+$/.test(String(list[i] ?? '').trim()) ? Number(String(list[i]).trim()) : NaN;
        if (!Number.isInteger(id)) {
          errors.add(key, 'معرّف الموظف يجب أن يكون عدداً صحيحاً.');
          continue;
        }
        if (seen.has(id)) {
          errors.add(key, 'الموظف مكرَّر في القائمة.');
          continue;
        }
        seen.add(id);
        const employee = await this.reference.employeeDepartment(id);
        if (!employee.exists) {
          errors.add(key, 'الموظف المختار غير موجود.');
          continue;
        }
        if (allowedDepartments.length && !current.includes(id) && !(employee.departmentId !== null && allowedDepartments.includes(employee.departmentId))) {
          errors.add(key, 'أحد الموظفين المختارين خارج الأقسام المسموح تعيينها للعملاء في إعدادات وحدات العملاء.');
          continue;
        }
        employeeIds.push(id);
      }
    }

    errors.throwIfAny();

    // الحقول المرسَلة فعلاً — بقيمها بعد التنظيف (النصّ الفارغ = null)
    const fields: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(FIELDS)) {
      if (key === 'itemQuantityLimit' && !isUpdate) continue;
      if (!input.has(key)) continue;
      fields[column] = input.raw(key);
    }

    return {
      fields,
      treeNodeId: treeNodeId!,
      latitude,
      longitude,
      neighborhoodManual,
      email,
      phone,
      contacts,
      employeeIds,
      attachment,
    };
  }
}
