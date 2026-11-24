import { Paginated } from '../entities/accounting';
import { AdjustmentRow, PermitRow, ProductRow, StockListQuery, StockOverviewFigures, StockScope, WarehouseRow } from '../entities/stock';

export type StockListResult<T> = Paginated<T>;

/** قوائم أقسام المخزون (العرض العامّ) — `StockUseCases` */
export interface StockCatalogRepository {
  /** المستودعات المطابقة لكليهما (فرعٌ ∩ تخصيصٌ)؛ null في طرفٍ = بلا قيد لذلك الطرف */
  warehouseIdsFor(branchIds: number[] | null, employeeIds: number[] | null): Promise<number[]>;
  products(warehouseIds: number[] | null, q: StockListQuery): Promise<StockListResult<ProductRow>>;
  warehouses(warehouseIds: number[] | null, q: StockListQuery): Promise<StockListResult<WarehouseRow>>;
  permits(scope: StockScope, q: StockListQuery): Promise<StockListResult<PermitRow>>;
  adjustments(scope: StockScope, q: StockListQuery): Promise<StockListResult<AdjustmentRow>>;
  overview(scope: StockScope, want: { products: boolean; warehouses: boolean; permits: boolean; adjustments: boolean }): Promise<StockOverviewFigures>;
}
