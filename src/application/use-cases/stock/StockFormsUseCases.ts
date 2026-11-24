import { StockSectionKey } from '../../../domain/services/StockCatalog';
import { STOCK_FORMS } from '../../../domain/services/StockForms';
import { ErpBridge } from '../../ports';
import { StockAccess } from '../../services/StockAccess';
import { GenericFormsUseCases } from '../forms/GenericFormsUseCases';

/** نماذج الإنشاء في وحدة المخزون — الأساس العام في `GenericFormsUseCases`، لا شيء خاصٌّ زائدٌ هنا */
export class StockFormsUseCases extends GenericFormsUseCases<StockSectionKey> {
  constructor(guard: StockAccess, bridge: ErpBridge) {
    super(guard, bridge, 'stock', STOCK_FORMS);
  }
}
