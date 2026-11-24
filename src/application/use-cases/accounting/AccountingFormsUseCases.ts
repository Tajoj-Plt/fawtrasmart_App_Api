import { AccountingSectionKey } from '../../../domain/services/AccountingCatalog';
import { ACCOUNTING_FORMS } from '../../../domain/services/AccountingForms';
import { ErpBridge } from '../../ports';
import { AccountingAccess } from '../../services/AccountingAccess';
import { GenericFormsUseCases, interpretErpResult, mapErrorKeys } from '../forms/GenericFormsUseCases';

export { interpretErpResult, mapErrorKeys };

type Lang = 'ar' | 'en';

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * نماذج الإنشاء في وحدة الحسابات. الخادم يصف الحقول، والويب (Laravel) ينفّذ الإنشاء بمتحكّماته
 * نفسها فتبقى كل القواعد المحاسبية عنده. الأساس العام في `GenericFormsUseCases`؛ هنا فقط ما يخصّ
 * الحسابات: اقتراح كود حسابٍ/مركز تكلفة، وأول رقم شيكٍ متاح في دفتر.
 */
export class AccountingFormsUseCases extends GenericFormsUseCases<AccountingSectionKey> {
  constructor(guard: AccountingAccess, bridge: ErpBridge) {
    super(guard, bridge, 'accounting', ACCOUNTING_FORMS);
  }

  /** كودٌ مقترح لحسابٍ أو مركز تكلفة تحت أب معيَّن */
  async nextCode(userId: number, kind: 'chart' | 'cost_center', parentId: number | undefined, lang: Lang) {
    await this.authorize(userId, kind === 'chart' ? 'chart' : 'cost_centers');
    const res = await this.request({ userId, method: 'GET', path: `/forms/next-code/${kind}${parentId ? `?parent_id=${parentId}` : ''}`, lang });
    interpretErpResult(res);
    return asRecord(asRecord(res.body).data);
  }

  /** أول رقم شيك متاح في دفتر */
  async checkbookInfo(userId: number, id: number, lang: Lang) {
    await this.authorize(userId, 'payable_cheques');
    const res = await this.request({ userId, method: 'GET', path: `/forms/checkbook/${id}`, lang });
    interpretErpResult(res);
    return asRecord(asRecord(res.body).data);
  }
}
