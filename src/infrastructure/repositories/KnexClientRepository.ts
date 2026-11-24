import { Knex } from 'knex';
import { Paginated } from '../../domain/entities/accounting';
import { ClientListQuery, ClientOverviewFigures, ClientRow, ClientScope, CompetitorRow, DoubtfulDebtRow, ItineraryVisitRow } from '../../domain/entities/client';
import { ClientListResult, ClientRepository } from '../../domain/repositories/client';
import { bool } from '../db/knex';

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** يطبّق نطاق الرؤية على استعلام `clients` — محورا المكان والأشخاص لا يجتمعان أبداً (كما في الويب) */
function applyClientScope(qb: Knex.QueryBuilder, scope: ClientScope): Knex.QueryBuilder {
  switch (scope.mode) {
    case 'unrestricted':
      return qb;
    case 'branch':
      return qb.where((q) => q.whereIn('clients.tree_node_id', scope.branchIds).orWhereIn('clients.branch_id', scope.branchIds).orWhereNull('clients.tree_node_id'));
    case 'assigned':
      return qb.whereExists((sub) =>
        sub.select(1).from('client_employee').whereRaw('client_employee.client_id = clients.id').whereIn('client_employee.employee_id', scope.employeeIds.length ? scope.employeeIds : [0]),
      );
    case 'itinerary':
      return qb.whereExists((sub) =>
        sub
          .select(1)
          .from('employee_client_visits')
          .whereRaw('employee_client_visits.client_id = clients.id')
          .where('employee_client_visits.day_of_week', scope.dayOfWeek)
          .where('employee_client_visits.year', scope.year)
          .where('employee_client_visits.week_number', scope.week)
          .whereIn('employee_client_visits.employee_id', scope.employeeIds.length ? scope.employeeIds : [0]),
      );
    case 'none':
      return qb.whereRaw('1 = 0');
  }
}

function paginate<T>(rows: T[], total: number, page: number, perPage: number): Paginated<T> {
  return { items: rows, total, page, perPage };
}

export class KnexClientRepository implements ClientRepository {
  constructor(private readonly db: Knex) {}

  private clientSelect(qb: Knex.QueryBuilder) {
    return qb
      .select(
        'clients.id',
        'clients.code',
        'clients.trade_name as name',
        'clients.phone',
        'clients.mobile',
        'clients.city',
        'clients.region',
        'clients.status_id',
        'statuses.name as status_name',
        'statuses.color as status_color',
        'categories_clients.name as category_name',
        'clients.client_type',
        'clients.credit_limit',
        'clients.employee_id',
      )
      .leftJoin('statuses', 'statuses.id', 'clients.status_id')
      .leftJoin('categories_clients', 'categories_clients.id', 'clients.category_id');
  }

  private toClientRow(r: Record<string, unknown>): ClientRow {
    return {
      id: num(r.id),
      code: r.code === null || r.code === undefined ? null : num(r.code),
      name: String(r.name ?? ''),
      phone: str(r.phone),
      mobile: str(r.mobile),
      city: str(r.city),
      region: str(r.region),
      statusId: r.status_id === null || r.status_id === undefined ? null : num(r.status_id),
      statusName: str(r.status_name),
      statusColor: str(r.status_color),
      categoryName: str(r.category_name),
      clientType: r.client_type === null || r.client_type === undefined ? null : num(r.client_type),
      creditLimit: r.credit_limit === null || r.credit_limit === undefined ? null : num(r.credit_limit),
      employeeId: r.employee_id === null || r.employee_id === undefined ? null : num(r.employee_id),
    };
  }

