import { User } from '../../../domain/entities';
import { AppError } from '../../../domain/errors/AppError';
import { EmployeeRepository, UserRepository } from '../../../domain/repositories';
import { ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { StockRepository, WarehouseRow } from '../../../domain/repositories/stock';
import { BranchTree } from '../../../domain/services/clients/BranchTree';
import { toSqlDate, toSqlDateTime } from '../../../domain/services/clients/LocalTime';
import { AUDIENCE, INVENTORY_MODULE, WarehouseScope } from '../../../domain/services/stock/StockConstants';
import { Cache, Clock } from '../../ports';
import { AccessService } from '../AccessService';
import { DataScopeService, DataScopeState } from '../DataScopeService';
import { ErpGate, GateRequirements } from '../access/ErpGate';
import { RequestMeta } from '../clients/ClientsContext';

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

const SCOPE_COLUMNS: Record<WarehouseScope, [string, string]> = {
  view: ['view_permissions', 'value_of_view_permissions'],
  create_invoices: ['crate_invoices_permissions', 'value_of_crate_invoices_permissions'],
  edit_stock: ['edit_stock_permissions', 'value_of_edit_stock_permissions'],
};

/**
 * سياق طلبٍ في وحدة المخزون ونطاقُه — `ScopesToEmployeeHierarchy` و`StorehouseAccess`
 * في الويب: من يرى أيّ مستودع، ومن يرى مستندات أيّ منشئ. ما يُحسب باستعلامٍ
 * محفوظٌ للطلب (`null` = بلا قيد، و`[]` = لا شيء — ولا يُخلط بينهما).
 */
export class StockContext {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly user: User,
    readonly permissions: Set<string>,
    readonly now: Date,
    readonly tree: BranchTree,
    readonly meta: RequestMeta,
    private readonly deps: { dataScope: DataScopeService; employees: EmployeeRepository; users: UserRepository; stock: StockRepository },
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

  remember<T>(key: string, producer: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, producer());
    return this.memo.get(key) as Promise<T>;
  }

  private scopeState(): Promise<DataScopeState> {
    return this.remember('state', () => this.deps.dataScope.state(this.user, this.permissions));
  }

  private team(): Promise<number[]> {
    return this.remember('team', async () => (this.user.employeeId ? this.deps.employees.descendantIds(this.user.employeeId) : []));
  }

  /** `accessibleEmployeeIds()` — السلَّم مضافاً إليه المستخدم وفريقه */
  accessibleEmployeeIds(): Promise<number[] | null> {
    return this.remember('employees', async () => {
      if (this.can('data_scope_all') || !this.user.employeeId) return null;
      const ids = await this.deps.dataScope.documentEmployees(this.user, this.permissions, await this.scopeState());
      if (ids === null) return null;
      return uniq([...ids, this.user.employeeId, ...(await this.team())]);
    });
  }

  /** `accessibleUserIds()` — منشئو المستندات المسموحون */
  accessibleUserIds(): Promise<number[] | null> {
    return this.remember('users', async () => {
      const ids = await this.deps.dataScope.documentUserIds(this.user, this.permissions, await this.scopeState());
      if (ids === null) return null;
      const team = await this.team();
      const teamUsers = team.length ? await this.deps.users.idsByEmployeeIds(team) : [];
      return uniq([...ids, this.user.id, ...teamUsers]);
    });
  }

  /** `activeBranchIds()` — فرع الشريط العلوي وتوابعه */
  private activeBranchIds(): Promise<number[] | null> {
    return this.remember('activeBranches', async () => {
      const node = await this.deps.dataScope.headerBranchNode(this.user, await this.scopeState());
      if (!node || !this.tree.find(node)) return null;
      return this.tree.subtree(node);
    });
  }

  private branchWarehouseIds(): Promise<number[] | null> {
    return this.remember('branchWarehouses', async () => {
      const branches = await this.activeBranchIds();
      return branches === null ? null : this.deps.stock.warehouseIdsInBranches(branches);
    });
  }

  private async scopeAccessibleWarehouseIds(): Promise<number[] | null> {
    const branchIds = await this.branchWarehouseIds();
    const employeeIds = await this.accessibleEmployeeIds();
    if (employeeIds === null) return branchIds;
    const byEmployee = await this.deps.stock.defaultWarehouseIds(employeeIds);
    if (branchIds === null) return byEmployee;
    return byEmployee.filter((id) => branchIds.includes(id));
  }

  /** فروع المستخدم لجمهور «فرع» — `StorehouseAccess::branchesOf()` */
  private branchesOf(): Promise<number[]> {
    return this.remember('branchesOf', async () => {
      const employeeBranch = this.user.employeeId ? await this.deps.stock.employeeBranchId(this.user.employeeId) : null;
      return uniq([this.user.branchId, employeeBranch, this.user.branchId].filter((v): v is number => Boolean(v)));
    });
  }

  private storehouseViewableIds(): Promise<number[] | null> {
    return this.remember('viewable', async () => {
      if (!this.user.employeeId || this.can('data_scope_all')) return null;
      if (!(await this.deps.stock.anyViewRestricted())) return null;
      return this.deps.stock.audienceWarehouseIds(SCOPE_COLUMNS.view, {
        employeeIds: uniq([this.user.employeeId, ...(await this.team())]),
        roleId: this.user.roleId ?? 0,
        branchIds: await this.branchesOf(),
      });
    });
  }

  /** `accessibleWarehouseIds()` — نطاق المستودعات مقاطَعاً بصلاحية «عرض المستودع» */
  accessibleWarehouseIds(): Promise<number[] | null> {
    return this.remember('warehouses', async () => {
      const base = await this.scopeAccessibleWarehouseIds();
      const viewable = await this.storehouseViewableIds();
      if (viewable === null) return base;
      if (base === null) return viewable;
      return base.filter((id) => viewable.includes(id));
    });
  }

  async canAccessWarehouse(id: number | null): Promise<boolean> {
    if (id === null) return true;
    const ids = await this.accessibleWarehouseIds();
    return ids === null || ids.includes(id);
  }

  /** `authorizeWarehouseAccess()` — 403 */
  async authorizeWarehouse(id: number | null) {
    if (!(await this.canAccessWarehouse(id))) throw AppError.forbidden('WAREHOUSE_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا المستودع.');
  }

  async canAccessCreator(createdBy: number | null): Promise<boolean> {
    const ids = await this.accessibleUserIds();
    return ids === null || ids.includes(Number(createdBy));
  }

  /** `authorizeCreatorScope()` — 403 */
  async authorizeCreator(createdBy: number | null) {
    if (!(await this.canAccessCreator(createdBy))) throw AppError.forbidden('RECORD_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا السجل.');
  }

  /** `StorehouseAccess::allows()` — صلاحيةٌ بعينها على مستودعٍ بعينه */
  async warehouseAllows(scope: WarehouseScope, w: WarehouseRow): Promise<boolean> {
    if (!this.user.employeeId || this.can('data_scope_all')) return true;
    const [type, value] = scope === 'view' ? w.view : scope === 'create_invoices' ? w.createInvoices : w.editStock;
    const audience = type ?? AUDIENCE.ALL;
    if (audience === AUDIENCE.ALL || value === null || value === '') return true;
    switch (audience) {
      case AUDIENCE.EMPLOYEE:
        return this.user.employeeId === Number(value) || (scope === 'view' && (await this.team()).includes(Number(value)));
      case AUDIENCE.JOB_ROLE:
        return (this.user.roleId ?? 0) === Number(value);
      case AUDIENCE.BRANCH:
        return (await this.branchesOf()).includes(Number(value));
      default:
        return false;
    }
  }
}

/** يبني سياق المخزون بعد حارس الباب: الاشتراك ← «إدارة المخزون» ← ميزة الباقة ← الصلاحية */
export class StockContextFactory {
  constructor(
    private readonly gate: ErpGate,
    private readonly reference: ClientsReferenceRepository,
    private readonly dataScope: DataScopeService,
    private readonly employees: EmployeeRepository,
    private readonly users: UserRepository,
    private readonly stock: StockRepository,
    private readonly cache: Cache,
    private readonly clock: Clock,
  ) {}

  async load(userId: number, meta: RequestMeta, req: Omit<GateRequirements, 'module'> = {}): Promise<StockContext> {
    const { user, permissions } = await this.gate.enter(userId, { module: INVENTORY_MODULE, ...req });
    const nodes = await this.cache.wrap('clients:tree', 30, () => this.reference.treeNodes());
    return new StockContext(user, permissions, this.clock.now(), new BranchTree(nodes), meta, {
      dataScope: this.dataScope,
      employees: this.employees,
      users: this.users,
      stock: this.stock,
    });
  }
}
