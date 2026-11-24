import { ClientNotesRepository, ClientRepository, ClientRow, ContactPersonRow, NoteRow } from '../../../domain/repositories/clients';
import { kmBetween, round } from '../../../domain/services/clients/Geo';
import { hasShift, noteShiftLabel, parseShiftRange, shiftLabel, shiftRangeValue } from '../../../domain/services/clients/ShiftRange';
import { ImageStore, UnitOfWork } from '../../ports';
import { ClientsContext } from './ClientsContext';
import { ClientsLog, NotificationGate } from './ClientsSupport';
import { checkImage, fieldError, FieldErrors, FormInput, UploadedFile } from './FormInput';

/** مجلّدات الصور في الويب — `MediaStore` */
export const MEDIA = {
  notes: 'assets/uploads/notes',
  competitors: 'assets/uploads/visit_competitors',
  signatures: 'assets/uploads/visit_signatures',
  contacts: 'uploads/client_notes',
} as const;

export const SITE_TYPES = ['independent_booth', 'grocery', 'supplies', 'markets', 'station'] as const;

export const SHIFT_INVALID = 'فترة الدوام غير صالحة — أرسل full أو من|إلى بصيغة HH:00|HH:00.';

/** ملفّات حقلٍ واحد — `attachments` و`attachments[]` و`attachments[0]` سواء */
export function filesOf(files: UploadedFile[], field: string): UploadedFile[] {
  return files.filter((f) => f.fieldname.replace(/\[\d*\]$/, '') === field);
}

export interface NoteOverrides {
  shiftStart?: string;
  shiftEnd?: string;
  competitorDocuments?: number;
}

/**
 * مسؤولو العميل وملاحظات المتابعة — `ContactService` و`NoteService` في تكامل
 * لارافل (والويب قبلهما): قواعد التحقّق، قرب الموظف من العميل، نصّ الملاحظة،
 * موقع الموظف المربوط بها، والإشعار والسجلّ. تستعملها شاشة العميل ومساحة الزيارة.
 */
export class ClientNotesService {
  constructor(
    private readonly clients: ClientRepository,
    private readonly notes: ClientNotesRepository,
    private readonly notifications: NotificationGate,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
    private readonly images: ImageStore,
  ) {}

  // ═══════════════════════ مسؤولو العميل ═══════════════════════

  presentContact(c: ContactPersonRow) {
    return {
      id: c.id,
      employeeName: c.employeeName,
      employeePosition: c.employeePosition,
      employeePhone: c.employeePhone,
      isPrimary: c.isPrimary,
      shift: shiftRangeValue(c.shiftStart, c.shiftEnd) || null,
      shiftStart: c.shiftStart,
      shiftEnd: c.shiftEnd,
      shiftLabel: shiftLabel(c.shiftStart, c.shiftEnd),
      imageUrl: c.image ? this.images.publicUrl(c.image) : null,
      invoiceId: c.invoiceId,
      invoiceCode: c.invoiceCode,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    };
  }

  async listContacts(clientId: number) {
    return (await this.notes.contacts(clientId)).map((c) => this.presentContact(c));
  }

  async createContact(ctx: ClientsContext, clientId: number, body: Record<string, unknown>, files: UploadedFile[], logModule?: string): Promise<ContactPersonRow> {
    const errors = new FieldErrors();
    const input = new FormInput(body, errors);

    const name = input.string('employeeName', { required: true, max: 255, message: 'اسم المسؤول إلزامي.' });
    const position = input.string('employeePosition', { max: 100 });
    const phone = input.string('employeePhone', { required: true, max: 20, message: 'رقم جوال المسؤول إلزامي.' });
    const shift = input.string('shift', { required: true, message: 'دوام المسؤول إلزامي — اختر فترة.' });
    const range = shift !== null ? parseShiftRange(shift) : null;
    if (shift !== null && range === null) errors.add('shift', SHIFT_INVALID);
    const isPrimary = input.boolean('isPrimary');
    const invoiceId = input.integer('invoiceId');
    if (invoiceId !== null && !(await this.clients.invoiceBelongsTo(invoiceId, clientId))) errors.add('invoiceId', 'الفاتورة المختارة ليست لهذا العميل.');

    const image = filesOf(files, 'image')[0] ?? null;
    if (image) checkImage(errors, 'image', image, ['jpeg', 'png', 'gif'], ctx.settings.maxUploadSizeKb());
    errors.throwIfAny();

    const stored = image ? `${MEDIA.contacts}/${await this.images.savePhoto(MEDIA.contacts, image)}` : null;
    const now = ctx.nowSql;

    const id = await this.notes.insertContact({
      client_id: clientId,
      employee_id: ctx.user.id,
      employee_name: name,
      employee_position: position ?? 'موظف',
      employee_phone: phone,
      shift_start: range![0],
      shift_end: range![1],
      is_primary: isPrimary ? 1 : 0,
      invoice_id: invoiceId,
      ...(stored ? { image: stored } : {}),
      created_at: now,
      updated_at: now,
    });

    await this.log.record(ctx, 'employee_note_added', clientId, `إضافة مسؤول العميل «${name}» للعميل #${clientId} — من تطبيق الجوال`, {}, undefined, logModule);

    return (await this.notes.contactOfClient(id, clientId))!;
  }

