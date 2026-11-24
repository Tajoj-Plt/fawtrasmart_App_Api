import { AppError } from '../../../domain/errors/AppError';
import { ClientRepository, ClientScope } from '../../../domain/repositories/clients';
import { todayContext } from '../../../domain/services/clients/WeekCalendar';
import { ClientsContext } from './ClientsContext';

const uniq = (ids: number[]) => Array.from(new Set(ids.map(Number)));

/**
 * «أيّ العملاء أرى» — سلسلة شاشة «إدارة العملاء» في الويب
 * (`ClientAccessService` و`ClientController::index()`) منسوخةً بترتيبها:
 *
 *   ١. `clients_view_all_clients` ⇒ الكلّ، محصوراً بشجرة فرع المستخدم (الرئيسيّ بلا حصر).
 *   ٢. وإلا أوّل صلاحيةٍ يملكها من: خطّ السير اليومي ← مجموعات الموظفين ← عملاؤه.
 *      لا انتقال بينها: نطاقُ الأولى فارغٌ = لا عملاء.
 *   ٣. وإلا: الموظف ⇒ خطّ سير اليوم، ومن له فرع ⇒ شجرة فرعه، وغيرهما لا شيء.
 */
export class ClientVisibility {
  constructor(private readonly clients: ClientRepository) {}

  scope(ctx: ClientsContext): Promise<ClientScope> {
    return ctx.remember('clientScope', () => this.compute(ctx));
  }

  private treeScope(ids: number[] | null): ClientScope {
    if (ids === null) return { kind: 'all' };
    return { kind: 'tree', nodeIds: ids };
  }

  private async compute(ctx: ClientsContext): Promise<ClientScope> {
    if (ctx.can('clients_view_all_clients')) return this.treeScope(ctx.userBranchTreeScope());

    const cascade = await this.permissionCascade(ctx);
    if (cascade !== null) return cascade;

    if (ctx.isEmployee) {
      const ids = await this.todayItineraryClientIds(ctx);
      return ids.length ? { kind: 'ids', ids } : { kind: 'none' };
    }

    if (ctx.user.branchId) return this.treeScope(ctx.userBranchTreeScope());

    return { kind: 'none' };
  }

  /** `applyPermissionCascade()` — `null` حين لا يملك أيّاً من الثلاث */
  private async permissionCascade(ctx: ClientsContext): Promise<ClientScope | null> {
    let ids: number[];

    if (ctx.can('clients_view_by_daily_itinerary')) {
      ids = await this.todayItineraryClientIds(ctx);
    } else if (ctx.can('clients_view_by_employee_groups')) {
      const groupIds = await this.clients.employeeGroupIds(await this.scopeEmployeeIds(ctx));
      if (groupIds.length) return { kind: 'regions', groupIds: uniq(groupIds) };
      ids = [];
    } else if (ctx.can('clients_view_own_clients')) {
      ids = await this.clients.assignedClientIds(await this.scopeEmployeeIds(ctx));
    } else {
      return null;
    }

    return ids.length ? { kind: 'ids', ids: uniq(ids) } : { kind: 'none' };
  }

  /** `todayItineraryClientIds()` — له ولمن يديره (`employee_id` = `users.id`) */
  private async todayItineraryClientIds(ctx: ClientsContext): Promise<number[]> {
    const { dayNameEn, year, week } = todayContext(ctx.now);
    const userIds = await ctx.documentUserIds();
    return uniq(await this.clients.itineraryClientIds(userIds === null ? null : uniq([...userIds, ctx.user.id]), dayNameEn, year, week));
  }

  /** `scopeEmployeeIds()` — لا تُعيد `null`: بلا قيد = الموظفون كلّهم ومعهم هو */
  private async scopeEmployeeIds(ctx: ClientsContext): Promise<number[]> {
    const ids = await ctx.documentEmployeeIds();
    if (ids !== null) return ids;
    return uniq([...(await this.clients.allEmployeeIds()), ...(ctx.user.employeeId ? [ctx.user.employeeId] : [])]);
  }

  /** `canAccessClient()` — الحارس على كل عميلٍ بعينه */
  async canAccess(ctx: ClientsContext, clientId: number): Promise<boolean> {
    return this.clients.inScope(await this.scope(ctx), clientId);
  }

  async assertAccess(ctx: ClientsContext, clientId: number, message = 'لا تملك صلاحية الوصول إلى هذا العميل.') {
    if (!(await this.canAccess(ctx, clientId))) throw AppError.forbidden('CLIENT_FORBIDDEN', message);
  }

  /**
   * استبعادات قائمة العمل اليومية: من أنهى المندوب زيارتهم اليوم (لمن لا يرى
   * الكلّ، أو دائماً في وضع خطّ السير)، والعملاء المُخفَون من خريطته.
   */
  async excludedIds(ctx: ClientsContext, forceHideFinished = false): Promise<number[]> {
    const out: number[] = [];
    if (forceHideFinished || !ctx.can('clients_view_all_clients')) out.push(...(await this.hiddenFinishedClientIds(ctx)));
    out.push(...(await this.clients.hiddenClientIds(ctx.user.id, ctx.nowSql, ctx.dayStartSql)));
    return uniq(out);
  }

  /** `EmployeeClientVisit::hiddenFinishedClientIdsFor()` — لا أحد متى أُطفئ الإخفاء في الإعدادات */
  async hiddenFinishedClientIds(ctx: ClientsContext): Promise<number[]> {
    if (!ctx.settings.hideFinishedVisitClients()) return [];
    return this.clients.finishedTodayClientIds(ctx.user.id, ctx.today);
  }

  /**
   * فلتر «الفرع» من التطبيق — العقدة مع ما تحتها (أو وحدها). خارج ما يحقّ له
   * اختياره يُرفض صراحةً لا يُتجاهَل بصمت.
   */
  async branchFilter(ctx: ClientsContext, branchId: number | undefined, withDescendants: boolean): Promise<number[] | undefined> {
    if (!branchId) return undefined;
    const allowed = await ctx.selectableBranchIds();
    if (allowed !== null && !allowed.includes(branchId)) {
      throw AppError.forbidden('BRANCH_FORBIDDEN', 'الفرع المختار خارج نطاق صلاحيتك.');
    }
    return this.treeNodeIds(ctx, branchId, withDescendants);
  }

  /** `Client::scopeInTreeNode()` — عقدةٌ غير موجودة = لا شيء */
  treeNodeIds(ctx: ClientsContext, nodeId: number, withDescendants: boolean): number[] {
    if (!ctx.tree.find(nodeId)) return [];
    return withDescendants ? ctx.tree.subtree(nodeId) : [nodeId];
  }
}
