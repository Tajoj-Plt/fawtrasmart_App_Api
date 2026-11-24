import { User } from '../../../domain/entities';
import { AppError } from '../../../domain/errors/AppError';
import { ClientRepository } from '../../../domain/repositories/clients';
import { SalesRepository } from '../../../domain/repositories/sales';
import { StockRepository } from '../../../domain/repositories/stock';
import { BranchTree, TreeNode } from '../../../domain/services/clients/BranchTree';
import { toSqlDate, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { SALES_MODULE } from '../../../domain/services/sales/SalesConstants';
import { Cache, Clock } from '../../ports';
import { AccessService } from '../AccessService';
import { ErpGate, GateRequirements } from '../access/ErpGate';
import { ClientsContextFactory, RequestMeta } from '../clients/ClientsContext';
import { ClientVisibility } from '../clients/ClientVisibility';
import { DataScopeService, DataScopeState } from '../DataScopeService';

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

export interface SalesDocumentScope {
  branchIds: number[] | null;
  userIds: number[] | null;
  employeeIds: number[] | null;
}

interface SalesDeps {
  dataScope: DataScopeService;
  sales: SalesRepository;
  stock: StockRepository;
  clients: ClientRepository;
  clientContexts: ClientsContextFactory;
  visibility: ClientVisibility;
}

/**
 * سياق طلبٍ في المبيعات — `ScopesSalesVisibility` و`SalesWarehouse` و`ClientVisibilityScope`
 * في الويب: أيّ المستندات يراها، أيّ العملاء يُفوتَر لهم، ومن أيّ مستودع.
 */
export class SalesContext {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly user: User,
    readonly permissions: Set<string>,
    readonly now: Date,
    readonly tree: BranchTree,
    readonly meta: RequestMeta,
    private readonly deps: SalesDeps,
  ) {}

  can(permission: string | string[]): boolean {
    return (Array.isArray(permission) ? permission : [permission]).some((p) => AccessService.has(this.permissions, p));
  }

  get today() {
    return toSqlDate(this.now);
  }

  get nowSql() {
    return toSqlDateTime(this.now);
  }

  get isEmployee() {
    return Boolean(this.user.employeeId);
  }

  remember<T>(key: string, producer: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, producer());
    return this.memo.get(key) as Promise<T>;
  }

  scopeState(): Promise<DataScopeState> {
    return this.remember('state', () => this.deps.dataScope.state(this.user, this.permissions));
  }

  /** `seesAllSalesDocuments()` — `data_scope_all` أو المدير القديم بلا دور */
  get seesAll(): boolean {
    return this.can('data_scope_all') || (!this.user.roleId && ['manager', 'admin', 'owner'].includes((this.user.role ?? '').trim().toLowerCase()));
  }

  /** `DataScope::documentEmployeeIds()` */
  documentEmployeeIds(): Promise<number[] | null> {
    return this.remember('docEmployees', async () => this.deps.dataScope.documentEmployees(this.user, this.permissions, await this.scopeState()));
  }

  /** `DataScope::documentUserIds()` */
  documentUserIds(): Promise<number[] | null> {
    return this.remember('docUsers', async () => this.deps.dataScope.documentUserIds(this.user, this.permissions, await this.scopeState()));
  }

  /** نطاق المستندات — `scopeSalesDocuments()`: الفرع إن كان، وإلا المنشئ أو الموظف */
  documentScope(): Promise<SalesDocumentScope> {
    return this.remember('docScope', async () => {
      if (this.seesAll) return { branchIds: null, userIds: null, employeeIds: null };
      const state = await this.scopeState();
      if (state.branchIds !== null) return { branchIds: state.branchIds, userIds: null, employeeIds: null };
      return { branchIds: null, userIds: await this.documentUserIds(), employeeIds: (await this.documentEmployeeIds()) ?? [] };
    });
  }

  /** `salesScopeIsPeopleAxis()` */
  async peopleAxis(): Promise<boolean> {
    if (this.seesAll) return false;
    const state = await this.scopeState();
    return !state.unrestricted && state.branchIds === null;
  }

  /** `applyHeaderBranchScope()` — فرع الشريط العلوي وتوابعه، إلا الرئيسيّ ومحور الأشخاص */
  headerBranchIds(): Promise<number[] | null> {
    return this.remember('header', async () => {
      if (await this.peopleAxis()) return null;
      const current = this.user.branchId;
      if (!current) return null;
      const node = this.tree.find(current);
      if (!node || node.isMain) return null;
      return this.tree.subtree(current);
    });
  }

  /** `canAccessSalesDocument()` */
  async canAccessDocument(createdBy: number | null, employeeId: number | null, branchId: number | null): Promise<boolean> {
    if (this.seesAll) return true;
    const state = await this.scopeState();
    if (state.branchIds !== null) return branchId !== null && state.branchIds.includes(branchId);
    const users = await this.documentUserIds();
    if (users === null) return true;
    if (createdBy !== null && users.includes(createdBy)) return true;
    if (employeeId === null) return false;
    return ((await this.documentEmployeeIds()) ?? []).includes(employeeId);
  }

  /** `DataScope::clampEmployee()` — مسؤول المبيعات يُقصّ على النطاق */
  async clampEmployee(requested: number | null): Promise<number | null> {
    const allowed = await this.documentEmployeeIds();
    if (allowed === null) return requested;
    if (requested && allowed.includes(requested)) return requested;
    return this.user.employeeId ?? null;
  }

  // ═══════════════════════ العملاء ═══════════════════════

  /**
   * `ClientVisibilityScope::applyDocumentSelectScope()` — عملاء المستند: نطاق الصلاحية
   * (مع زيارات اليوم المفتوحة)، وفرع الشريط العلوي حين لا قيد بالقائمة.
   */
  clientInScope(clientId: number): Promise<boolean> {
    return this.remember(`client:${clientId}`, async () => {
      const cctx = await this.deps.clientContexts.load(this.user.id, this.meta, undefined, { module: false });
      let scope = await this.deps.visibility.scope(cctx);
      // بلا صلاحياتٍ وبلا فرع ولا موظف: الويب يفتح المنتقي على الكلّ
      if (scope.kind === 'none' && !this.isEmployee && !this.user.branchId) scope = { kind: 'all' };

      if (scope.kind === 'all') {
        const node = await cctx.headerNode();
        if (!node) return true;
        return this.deps.clients.inScope({ kind: 'tree', nodeIds: cctx.tree.subtree(node) }, clientId);
      }
      if (await this.deps.clients.inScope(scope, clientId)) return true;
      return (await this.deps.sales.openWorkspaceClientIds(this.user.id, this.today)).includes(clientId);
    });
  }

  /** نطاق القرب — `ClientSettingsHelper::visitProximityRadiusKmFor($user)` */
  proximityRadiusKm(): Promise<number> {
    return this.remember('radius', async () => (await this.deps.clientContexts.load(this.user.id, this.meta, undefined, { module: false })).proximityRadiusKm());
  }

  async assertClient(clientId: number) {
    if (!(await this.clientInScope(clientId))) throw AppError.forbidden('CLIENT_OUT_OF_SCOPE', 'العميل المحدَّد خارج نطاق العملاء المسموح لك بهم.');
  }

  // ═══════════════════════ المستودعات ═══════════════════════

  /** فروع المستخدم لجمهور «فرع» — `StorehouseAccess::branchesOf()` */
  private branchesOf(): Promise<number[]> {
    return this.remember('branchesOf', async () => {
      const own = this.user.employeeId ? await this.deps.stock.employeeBranchId(this.user.employeeId) : null;
      return uniq([this.user.branchId, own, this.user.branchId].filter((v): v is number => Boolean(v)));
    });
  }

  /** `StorehouseAccess::scopeCreateInvoices()` — `null` بلا قيد */
  private createInvoiceAudience(): Promise<number[] | null> {
    return this.remember('createAudience', async () => {
      if (!this.isEmployee || this.can('data_scope_all')) return null;
      return this.deps.stock.audienceWarehouseIds(['crate_invoices_permissions', 'value_of_crate_invoices_permissions'], {
        employeeIds: [this.user.employeeId as number],
        roleId: this.user.roleId ?? 0,
        branchIds: await this.branchesOf(),
      });
    });
  }

  async canCreateInvoicesFrom(warehouseId: number): Promise<boolean> {
    const audience = await this.createInvoiceAudience();
    return audience === null || audience.includes(warehouseId);
  }

  /**
   * `SalesWarehouse::optionsFor()` — مستودعات الموظف (أو الرئيسي بحسب الإعداد)
   * مصفّاةً بصلاحية «إنشاء فاتورة»، وإلا المصدر الآخر، ومستودعاته أوّلاً.
   */
  warehouseOptions(source: 'employee' | 'main'): Promise<number[]> {
    return this.remember(`whOptions:${source}`, async () => {
      if (!this.isEmployee) return this.deps.sales.allWarehouseIds();
      const audience = await this.createInvoiceAudience();
      const filter = (ids: number[]) => (audience === null ? ids : ids.filter((id) => audience.includes(id)));

      const employeeQuery = async () => {
        const employees = await this.documentEmployeeIds();
        if (employees === null) return this.deps.sales.allWarehouseIds();
        const ids = await this.deps.stock.defaultWarehouseIds(employees.length ? employees : [this.user.employeeId as number]);
        return ids.sort((a, b) => a - b);
      };
      const mainQuery = async () => (await this.deps.stock.majorWarehouseIds()).sort((a, b) => a - b);

      let result = filter(source === 'main' ? await mainQuery() : await employeeQuery());
      if (!result.length) result = filter(source === 'main' ? await employeeQuery() : await mainQuery());

      if (result.length > 1) {
        const own = await this.deps.stock.defaultWarehouseIds([this.user.employeeId as number]);
        if (own.length) result = [...result.filter((id) => own.includes(id)), ...result.filter((id) => !own.includes(id))];
      }
      return result;
    });
  }

  /** `SalesWarehouse::resolve()` — المختار، وإلا أوّل الخيارات للموظف، وإلا الرئيسي */
  async resolveWarehouse(source: 'employee' | 'main', selected: number | null): Promise<number | null> {
    if (selected && (await this.deps.stock.warehouse(selected))) return selected;
    if (this.isEmployee) {
      const first = (await this.warehouseOptions(source))[0];
      if (first) return first;
    }
    return (await this.deps.stock.majorWarehouseIds()).sort((a, b) => a - b)[0] ?? null;
  }
}

/** يبني سياق المبيعات بعد حارس الباب: الاشتراك ← «إدارة المبيعات» ← ميزة الباقة ← الصلاحية */
export class SalesContextFactory {
  constructor(
    private readonly gate: ErpGate,
    private readonly treeNodes: () => Promise<TreeNode[]>,
    private readonly deps: SalesDeps,
    private readonly cache: Cache,
    private readonly clock: Clock,
  ) {}

  async load(userId: number, meta: RequestMeta, req: Omit<GateRequirements, 'module'> = {}): Promise<SalesContext> {
    const { user, permissions } = await this.gate.enter(userId, { module: SALES_MODULE, ...req });
    const nodes = await this.cache.wrap('clients:tree', 30, () => this.treeNodes());
    return new SalesContext(user, permissions, this.clock.now(), new BranchTree(nodes), meta, this.deps);
  }
}
