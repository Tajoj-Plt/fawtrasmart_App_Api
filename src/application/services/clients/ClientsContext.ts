import { User } from '../../../domain/entities';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { BranchTree } from '../../../domain/services/clients/BranchTree';
import { ClientSettings } from '../../../domain/services/clients/ClientSettings';
import { startOfDay, toSqlDate, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { Cache, Clock } from '../../ports';
import { AccessService } from '../AccessService';
import { DataScopeService, DataScopeState } from '../DataScopeService';
import { ErpGate } from '../access/ErpGate';

/** بيانات الطلب التي تُكتب في سجلّ النشاط — عنوان IP والمتصفّح والمسار */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  route: string | null;
  url: string | null;
}

const MODULE_KEY = 'customers';
const MODULE_LABEL = 'العملاء';

/**
 * كلّ ما يحتاجه طلبٌ في وحدة العملاء، محسوباً مرّةً للطلب: المستخدم وصلاحياته،
 * «الآن» بتوقيت النظام، إعدادات وحدات العملاء، شجرة الفروع، ونطاق الرؤية.
 * ما يُحسب باستعلامٍ (النطاق، الموظفون…) كسولٌ ومحفوظٌ داخل السياق.
 */
export class ClientsContext {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly user: User,
    readonly permissions: Set<string>,
    readonly now: Date,
    readonly settings: ClientSettings,
    readonly tree: BranchTree,
    readonly meta: RequestMeta,
    private readonly deps: { dataScope: DataScopeService; reference: ClientsReferenceRepository },
  ) {}

  /** `hasPermission()` — بدائل مفصولة بـ`|` أو مصفوفة، تكفي واحدة */
  can(permission: string | string[]): boolean {
    const list = Array.isArray(permission) ? permission : [permission];
    return list.some((p) => AccessService.has(this.permissions, p));
  }

  get isEmployee(): boolean {
    return this.user.employeeId !== null;
  }

  get today(): string {
    return toSqlDate(this.now);
  }

  get nowSql(): string {
    return toSqlDateTime(this.now);
  }

  get dayStartSql(): string {
    return toSqlDateTime(startOfDay(this.now));
  }

  /** قيمةٌ تُحسب مرّةً للطلب ثم تُعاد من الذاكرة */
  remember<T>(key: string, producer: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, producer());
    return this.memo.get(key) as Promise<T>;
  }

  scopeState(): Promise<DataScopeState> {
    return this.remember('state', () => this.deps.dataScope.state(this.user, this.permissions));
  }

  /** `DataScope::documentUserIds()` — `null` بلا قيد */
  async documentUserIds(): Promise<number[] | null> {
    const state = await this.scopeState();
    return this.remember('docUsers', () => this.deps.dataScope.documentUserIds(this.user, this.permissions, state));
  }

  /** `DataScope::documentEmployeeIds()` — `null` بلا قيد */
  async documentEmployeeIds(): Promise<number[] | null> {
    const state = await this.scopeState();
    return this.remember('docEmployees', () => this.deps.dataScope.documentEmployees(this.user, this.permissions, state));
  }

  /** `DataScope::selectableBranchIds()` — `null` = كل الفروع */
  async selectableBranchIds(): Promise<number[] | null> {
    const state = await this.scopeState();
    return this.remember('selectable', () => this.deps.dataScope.selectableBranchIds(state));
  }

  /** `TeamScope::userIds()` — السلَّم + هو + من تحته إدارياً */
  async teamUserIds(): Promise<number[] | null> {
    const state = await this.scopeState();
    return this.remember('team', () => this.deps.dataScope.accessibleUserIds(this.user, this.permissions, state));
  }

  /** `HeaderBranchScope::nodeId()` — فرع الشريط العلوي (`null` بلا قيد) */
  async headerNode(): Promise<number | null> {
    const state = await this.scopeState();
    return this.remember('header', () => this.deps.dataScope.headerBranchNode(this.user, state));
  }

  /** نطاق القرب لهذا الموظف — `visitProximityRadiusKmFor($user)` */
  proximityRadiusKm(): Promise<number> {
    return this.remember('radius', async () => this.settings.visitProximityRadiusKmFor(await this.deps.reference.userProximityRadius(this.user.id)));
  }

  /** `ClientAccessService::resolveUserBranchTreeScope()` — فرع المستخدم وتوابعه، والرئيسيّ بلا حصر */
  userBranchTreeScope(): number[] | null {
    const id = this.user.branchId;
    if (!id) return null;
    const node = this.tree.find(id);
    if (!node || node.isMain) return null;
    return this.tree.subtree(id);
  }
}

/**
 * يبني السياق بعد حارس الباب (`ErpGate`): الاشتراك ← مفتاح «العملاء» ← صلاحية المسار.
 */
export class ClientsContextFactory {
  constructor(
    private readonly gate: ErpGate,
    private readonly reference: ClientsReferenceRepository,
    private readonly dataScope: DataScopeService,
    private readonly cache: Cache,
    private readonly clock: Clock,
  ) {}

  async load(userId: number, meta: RequestMeta, permission?: string | string[], options: { module?: boolean } = {}): Promise<ClientsContext> {
    const { user, permissions } = await this.gate.enter(userId, {
      module: options.module === false ? undefined : { key: MODULE_KEY, label: MODULE_LABEL },
      permissions: permission ? [permission] : [],
    });

    const [rows, module, nodes] = await Promise.all([
      this.cache.wrap('clients:settings', 30, () => this.reference.settingRows()),
      this.cache.wrap('clients:module', 30, () => this.reference.moduleSettings()),
      this.cache.wrap('clients:tree', 30, () => this.reference.treeNodes()),
    ]);

    return new ClientsContext(user, permissions, this.clock.now(), new ClientSettings(rows, module), new BranchTree(nodes), meta, {
      dataScope: this.dataScope,
      reference: this.reference,
    });
  }

  /** بعد كتابةٍ تغيّر الإعدادات أو الشجرة — لا حاجة لها في وحدة العملاء اليوم */
  forget() {
    this.cache.del(['clients:settings', 'clients:module', 'clients:tree']);
  }
}
