import { User } from '../../../domain/entities';
import { StockListQuery as RepoListQuery, StockOverviewFigures, StockScope } from '../../../domain/entities/stock';
import { AppError } from '../../../domain/errors/AppError';
import { StockListResult, StockCatalogRepository } from '../../../domain/repositories/stockCatalog';
import { resolveStockSections, StockSectionKey } from '../../../domain/services/StockCatalog';
import { DataScopeService } from '../../services/DataScopeService';
import { StockAccess } from '../../services/StockAccess';

export interface StockListParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
}

export interface StockListDTO<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

const clamp = (n: number | undefined, min: number, max: number, fallback: number) => (n && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback);

/**
 * وحدة المخزون — عرضٌ فقط في هذه المرحلة. النطاق محوران يُقيَّدان معاً لا يُستبدل أحدهما بالآخر
 * (خلاف الحسابات والمبيعات): فرع المستودع (`ScopesToEmployeeHierarchy::activeBranchIds`) وتخصيص
 * الموظف بالمستودع (`default_warehouses`، عبر سلَّم `DataScope` نفسه). طبقة صلاحية العرض على
 * مستوى المستودع نفسه (`StorehouseAccess::view_permissions`) غير مُطبَّقة هنا — تبسيطٌ مقصود
 * لهذه المرحلة الأولى.
 */
export class StockUseCases {
  constructor(
    private readonly guard: StockAccess,
    private readonly dataScope: DataScopeService,
    private readonly repo: StockCatalogRepository,
  ) {}

  async sections(userId: number) {
    const { ctx } = await this.guard.load(userId);
    return { groups: resolveStockSections(ctx) };
  }

  private paging(p: StockListParams): RepoListQuery {
    return { page: clamp(p.page, 1, 100000, 1), perPage: clamp(p.perPage, 1, 50, 20), search: p.search?.trim() || undefined, status: p.status };
  }

  private shape<T>(r: StockListResult<T>): StockListDTO<T> {
    return { items: r.items, total: r.total, page: r.page, perPage: r.perPage };
  }

  /** فرع المستودع ∩ تخصيص الموظف — كلاهما يُقيَّدان معاً (`null` في كليهما = بلا قيد) */
  private async scope(user: User, permissions: Set<string>): Promise<StockScope> {
    const state = await this.dataScope.state(user, permissions);
    const node = await this.dataScope.headerBranchNode(user, state);
    const branchIds = await this.dataScope.branchFilterIds(node);
    const employeeIds = permissions.has('data_scope_all') ? null : await this.dataScope.accessibleEmployeeIds(user, permissions, state);
    const creatorIds = await this.dataScope.accessibleUserIds(user, permissions, state);

    const warehouseIds = branchIds === null && employeeIds === null ? null : await this.repo.warehouseIdsFor(branchIds, employeeIds);

    return { warehouseIds, creatorIds };
  }

  async overview(userId: number): Promise<{ figures: StockOverviewFigures }> {
    const { user, ctx } = await this.guard.load(userId);
    this.guard.assertSection('overview', ctx);

    const groups = resolveStockSections(ctx);
    const visible = new Set(groups.flatMap((g) => g.items.map((i) => (i.locked ? null : i.key))).filter(Boolean));
    const scope = await this.scope(user, ctx.permissions);

    const figures = await this.repo.overview(scope, {
      products: visible.has('products'),
      warehouses: visible.has('warehouses'),
      permits: visible.has('permits'),
      adjustments: visible.has('adjustments'),
    });

    return { figures };
  }

  async list(userId: number, section: StockSectionKey, params: StockListParams): Promise<StockListDTO<unknown>> {
    const { user, ctx } = await this.guard.load(userId);
    this.guard.assertSection(section, ctx);

    const paging = this.paging(params);
    const scope = await this.scope(user, ctx.permissions);

    switch (section) {
      case 'products':
        return this.shape(await this.repo.products(scope.warehouseIds, paging));
      case 'warehouses':
        return this.shape(await this.repo.warehouses(scope.warehouseIds, paging));
      case 'permits':
        return this.shape(await this.repo.permits(scope, paging));
      case 'adjustments':
        return this.shape(await this.repo.adjustments(scope, paging));
      default:
        throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');
    }
  }
}
