import { OperationLogRepository } from '../../../domain/repositories/clients';
import { Tx } from '../../ports';
import { StockContext } from './StockContext';

/** وحدة سجلّ الأذون في الويب — بها تعرض شاشة الإذن سجلَّه */
export const PERMIT_LOG_MODULE = 'warehouse_permit_log';

/** `OperationLog` بسياق طلب المخزون — IP والمتصفّح والمسار والمستخدم من السياق */
export class StockLog {
  constructor(private readonly logs: OperationLogRepository) {}

  record(ctx: StockContext, action: string, subjectId: number | null, description: string, tx?: Tx, module = PERMIT_LOG_MODULE) {
    return this.logs.record(
      {
        action,
        module,
        subjectId,
        description,
        userId: ctx.user.id,
        ip: ctx.meta.ip,
        userAgent: ctx.meta.userAgent,
        route: ctx.meta.route,
        oldValues: null,
        newValues: null,
      },
      tx,
    );
  }

  failure(ctx: StockContext, error: unknown, action: string, subjectId?: number | null, module = PERMIT_LOG_MODULE) {
    return this.logs.failure({
      module,
      action,
      error: error instanceof Error ? error : new Error(String(error)),
      userId: ctx.user.id,
      subjectId: subjectId ?? null,
      ip: ctx.meta.ip,
      userAgent: ctx.meta.userAgent,
      url: ctx.meta.url,
    });
  }
}