  // ═══════════════════════ الملاحظات ═══════════════════════

  presentNote(n: NoteRow, viewerId: number | null, canEditAll: boolean, canEditOwn: boolean) {
    const own = viewerId !== null && n.userId === viewerId;
    return {
      id: n.id,
      clientId: n.clientId,
      description: n.description,
      process: n.process,
      status: n.status,
      depositCount: n.depositCount,
      competitorDocuments: n.competitorDocuments,
      siteType: n.siteType,
      shiftStart: n.shiftStart,
      shiftEnd: n.shiftEnd,
      contact: n.contact,
      employee: n.employee,
      attachments: n.attachments.map((file, index) => ({ index, url: this.images.url(MEDIA.notes, file) })),
      competitors: n.competitors.map((o) => ({ competitorId: o.competitorId, name: o.name, assetCount: o.assetCount, photoUrl: this.images.url(MEDIA.competitors, o.photoPath) })),
      canEdit: canEditAll || (canEditOwn && own),
      createdAt: n.createdAt,
    };
  }

  /** هل يُعفى من شرط الموقع — صلاحيةً أو «استبعاد موقع» العميل متى فُعّل القسم */
  locationBypass(ctx: ClientsContext, client: ClientRow): boolean {
    return (
      ctx.can(['client_follow_up_add_notes_from_any_location', 'clients_visit_any_location']) ||
      (ctx.settings.module.exemptLocationEnabled && client.exemptVisitLocation)
    );
  }

  /** `NoteService::create()` — تُعيد معرّف الملاحظة */
  async createNote(ctx: ClientsContext, client: ClientRow, body: Record<string, unknown>, files: UploadedFile[], overrides: NoteOverrides = {}): Promise<number> {
    const s = ctx.settings;
    const bypass = this.locationBypass(ctx, client);
    const requireDeposit = s.visitWorkspaceSectionVisible('note_deposit_count');
    const requirePhoto = s.visitWorkspaceSectionVisible('note_photo');
    const minPhotos = Math.max(1, s.noteMinPhotos());

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);

    const contactId = input.integer('clientEmployeeId', { required: true, message: 'اختر مسؤول العميل الذي قابلته.' });
    const contact = contactId !== null ? await this.notes.contactOfClient(contactId, client.id) : null;
    if (contactId !== null && !contact) errors.add('clientEmployeeId', 'المسؤول المختار لا يتبع هذا العميل.');

    const description = input.string('description', { required: true, max: 5000, message: 'اكتب نصّ الملاحظة.' });
    const process = input.string('process', { max: 255 });
    const deposit = input.integer('depositCount', { required: requireDeposit, min: 0, max: 100000, message: 'عدد العهدة إلزامي (0 إن لا عهدة).' });
    const siteType = input.oneOf('siteType', SITE_TYPES);
    const shift = input.string('shift');

    const photos = filesOf(files, 'attachments');
    if (requirePhoto && photos.length < minPhotos) errors.add('attachments', `أرفق ${minPhotos} صورة على الأقل.`);
    if (photos.length > 10) errors.add('attachments', 'حقل «المرفقات» يجب ألّا يحوي أكثر من 10 عناصر.');
    photos.forEach((file, i) => checkImage(errors, `attachments.${i}`, file, ['jpeg', 'png'], s.maxUploadSizeKb(), { mimes: 'المرفقات صورٌ فقط (jpg, jpeg, png).' }));

