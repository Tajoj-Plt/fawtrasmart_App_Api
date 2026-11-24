import { Knex } from 'knex';
import { Clock, Tx, UnitOfWork } from '../../application/ports';
import { localNow } from '../../domain/services/clients/LocalTime';

/** `DB::transaction()` — كل ما يُنفَّذ بالسياق نفسه يُثبَّت معاً أو يُلغى معاً */
export class KnexUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Knex) {}

  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction((trx) => work(trx as unknown as Tx));
  }
}

/** المستودعات تفكّ السياق المعتم: المعاملة إن مُرِّرت، وإلا الاتصال العادي */
export function conn(db: Knex, tx?: Tx | null): Knex {
  return (tx as unknown as Knex | undefined) ?? db;
}

/** ساعة النظام بمنطقته (`APP_TIMEZONE`) */
export class ZonedClock implements Clock {
  constructor(private readonly timeZone: string) {}

  now(): Date {
    return localNow(this.timeZone);
  }
}
