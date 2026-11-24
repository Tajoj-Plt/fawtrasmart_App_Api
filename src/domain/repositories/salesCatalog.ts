import { Paginated } from '../entities/accounting';
import { CreditNoteRow, DateRange, InvoiceRow, PaymentRow, QuoteRow, SalesListQuery, SalesOverviewFigures, SalesScope } from '../entities/sales';

export type SalesListResult<T> = Paginated<T>;

/** قوائم أقسام المبيعات (العرض العامّ) — `SalesUseCases` */
export interface SalesCatalogRepository {
  invoices(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<InvoiceRow>>;
  quotes(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<QuoteRow>>;
  returns(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<InvoiceRow>>;
  creditNotes(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<CreditNoteRow>>;
  payments(scope: SalesScope, range: DateRange, q: SalesListQuery): Promise<SalesListResult<PaymentRow>>;
  overview(scope: SalesScope, range: DateRange, want: { invoices: boolean; quotes: boolean; payments: boolean }): Promise<SalesOverviewFigures>;
}
