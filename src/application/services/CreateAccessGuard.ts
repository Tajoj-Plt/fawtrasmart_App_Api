import { User } from '../../domain/entities';
import { AccessContext } from '../../domain/services/catalogKit';

/** ما يحتاجه أي `GenericFormsUseCases` من فاحص وصول وحدة (Accounting/Client/Stock/Sales) */
export interface CreateAccessGuard<K extends string> {
  load(userId: number): Promise<{ user: User; ctx: AccessContext }>;
  assertCanCreate(key: K, ctx: AccessContext): void;
}
