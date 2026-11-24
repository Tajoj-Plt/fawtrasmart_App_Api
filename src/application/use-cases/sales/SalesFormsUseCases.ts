import { SalesSectionKey } from '../../../domain/services/SalesCatalog';
import { SALES_FORMS } from '../../../domain/services/SalesForms';
import { ErpBridge } from '../../ports';
import { SalesAccess } from '../../services/SalesAccess';
import { GenericFormsUseCases } from '../forms/GenericFormsUseCases';

/** نماذج الإنشاء في وحدة المبيعات — الأساس العام في `GenericFormsUseCases`، لا شيء خاصٌّ زائدٌ هنا */
export class SalesFormsUseCases extends GenericFormsUseCases<SalesSectionKey> {
  constructor(guard: SalesAccess, bridge: ErpBridge) {
    super(guard, bridge, 'sales', SALES_FORMS);
  }
}
