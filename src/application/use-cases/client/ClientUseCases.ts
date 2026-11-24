import { User } from '../../../domain/entities';
import { ClientOverviewFigures, ClientScope } from '../../../domain/entities/client';
import { AppError } from '../../../domain/errors/AppError';
import { ClientListResult, ClientRepository } from '../../../domain/repositories/client';
import { ClientSectionKey, resolveClientSections } from '../../../domain/services/ClientCatalog';
import { ClientAccess } from '../../services/ClientAccess';
import { currentWeekInfo } from '../../services/WeekInfo';
import { DataScopeService } from '../../services/DataScopeService';

export interface ClientListParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
  categoryId?: number;
}

export interface ClientListDTO<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

const clamp = (n: number | undefined, min: number, max: number, fallback: number) => (n && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback);

/**
 * وحدة العملاء — عرضٌ فقط في هذه المرحلة (بلا إنشاء). النطاق مختلفٌ جذرياً عن الحسابات:
 * لا عمود `created_by` على `clients` (راجع `ClientAccessService` في الويب)، فالرؤية إسنادٌ
 * (خط سير/فرق عمل/تخصيص) لا مُنشئ — انظر `resolveScope()`.
 */
export class ClientUseCases {
  constructor(
    private readonly guard: ClientAccess,
    private readonly dataScope: DataScopeService,
    private readonly repo: ClientRepository,
  ) {}

  async sections(userId: number) {
    const { ctx } = await this.guard.load(userId);
    return { groups: resolveClientSections(ctx) };
  }

  private paging(p: ClientListParams) {
    return { page: clamp(p.page, 1, 100000, 1), perPage: clamp(p.perPage, 1, 50, 20), search: p.search?.trim() || undefined, status: p.status, categoryId: p.categoryId };
  }

  private shape<T>(r: ClientListResult<T>): ClientListDTO<T> {
    return { items: r.items, total: r.total, page: r.page, perPage: r.perPage };
  }

  /**
   * ترجمة `ClientAccessService::applyPermissionCascade()` + السقوط إلى نطاق الفرع لحاملي
   * `clients_view_all_clients` — الترتيب مقصود ولا تراجع فيه، والمحوران لا يجتمعان أبداً.
   */
  private async resolveScope(user: User, permissions: Set<string>): Promise<ClientScope> {
    if (permissions.has('clients_view_all_clients')) {
      const state = await this.dataScope.state(user, permissions);
      const node = await this.dataScope.headerBranchNode(user, state);
      const branchIds = await this.dataScope.branchFilterIds(node);
      return branchIds ? { mode: 'branch', branchIds } : { mode: 'unrestricted' };
    }

    if (permissions.has('clients_view_by_daily_itinerary')) {
      // `employee_client_visits.employee_id` يحمل `users.id` — سلَّم DataScope على المستخدمين لا الموظفين
      const userIds = await this.dataScope.accessibleUserIds(user, permissions);
      if (userIds === null) return { mode: 'unrestricted' };
      const { dayOfWeek, year, week } = currentWeekInfo();
      return { mode: 'itinerary', employeeIds: Array.from(new Set([...userIds, user.id])), dayOfWeek, year, week };
    }

    if (permissions.has('clients_view_by_employee_groups') || permissions.has('clients_view_own_clients')) {
      const employeeIds = await this.dataScope.accessibleEmployeeIds(user, permissions);
      if (employeeIds === null) return { mode: 'unrestricted' };
      return { mode: 'assigned', employeeIds };
    }

    return { mode: 'none' };
  }

  async overview(userId: number): Promise<{ figures: ClientOverviewFigures }> {
    const { user, ctx, flags } = await this.guard.load(userId);
    this.guard.assertSection('overview', ctx, flags);

    const scope = await this.resolveScope(user, ctx.permissions);
    const figures = await this.repo.overview(scope);
    return { figures };
  }

  async list(userId: number, section: ClientSectionKey, params: ClientListParams): Promise<ClientListDTO<unknown>> {
    const { user, ctx, flags } = await this.guard.load(userId);
    this.guard.assertSection(section, ctx, flags);

    const paging = this.paging(params);

    if (section === 'competitors') return this.shape(await this.repo.competitors(paging));

    if (section === 'itinerary') {
      const userIds = ctx.permissions.has('clients_view_all_clients') ? null : await this.dataScope.accessibleUserIds(user, ctx.permissions);
      const { dayOfWeek, year, week } = currentWeekInfo();
      const ids = userIds === null ? null : Array.from(new Set([...userIds, user.id]));
      return this.shape(await this.repo.todayItinerary(ids, dayOfWeek, year, week, paging));
    }

    const scope = await this.resolveScope(user, ctx.permissions);

    if (section === 'clients') return this.shape(await this.repo.clients(scope, paging));
    if (section === 'doubtful_debts') return this.shape(await this.repo.doubtfulDebts(scope, paging));

    throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');
  }
}
