import { Knex } from 'knex';
import { Tx } from '../../../application/ports';
import { ClientNotesRepository, ContactPersonRow, NoteRow } from '../../../domain/repositories/clients';
import { bool } from '../../db/knex';
import { conn } from '../../db/KnexUnitOfWork';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    const parsed = JSON.parse(String(v));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** مسؤولو العميل (`client_employee_notes`) وملاحظات المتابعة (`client_relations`) */
export class KnexClientNotesRepository implements ClientNotesRepository {
  constructor(private readonly db: Knex) {}

  private contactQuery() {
    return this.db('client_employee_notes as cn')
      .leftJoin('users as u', 'u.id', 'cn.employee_id')
      .leftJoin('invoices as i', 'i.id', 'cn.invoice_id')
      .select('cn.*', 'u.name as created_by', 'i.code as invoice_code');
  }

  private mapContact(r: Record<string, unknown>): ContactPersonRow {
    return {
      id: Number(r.id),
      clientId: Number(r.client_id),
      userId: Number(r.employee_id),
      employeeName: String(r.employee_name ?? ''),
      employeePosition: str(r.employee_position),
      employeePhone: str(r.employee_phone),
      shiftStart: str(r.shift_start),
      shiftEnd: str(r.shift_end),
      isPrimary: bool(r.is_primary),
      invoiceId: num(r.invoice_id),
      invoiceCode: r.invoice_id ? str(r.invoice_code) : null,
      image: str(r.image),
      createdBy: str(r.created_by),
      createdAt: str(r.created_at),
    };
  }

  /** `ContactService::listFor()` — الأساسيّ أوّلاً ثم الأحدث */
  async contacts(clientId: number): Promise<ContactPersonRow[]> {
    const rows = await this.contactQuery().where('cn.client_id', clientId).orderBy('cn.is_primary', 'desc').orderBy('cn.created_at', 'desc').orderBy('cn.id', 'desc');
    return rows.map((r: Record<string, unknown>) => this.mapContact(r));
  }

  async contactOfClient(id: number, clientId: number): Promise<ContactPersonRow | null> {
    const r = await this.contactQuery().where('cn.id', id).where('cn.client_id', clientId).first();
    return r ? this.mapContact(r) : null;
  }

  async insertContact(values: Record<string, unknown>): Promise<number> {
    const [id] = await this.db('client_employee_notes').insert(values);
    return Number(id);
  }

  private noteQuery() {
    return this.db('client_relations as n')
      .leftJoin('users as u', 'u.id', 'n.employee_id')
      .leftJoin('client_employee_notes as cn', 'cn.id', 'n.client_employee_id')
      .select('n.*', 'u.name as employee_name', 'cn.employee_name as contact_name');
  }

  private async hydrate(rows: Record<string, unknown>[]): Promise<NoteRow[]> {
    const ids = rows.map((r) => Number(r.id));
    const observations = ids.length
      ? await this.db('visit_competitor_observations').whereIn('client_relation_id', ids).orderBy('id').select('client_relation_id', 'competitor_id', 'competitor_name', 'asset_count', 'photo_path')
      : [];
    const byNote = new Map<number, NoteRow['competitors']>();
    for (const o of observations as Record<string, unknown>[]) {
      const key = Number(o.client_relation_id);
      const list = byNote.get(key) ?? [];
      list.push({ competitorId: num(o.competitor_id), name: String(o.competitor_name ?? ''), assetCount: Number(o.asset_count ?? 0), photoPath: str(o.photo_path) });
      byNote.set(key, list);
    }

    return rows.map((r) => ({
      id: Number(r.id),
      clientId: Number(r.client_id),
      userId: num(r.employee_id),
      description: str(r.description),
      process: str(r.process),
      status: str(r.status),
      depositCount: num(r.deposit_count),
      competitorDocuments: Number(r.competitor_documents ?? 0),
      siteType: str(r.site_type),
      shiftStart: str(r.shift_start),
      shiftEnd: str(r.shift_end),
      attachments: (() => {
        const files = parseJson<unknown>(r.attachments, []);
        return Array.isArray(files) ? files.map(String) : Object.values(files as Record<string, unknown>).map(String);
      })(),
      additionalData: parseJson<Record<string, unknown>>(r.additional_data, {}),
      contact: r.client_employee_id && r.contact_name !== null ? { id: Number(r.client_employee_id), name: String(r.contact_name) } : null,
      employee: r.employee_id && r.employee_name !== null ? { id: Number(r.employee_id), name: String(r.employee_name) } : null,
      competitors: byNote.get(Number(r.id)) ?? [],
      createdAt: str(r.created_at),
    }));
  }

  async notes(clientId: number, ownerUserId: number | null, page: number, perPage: number) {
    const q = this.db('client_relations as n').where('n.client_id', clientId);
    if (ownerUserId !== null) q.where('n.employee_id', ownerUserId);
    const countRow = await q.clone().count<{ c: number }[]>({ c: 'n.id' }).first();
    const total = Number((countRow as { c?: number } | undefined)?.c ?? 0);
    if (!total) return { rows: [], total };

    const rows = await this.noteQuery()
      .where('n.client_id', clientId)
      .modify((s) => {
        if (ownerUserId !== null) s.where('n.employee_id', ownerUserId);
      })
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(perPage)
      .offset((page - 1) * perPage);
    return { rows: await this.hydrate(rows), total };
  }

  async note(id: number): Promise<NoteRow | null> {
    const r = await this.noteQuery().where('n.id', id).first();
    return r ? (await this.hydrate([r]))[0] : null;
  }

  async insertNote(values: Record<string, unknown>, tx: Tx): Promise<number> {
    const [id] = await conn(this.db, tx)('client_relations').insert(values);
    return Number(id);
  }

  async updateNote(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void> {
    await conn(this.db, tx)('client_relations').where('id', id).update(values);
  }

  async deleteNote(id: number, tx: Tx): Promise<void> {
    await conn(this.db, tx)('client_relations').where('id', id).del();
  }

  async insertNoteLocation(values: Record<string, unknown>, tx: Tx): Promise<void> {
    await conn(this.db, tx)('locations').insert(values);
  }

  /** `Location::where('client_id')->clientPoint()->latest()->first()` */
  async clientPoint(clientId: number) {
    const r = await this.db('locations').where('client_id', clientId).whereNull('client_relation_id').orderBy('created_at', 'desc').orderBy('id', 'desc').first('latitude', 'longitude');
    return r ? { latitude: Number(r.latitude), longitude: Number(r.longitude) } : null;
  }
}
