import { AppError } from '../../../domain/errors/AppError';
import { SalesWriteRepository, StockRow } from '../../../domain/repositories/sales';
import { StockRepository } from '../../../domain/repositories/stock';
import { fmtQty, round2 } from '../../../domain/services/sales/SalesMath';
import { Tx } from '../../ports';
import { SalesContext } from './SalesContext';

/** حركة صنفٍ في مستودع — بالوحدة الأساسية */
export interface StockMove {
  productId: number;
  name: string;
  warehouseId: number;
  baseQuantity: number;
  /** سعر الوحدة الأساسية في الإذن */
  unitPrice: number;
  total: number;
}

export interface PermitHeader {
  source: number;
  number: string;
  /** تاريخ المستند (`permission_date`) */
  date: string;
  clientId: number | null;
  referenceType: string;
  referenceId: number;
  currency: string;
  /** 1 إضافة، 2 صرف */
  permissionType: 1 | 2;
  details?: string;
}

export type ShortageMessage = (m: StockMove, available: number, warehouseName: string) => string;

/**
 * حركة المخزون لمستندات الردّ (المرتجع والإشعار الدائن وإلغاؤه): إذنٌ واحدٌ
 * **لكل مستودع** ببنوده — لا إذنٌ لكل بند يحمل إجمالي المستند كلّه كما في
 * الويب — وأرصدةٌ مقفلةٌ حتى نهاية المعاملة.
 */
export class SalesInventory {
  constructor(
    private readonly writes: SalesWriteRepository,
    private readonly stock: StockRepository,
  ) {}

  /** عدد الأذون التي ستُكتب — لحدّ «أذونات المخزن» قبل الكتابة */
  permitsFor(moves: StockMove[]) {
    return new Set(moves.filter((m) => m.baseQuantity > 0).map((m) => m.warehouseId)).size;
  }

  async restock(ctx: SalesContext, header: PermitHeader, moves: StockMove[], now: string, tx: Tx) {
    return this.move(ctx, header, moves, +1, now, tx, null);
  }

  /** الإخراج — ولا يُخرَج ما لم يعد في المستودع (البيع بالسالب ممنوع) */
  async unstock(ctx: SalesContext, header: PermitHeader, moves: StockMove[], now: string, tx: Tx, shortage: ShortageMessage | null = null) {
    return this.move(ctx, header, moves, -1, now, tx, shortage);
  }

  /** يعيد معرّفات الأذون بترتيب المستودعات */
  private async move(ctx: SalesContext, header: PermitHeader, moves: StockMove[], sign: 1 | -1, now: string, tx: Tx, shortage: ShortageMessage | null): Promise<number[]> {
    const live = moves.filter((m) => m.baseQuantity > 0);
    if (!live.length) return [];

    const stock = await this.writes.lockStock(live.map((m) => [m.productId, m.warehouseId]), tx);
    const names = await this.stock.warehouseNames([...new Set(live.map((m) => m.warehouseId))]);
    const periodId = (await this.stock.accountingPeriodFor(header.date.slice(0, 10)))?.id ?? null;

    const byWarehouse = new Map<number, StockMove[]>();
    for (const m of live) byWarehouse.set(m.warehouseId, [...(byWarehouse.get(m.warehouseId) ?? []), m]);

    const permitIds: number[] = [];
    for (const [warehouseId, lines] of byWarehouse) {
      const permitId = await this.writes.insertPermit(
        {
          permission_source_id: header.source,
          permission_date: header.date,
          number: header.number,
          grand_total: round2(lines.reduce((s, l) => s + l.total, 0)),
          store_houses_id: warehouseId,
          client_id: header.clientId,
          reference_type: header.referenceType,
          reference_id: header.referenceId,
          created_by: ctx.user.id,
          status: 'apporod',
          permission_type: header.permissionType,
          currency: header.currency,
          accounting_period_id: periodId,
          ...(header.details ? { details: header.details } : {}),
        },
        now,
        tx,
      );
      permitIds.push(permitId);

      for (const l of lines) {
        const key = `${l.productId}_${warehouseId}`;
        let row: StockRow | undefined = stock.get(key);
        if (!row) {
          row = await this.writes.createStockRow(l.productId, warehouseId, now, tx);
          stock.set(key, row);
        }
        const before = row.quantity;
        if (sign < 0 && l.baseQuantity - before > 0.0001) {
          if (shortage) throw new AppError('INSUFFICIENT_STOCK', shortage(l, before, names.get(warehouseId) ?? '—'), 422);
          throw new AppError(
            'INSUFFICIENT_STOCK',
            `لا يُلغى المستند: رصيد «${l.name}» في «${names.get(warehouseId) ?? '—'}» ${fmtQty(before)}، وقد أدخل المستندُ ${fmtQty(l.baseQuantity)} — خرجت البضاعة من المستودع بعده.`,
            422,
          );
        }
        const after = before + sign * l.baseQuantity;
        await this.writes.addStock(row.id, sign * l.baseQuantity, now, tx);
        row.quantity = after;
        await this.writes.insertPermitLine(
          { warehouse_permits_id: permitId, product_id: l.productId, quantity: l.baseQuantity, unit_price: l.unitPrice, total: round2(l.total), stock_before: before, stock_after: after },
          now,
          tx,
        );
      }
    }
    return permitIds;
  }
}
