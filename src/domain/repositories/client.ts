import { ClientListQuery, ClientOverviewFigures, ClientRow, ClientScope, CompetitorRow, DoubtfulDebtRow, ItineraryVisitRow } from '../entities/client';
import { Paginated } from '../entities/accounting';

export type ClientListResult<T> = Paginated<T>;

export interface ClientRepository {
  clients(scope: ClientScope, q: ClientListQuery): Promise<ClientListResult<ClientRow>>;
  overview(scope: ClientScope): Promise<ClientOverviewFigures>;
  competitors(q: ClientListQuery): Promise<ClientListResult<CompetitorRow>>;
  doubtfulDebts(scope: ClientScope, q: ClientListQuery): Promise<ClientListResult<DoubtfulDebtRow>>;
  /** خط سيري اليومي: يتجاهل `mode:'branch'|'unrestricted'` ويستعمل معرّفات الموظفين مباشرة */
  todayItinerary(employeeIds: number[] | null, dayOfWeek: string, year: number, week: number, q: ClientListQuery): Promise<ClientListResult<ItineraryVisitRow>>;
}
