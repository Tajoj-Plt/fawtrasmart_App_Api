import { AppError } from '../../../domain/errors/AppError';
import { ClientNotesRepository, ClientRepository, ClientRow, NoteRow } from '../../../domain/repositories/clients';
import { noteShiftLabel, parseShiftRange } from '../../../domain/services/clients/ShiftRange';
import { ImageStore, UnitOfWork } from '../../ports';
import { ClientNotesService, filesOf, MEDIA, SHIFT_INVALID, SITE_TYPES } from '../../services/clients/ClientNotesService';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog } from '../../services/clients/ClientsSupport';
import { ClientVisibility } from '../../services/clients/ClientVisibility';
import { checkImage, FieldErrors, FormInput, UploadedFile } from '../../services/clients/FormInput';
import { CLIENT_PERMISSIONS } from './ClientUseCases';

const EDIT_ALL = 'client_follow_up_edit_delete_notes_attachments_appointments_all';
const EDIT_OWN = 'client_follow_up_edit_delete_notes_attachments_appointments_own';

/** مسؤولو العميل وملاحظات المتابعة على ملفّ العميل — `ContactController` و`NoteController` */
export class ClientNotesUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly clients: ClientRepository,
    private readonly notes: ClientNotesRepository,
    private readonly service: ClientNotesService,
    private readonly visibility: ClientVisibility,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly images: ImageStore,
  ) {}

  private async client(ctx: ClientsContext, clientId: number): Promise<ClientRow> {
    const client = await this.clients.find(clientId);
    if (!client) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await this.visibility.assertAccess(ctx, client.id);
    return client;
  }

  // ═══════════════════════ مسؤولو العميل ═══════════════════════

  async contacts(userId: number, meta: RequestMeta, clientId: number) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.notesView]);
    const client = await this.client(ctx, clientId);
    return this.service.listContacts(client.id);
  }

  async addContact(userId: number, meta: RequestMeta, clientId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.notesAdd]);
    const client = await this.client(ctx, clientId);
    const contact = await this.service.createContact(ctx, client.id, body, files);
    return { contact: this.service.presentContact(contact), message: 'تمت إضافة مسؤول العميل.' };
  }

  // ═══════════════════════ الملاحظات ═══════════════════════

  private present(ctx: ClientsContext, note: NoteRow) {
    return this.service.presentNote(note, ctx.user.id, ctx.can(EDIT_ALL), ctx.can(EDIT_OWN));
  }

  async list(userId: number, meta: RequestMeta, clientId: number, page = 1, perPage = 15) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.notesView]);
    const client = await this.client(ctx, clientId);

    // من لا يرى «الكلّ» ولا «المُسنَد» يرى ملاحظاته وحده
    const ownOnly = !ctx.can(['client_follow_up_view_notes_attachments_appointments_all', 'client_follow_up_view_notes_attachments_appointments_assigned']);
    const { rows, total } = await this.notes.notes(client.id, ownOnly ? ctx.user.id : null, page, perPage);

    return { items: rows.map((n) => this.present(ctx, n)), total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }

  async add(userId: number, meta: RequestMeta, clientId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.notesAdd]);
    const client = await this.client(ctx, clientId);
    const noteId = await this.service.createNote(ctx, client, body, files);
    return { note: this.present(ctx, (await this.notes.note(noteId))!), message: 'تمت إضافة الملاحظة.' };
  }

  /** «الكلّ» على أيّ ملاحظة، و«الخاصة» على ملاحظاته — ومحصوراً بعملاء نطاقه */
  private async editable(userId: number, meta: RequestMeta, noteId: number, action: string) {
    const ctx = await this.contexts.load(userId, meta, [...CLIENT_PERMISSIONS.notesEdit]);
    const note = await this.notes.note(noteId);
    if (!note) throw AppError.notFound('NOTE_NOT_FOUND', 'الملاحظة غير موجودة.');

    const allowed = ctx.can(EDIT_ALL) || (ctx.can(EDIT_OWN) && note.userId === ctx.user.id);
    if (!allowed) throw AppError.forbidden('NOTE_FORBIDDEN', `ليس لديك صلاحية ${action} هذه الملاحظة.`);
    await this.visibility.assertAccess(ctx, note.clientId, 'لا تملك صلاحية الوصول إلى عميل هذه الملاحظة.');

    return { ctx, note };
  }

  async update(userId: number, meta: RequestMeta, noteId: number, body: Record<string, unknown>, files: UploadedFile[]) {
    const { ctx, note } = await this.editable(userId, meta, noteId, 'تعديل');

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const contactId = input.integer('clientEmployeeId', { required: true });
    if (contactId !== null && !(await this.notes.contactOfClient(contactId, note.clientId))) errors.add('clientEmployeeId', 'المسؤول المختار لا يتبع عميل هذه الملاحظة.');
    const description = input.string('description', { required: true, max: 5000 });
    const deposit = input.integer('depositCount', { required: true, min: 0, max: 100000 });
    const siteType = input.oneOf('siteType', SITE_TYPES, { required: true, message: 'نوع الموقع غير صالح.' });
    const competitorDocuments = input.integer('competitorDocuments', { required: true, min: 0 });
    const shift = input.string('shift', { required: true });
    const photos = filesOf(files, 'attachments');
    if (photos.length > 10) errors.add('attachments', 'حقل «المرفقات» يجب ألّا يحوي أكثر من 10 عناصر.');
    photos.forEach((file, i) => checkImage(errors, `attachments.${i}`, file, ['jpeg', 'png'], ctx.settings.maxUploadSizeKb(), { mimes: 'المرفقات صورٌ فقط (jpg, jpeg, png).' }));
    errors.throwIfAny();

    const range = parseShiftRange(shift);
    if (!range) throw AppError.validation({ shift: ['فترة الدوام غير صالحة.'] }, SHIFT_INVALID);
    const [start, end] = range;

    const added: string[] = [];
    try {
      for (const file of photos) added.push(await this.images.savePhoto(MEDIA.notes, file));
      const all = [...note.attachments, ...added];
      const client = await this.clients.find(note.clientId);

      await this.uow.run(async (tx) => {
        await this.notes.updateNote(
          note.id,
          {
            description: `${description} | دوام المسؤول: ${noteShiftLabel(start, end)} | عدد العهدة: ${deposit}`,
            client_employee_id: contactId,
            deposit_count: deposit,
            site_type: siteType,
            competitor_documents: competitorDocuments,
            shift_start: start,
            shift_end: end,
            attachments: all.length ? JSON.stringify(all) : null,
            additional_data: JSON.stringify({ ...note.additionalData, deposit_count: deposit, site_type: siteType, competitor_documents: competitorDocuments, shift_start: start, shift_end: end }),
            updated_at: ctx.nowSql,
          },
          tx,
        );
        await this.log.record(ctx, 'note_updated', note.clientId, `تعديل ملاحظة للعميل «${client?.tradeName ?? note.clientId}» — من تطبيق الجوال`, {}, tx);
      });
    } catch (e) {
      for (const file of added) await this.images.delete(MEDIA.notes, file);
      throw e;
    }

    return { note: this.present(ctx, (await this.notes.note(note.id))!), message: 'تم تعديل الملاحظة.' };
  }

  async destroy(userId: number, meta: RequestMeta, noteId: number) {
    const { ctx, note } = await this.editable(userId, meta, noteId, 'حذف');
    const client = await this.clients.find(note.clientId);

    await this.uow.run(async (tx) => {
      await this.notes.deleteNote(note.id, tx);
      await this.log.record(ctx, 'note_deleted', note.clientId, `حذف ملاحظة للعميل «${client?.tradeName ?? `#${note.clientId}`}» — من تطبيق الجوال`, {}, tx);
    });

    for (const file of note.attachments) await this.images.delete(MEDIA.notes, file);
    return { message: 'تم حذف الملاحظة.' };
  }

  async destroyAttachment(userId: number, meta: RequestMeta, noteId: number, index: number) {
    const { ctx, note } = await this.editable(userId, meta, noteId, 'تعديل');
    if (index < 0 || index >= note.attachments.length) throw AppError.notFound('ATTACHMENT_NOT_FOUND', 'المرفق غير موجود.');

    const files = [...note.attachments];
    const [removed] = files.splice(index, 1);
    await this.notes.updateNote(note.id, { attachments: files.length ? JSON.stringify(files) : null, updated_at: ctx.nowSql });
    await this.images.delete(MEDIA.notes, removed);
    await this.log.record(ctx, 'note_attachment_deleted', note.id, `حذف مرفق من ملاحظة العميل #${note.clientId} — من تطبيق الجوال`);

    return { remaining: files.length, message: 'تم حذف المرفق.' };
  }
}
