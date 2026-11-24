import NodeCache from 'node-cache';
import { Cache } from '../../application/ports';

/** ذاكرة مؤقتة داخل العملية للبيانات المتكرّرة (صلاحيات، إعدادات، مظهر) */
export class MemoryCache implements Cache {
  private readonly store = new NodeCache({ useClones: false, checkperiod: 60 });
  private readonly inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | undefined {
    return this.store.get<T>(key);
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, value, ttlSeconds);
  }

  del(key: string | string[]): void {
    this.store.del(key);
  }

  flush(): void {
    this.store.flushAll();
  }

  async wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const hit = this.store.get<T>(key);
    if (hit !== undefined) return hit;

    // يمنع تنفيذ المنتج مرّتين لطلبين متزامنين على المفتاح نفسه
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = producer()
      .then((value) => {
        this.store.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }
}