  async clients(scope: ClientScope, q: ClientListQuery): Promise<ClientListResult<ClientRow>> {
    const base = () => applyClientScope(this.db('clients'), scope);

    const filtered = base();
    if (q.search) {
      const like = `%${q.search}%`;
      filtered.where((w) => w.where('clients.trade_name', 'like', like).orWhere('clients.phone', 'like', like).orWhere('clients.mobile', 'like', like).orWhere('clients.code', 'like', like));
    }
    if (q.status) filtered.where('clients.status_id', Number(q.status));
    if (q.categoryId) filtered.where('clients.category_id', q.categoryId);

    const total = num((await filtered.clone().count({ n: '*' }).first())?.n);
    const rows = await this.clientSelect(filtered.clone())
      .orderBy('clients.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(rows.map((r: Record<string, unknown>) => this.toClientRow(r)), total, q.page, q.perPage);
  }

  async overview(scope: ClientScope): Promise<ClientOverviewFigures> {
    const base = () => applyClientScope(this.db('clients'), scope);

    const [activeIds, stoppedIds] = await Promise.all([
      this.db('statuses').whereNull('section').where('kpi_role', 'active').pluck('id'),
      this.db('statuses').whereNull('section').where('kpi_role', 'stopped').pluck('id'),
    ]);
    const active = activeIds.length ? activeIds.map(Number) : [1];
    const stopped = stoppedIds.length ? stoppedIds.map(Number) : [2];

    const [total, activeCount, stoppedCount] = await Promise.all([
      base().count({ n: '*' }).first(),
      base().whereIn('clients.status_id', active).count({ n: '*' }).first(),
      base().whereIn('clients.status_id', stopped).count({ n: '*' }).first(),
    ]);

    return { total: num(total?.n), active: num(activeCount?.n), stopped: num(stoppedCount?.n), todayItinerary: null };
  }

  async competitors(q: ClientListQuery): Promise<ClientListResult<CompetitorRow>> {
    const filtered = this.db('competitors');
    if (q.search) filtered.where('name', 'like', `%${q.search}%`);

    const total = num((await filtered.clone().count({ n: '*' }).first())?.n);
    const rows = await filtered
      .clone()
      .select('id', 'name', 'notes', 'is_active')
      .orderBy('name', 'asc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r) => ({ id: num(r.id), name: String(r.name ?? ''), notes: str(r.notes), active: bool(r.is_active) })),
      total,
      q.page,
      q.perPage,
    );
  }

  async doubtfulDebts(scope: ClientScope, q: ClientListQuery): Promise<ClientListResult<DoubtfulDebtRow>> {
    const base = () => {
      const qb = applyClientScope(this.db('doubtful_debts').join('clients', 'clients.id', 'doubtful_debts.client_id'), scope);
      if (q.status) qb.where('doubtful_debts.status', q.status);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select(
        'doubtful_debts.id',
        'doubtful_debts.client_id',
        'clients.trade_name as client_name',
        'doubtful_debts.original_balance',
        'doubtful_debts.provision_amount',
        'doubtful_debts.provision_percentage',
        'doubtful_debts.status',
        'doubtful_debts.collected_amount',
        'doubtful_debts.collected_date',
        'doubtful_debts.notes',
      )
      .orderBy('doubtful_debts.id', 'desc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r: Record<string, unknown>) => ({
        id: num(r.id),
        clientId: num(r.client_id),
        clientName: str(r.client_name),
        originalBalance: num(r.original_balance),
        provisionAmount: num(r.provision_amount),
        provisionPercentage: num(r.provision_percentage),
        status: String(r.status ?? 'pending'),
        collectedAmount: num(r.collected_amount),
        collectedDate: r.collected_date ? String(r.collected_date).slice(0, 10) : null,
        notes: str(r.notes),
      })),
      total,
      q.page,
      q.perPage,
    );
  }

  async todayItinerary(employeeIds: number[] | null, dayOfWeek: string, year: number, week: number, q: ClientListQuery): Promise<ClientListResult<ItineraryVisitRow>> {
    const base = () => {
      const qb = this.db('employee_client_visits')
        .join('clients', 'clients.id', 'employee_client_visits.client_id')
        .where('employee_client_visits.day_of_week', dayOfWeek)
        .where('employee_client_visits.year', year)
        .where('employee_client_visits.week_number', week);
      if (employeeIds !== null) qb.whereIn('employee_client_visits.employee_id', employeeIds.length ? employeeIds : [0]);
      if (q.search) qb.where('clients.trade_name', 'like', `%${q.search}%`);
      return qb;
    };

    const total = num((await base().count({ n: '*' }).first())?.n);
    const rows = await base()
      .select(
        'employee_client_visits.id',
        'employee_client_visits.client_id',
        'clients.trade_name as client_name',
        'clients.phone as client_phone',
        'clients.city as client_city',
        'employee_client_visits.status',
        'employee_client_visits.justification_approved',
      )
      .orderBy('clients.trade_name', 'asc')
      .limit(q.perPage)
      .offset((q.page - 1) * q.perPage);

    return paginate(
      rows.map((r) => ({
        id: num(r.id),
        clientId: num(r.client_id),
        clientName: str(r.client_name),
        clientPhone: str(r.client_phone),
        clientCity: str(r.client_city),
        status: String(r.status ?? 'active'),
        justificationApproved: r.justification_approved === null || r.justification_approved === undefined ? null : num(r.justification_approved),
      })),
      total,
      q.page,
      q.perPage,
    );
  }
}
