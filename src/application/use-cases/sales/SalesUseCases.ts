import { User } from '../../../domain/entities';
import { SalesListQuery as RepoListQuery, SalesOverviewFigures, SalesScope } from '../../../domain/entities/sales';
import { AppError } from '../../../domain/errors/AppError';
import { SalesListResult, SalesCatalogRepository } from '../../../domain/repositories/salesCatalog';
import { resolveSalesSections, SalesSectionKey } from '../../../domain/services/SalesCatalog';
import { DataScopeService } from '../../services/DataScopeService';
import { PeriodResolver, ResolvedPeriod } from '../../services/PeriodResolver';
import { SalesAccess } from '../../services/SalesAccess';

export interface SalesListParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
  period?: string;
}

export interface PeriodDTO {
  key: string | null;
  label: string;
  isDefault: boolean;
  unconfigured: boolean;
  from: string | null;
  to: string | null;
}

export interface SalesListDTO<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  period: PeriodDTO | null;
}

const clamp = (n: number | undefined, min: number, max: number, fallback: number) => (n && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback);

/**
 * وحدة المبيعات — عرضٌ فقط في هذه المرحلة. النطاق محورٌ واحد كما في الويب (`ScopesSalesVisibility`):
 * إمّا بلا قيد لحاملي `data_scope_all` (أو من لا نطاق دورٍ له ولا سجلّ موظف — «مديرٌ قديم»، وهو ما
 * تحسبه `DataScopeService.state()` نفسها موحَّداً)، وإلا فمنشئ المستند أو مندوبه المُسنَد معاً (`OR`)
 * ضمن نطاق الدور (`data_scope_*`) — لا فرعٌ هنا (تبسيطٌ مقصود: عمود الفرع على مستندات المبيعات
 * غير موحَّدٍ بين الفواتير والمرتجعات في هذه القاعدة).
 *
 * الفترة الافتراضية للقوائم هي السنة المالية الجارية، بالمُحلِّل نفسه الذي تستعمله الحسابات.
 */
export class SalesUseCases {
  constructor(
    private readonly guard: SalesAccess,
    private readonly dataScope: DataScopeService,
    private readonly periods: PeriodResolver,
    private readonly repo: SalesCatalogRepository,
  ) {}

  async sections(userId: number) {
    const { ctx } = await this.guard.load(userId);
    return { groups: resolveSalesSections(ctx) };
  }

  private paging(p: SalesListParams): RepoListQuery {
    return { page: clamp(p.page, 1, 100000, 1), perPage: clamp(p.perPage, 1, 50, 20), search: p.search?.trim() || undefined, status: p.status };
  }

  private periodDto(p: ResolvedPeriod): PeriodDTO {
    return { key: p.key, label: p.label, isDefault: p.isDefault, unconfigured: p.unconfigured, from: p.from, to: p.to };
  }

  private shape<T>(r: SalesListResult<T>, period: ResolvedPeriod): SalesListDTO<T> {
    return { items: r.items, total: r.total, page: r.page, perPage: r.perPage, period: this.periodDto(period) };
  }

  private async scope(user: User, permissions: Set<string>): Promise<SalesScope> {
    const state = await this.dataScope.state(user, permissions);
    if (state.unrestricted) return { mode: 'unrestricted' };

    const [userIds, employeeIds] = await Promise.all([this.dataScope.accessibleUserIds(user, permissions, state), this.dataScope.accessibleEmployeeIds(user, permissions, state)]);

    // `null` من الخدمة يعني «بلا قيد على هذا المحور وحده» — نادرٌ هنا لأن `state.unrestricted` غطّى الحالة العامة أعلاه
    return { mode: 'scoped', userIds: userIds ?? [user.id], employeeIds: employeeIds ?? [] };
  }

  async overview(userId: number, periodKey?: string): Promise<{ figures: SalesOverviewFigures; period: PeriodDTO }> {
    const { user, ctx } = await this.guard.load(userId);
    this.guard.assertSection('overview', ctx);

    const groups = resolveSalesSections(ctx);
    const visible = new Set(groups.flatMap((g) => g.items.map((i) => (i.locked ? null : i.key))).filter(Boolean));
    const [scope, period] = await Promise.all([this.scope(user, ctx.permissions), this.periods.resolve(periodKey)]);

    const figures = await this.repo.overview(scope, { from: period.from, to: period.to }, {
      invoices: visible.has('invoices'),
      quotes: visible.has('quotes'),
      payments: visible.has('payments'),
    });

    return { figures, period: this.periodDto(period) };
  }

  async list(userId: number, section: SalesSectionKey, params: SalesListParams): Promise<SalesListDTO<unknown>> {
    const { user, ctx } = await this.guard.load(userId);
    this.guard.assertSection(section, ctx);

    const paging = this.paging(params);
    const [scope, period] = await Promise.all([this.scope(user, ctx.permissions), this.periods.resolve(params.period)]);

    switch (section) {
      case 'invoices':
        return this.shape(await this.repo.invoices(scope, { from: period.from, to: period.to }, paging), period);
      case 'quotes':
        return this.shape(await this.repo.quotes(scope, { from: period.from, to: period.to }, paging), period);
      case 'returns':
        return this.shape(await this.repo.returns(scope, { from: period.from, to: period.to }, paging), period);
      case 'credit_notes':
        return this.shape(await this.repo.creditNotes(scope, { from: period.from, to: period.to }, paging), period);
      case 'payments':
        return this.shape(await this.repo.payments(scope, { from: period.from, to: period.to }, paging), period);
      default:
        throw AppError.notFound('SECTION_NOT_FOUND', 'القسم غير موجود.');
    }
  }
}
