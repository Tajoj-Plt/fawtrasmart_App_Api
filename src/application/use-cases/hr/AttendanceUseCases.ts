import { AppError } from '../../../domain/errors/AppError';
import { ErpBridge, ErpResponse } from '../../ports';
import { HrAccess } from '../../services/HrAccess';
import { assertBridgeAvailable, interpretErpResult } from '../forms/GenericFormsUseCases';

type Lang = 'ar' | 'en';

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export interface StampPosition {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

/**
 * «سجّل حضوري» — **قواعد الويب كما هي عبر الجسر**، لا نسخةٌ ثانية منها.
 *
 * طريقةُ تسجيل الموظف (فرع/ميداني/كلاهما)، ومكانُ التسجيل ونطاقُه، ونافذةُ الحضور، والإجازة
 * والعطلة، والاستراحة والدوام المرن، والخصم الآلي بعد كلّ ختم — كلّها في `AttendanceStampService`
 * وما حولها بالويب. فكلُّ عمليةٍ هنا تُنفَّذ هناك بحساب المستخدم نفسه
 * (`/api/mobile/hr/attendance/...`)، والموظفُ صاحبُ الحساب دائماً — لا رقم موظفٍ في أيّ طلب.
 */
export class AttendanceUseCases {
  constructor(
    private readonly guard: HrAccess,
    private readonly bridge: ErpBridge,
  ) {}

  private async authorize(userId: number) {
    const { ctx } = await this.guard.load(userId);
    this.guard.assertSection('attendance', ctx);
  }

  /**
   * رفضُ الختم يحمل سببَه (`code`) ومرحلتَه (`stage`: الموظف، الوردية، الموقع، اليوم…) ونصَّه العربيّ
   * كما تعرضه شاشة الويب — يُعاد للتطبيق كما هو لا برسالةٍ عامّة.
   */
  private read(res: ErpResponse) {
    assertBridgeAvailable(res);
    const body = asRecord(res.body);
    const ok = res.status >= 200 && res.status < 300 && body.success !== false;
    if (!ok && typeof body.code === 'string' && typeof body.message === 'string') {
      throw new AppError('ATTENDANCE_REJECTED', body.message, 422, { reason: body.code, stage: typeof body.stage === 'string' ? body.stage : null });
    }
    const { message } = interpretErpResult(res);
    return { body, message };
  }

  private async call(userId: number, method: 'GET' | 'POST', path: string, lang: Lang, payload?: unknown) {
    await this.authorize(userId);
    return this.read(await this.bridge.request({ userId, method, module: 'hr', path: `/attendance${path}`, body: payload, lang }));
  }

  /** حالةُ الشاشة: طريقة التسجيل، الوردية والنافذة، مكان التسجيل، حالة اليوم والاستراحة، آخر المحاولات */
  async state(userId: number, lang: Lang) {
    const { body } = await this.call(userId, 'GET', '', lang);
    return body.data ?? {};
  }

  private result(r: { body: Record<string, unknown>; message: string }) {
    return { message: r.message, data: { result: r.body.data ?? null, warnings: Array.isArray(r.body.warnings) ? r.body.warnings : [] } };
  }

  async checkIn(userId: number, position: StampPosition, lang: Lang) {
    return this.result(await this.call(userId, 'POST', '/check-in', lang, position));
  }

  async checkOut(userId: number, position: StampPosition, lang: Lang) {
    return this.result(await this.call(userId, 'POST', '/check-out', lang, position));
  }

  /** بدء الاستراحة أو إنهاؤها — الموقع اختياريّ (يُسجَّل مع الختم إن وُجد) */
  async toggleBreak(userId: number, action: 'start' | 'end', position: Partial<StampPosition>, lang: Lang) {
    return this.result(await this.call(userId, 'POST', '/break', lang, { action, ...position }));
  }
}
