import { ClientSectionKey } from '../../../domain/services/ClientCatalog';
import { CLIENT_FORMS } from '../../../domain/services/ClientForms';
import { ErpBridge } from '../../ports';
import { ClientAccess } from '../../services/ClientAccess';
import { GenericFormsUseCases } from '../forms/GenericFormsUseCases';

/** نماذج الإنشاء في وحدة العملاء — الأساس العام في `GenericFormsUseCases`، لا شيء خاصٌّ زائدٌ هنا */
export class ClientFormsUseCases extends GenericFormsUseCases<ClientSectionKey> {
  constructor(guard: ClientAccess, bridge: ErpBridge) {
    super(guard, bridge, 'client', CLIENT_FORMS);
  }
}