    const gpsMessage = 'يجب تحديد موقعك الحالي لإضافة الملاحظة — فعّل GPS.';
    const lat = input.number('currentLatitude', { required: !bypass, min: -90, max: 90, message: gpsMessage });
    const lng = input.number('currentLongitude', { required: !bypass, min: -180, max: 180, message: gpsMessage });
    errors.throwIfAny();

    // الدوام: من الزيارة، أو من الطلب، أو المحفوظ للمسؤول — وإلا يُطلب
    let shiftStart: string;
    let shiftEnd: string;
    if (overrides.shiftStart && overrides.shiftEnd) {
      [shiftStart, shiftEnd] = [overrides.shiftStart, overrides.shiftEnd];
    } else if (shift !== null) {
      const range = parseShiftRange(shift);
      if (!range) throw fieldError('shift', SHIFT_INVALID);
      [shiftStart, shiftEnd] = range;
    } else if (hasShift(contact!.shiftStart, contact!.shiftEnd)) {
      [shiftStart, shiftEnd] = [contact!.shiftStart!, contact!.shiftEnd!];
    } else {
      throw fieldError('shift', `حدّد دوام المسؤول «${contact!.employeeName}» مع الملاحظة.`);
    }

    // قرب الموظف من العميل — للموظف غير المعفى، كما في الويب
    if (ctx.isEmployee && !bypass) {
      const point = await this.notes.clientPoint(client.id);
      if (!point) throw fieldError('currentLatitude', 'لم يُسجَّل موقع هذا العميل — تواصل مع الإدارة لتحديد موقعه.');
      const distance = kmBetween(lat!, lng!, point.latitude, point.longitude);
      const max = await ctx.proximityRadiusKm();
      if (distance > max) throw fieldError('currentLatitude', `يجب أن تكون ضمن نطاق ${max} كم من العميل — المسافة الحالية: ${round(distance, 2)} كم.`);
    }

    const competitorDocuments = Math.trunc(overrides.competitorDocuments ?? 0);
    const text = `${description} | دوام المسؤول: ${noteShiftLabel(shiftStart, shiftEnd)} | عدد العهدة: ${deposit ?? 0}`;

    const stored: string[] = [];
    try {
      for (const file of photos) stored.push(await this.images.savePhoto(MEDIA.notes, file));

      return await this.uow.run(async (tx) => {
        const now = ctx.nowSql;
        const noteId = await this.notes.insertNote(
          {
            employee_id: ctx.user.id,
            client_id: client.id,
            status: 'pending',
            process,
            description: text,
            client_employee_id: contact!.id,
            deposit_count: deposit,
            site_type: siteType ?? 'markets',
            competitor_documents: competitorDocuments,
            shift_start: shiftStart,
            shift_end: shiftEnd,
            attachments: stored.length ? JSON.stringify(stored) : null,
            additional_data: JSON.stringify({
              deposit_count: deposit,
              competitor_documents: competitorDocuments,
              shift_start: shiftStart,
              shift_end: shiftEnd,
              latitude: lat,
              longitude: lng,
              source: 'mobile',
            }),
            created_at: now,
            updated_at: now,
          },
          tx,
        );

        await this.notifications.send(
          {
            userId: ctx.user.id,
            receiverId: ctx.user.id,
            type: 'client_note',
            title: `تم إضافة ملاحظة للعميل ${client.tradeName ?? ''}`,
            description: text,
            clientId: client.id,
            read: false,
          },
          ctx.now,
          tx,
        );

        await this.clients.setColumn(client.id, 'last_note_at', now, now, tx);

        // موقع الموظف لحظة الملاحظة يُربط بها — ما يكتبه الويب
        if (ctx.isEmployee && lat !== null && lng !== null) {
          await this.notes.insertNoteLocation({ employee_id: ctx.user.id, client_id: client.id, client_relation_id: noteId, latitude: lat, longitude: lng, created_at: now, updated_at: now }, tx);
        }

        await this.log.record(
          ctx,
          'note_added',
          client.id,
          `إضافة ملاحظة للعميل من تطبيق الجوال: ${[...(description ?? '')].slice(0, 200).join('')} — عدد العهدة: ${deposit ?? 0}${bypass ? ' (معفى من الموقع)' : ''}`,
          {},
          tx,
        );

        return noteId;
      });
    } catch (e) {
      for (const file of stored) await this.images.delete(MEDIA.notes, file);
      throw e;
    }
  }
}

