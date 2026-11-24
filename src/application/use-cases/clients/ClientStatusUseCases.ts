import { AppError } from '../../../domain/errors/AppError';
import { ClientRepository, ClientRow, ClientsReferenceRepository } from '../../../domain/repositories/clients';
import { UnitOfWork } from '../../ports';
import { ClientsContext, ClientsContextFactory, RequestMeta } from '../../services/clients/ClientsContext';
import { ClientsLog, NotificationGate } from '../../services/clients/ClientsSupport';
import { ClientVisibility } from '../../services/clients/ClientVisibility';
import { FieldErrors, FormInput } from '../../services/clients/FormInput';
import { CLIENT_PERMISSIONS } from './ClientUseCases';

const GUARD_MESSAGE = 'لا يمكنك تغيير عميلٍ غير مسموح لك بالوصول إليه.';

/**
 * حالة العميل ووضعه — طلبٌ للمعتمِد أو تغييرٌ مباشر، بقواعد الويب:
 * الحالة تحتاج اعتماداً لمن لا يملك `clients_approve_status` متى فُعّل ذلك في
 * الإعدادات، والوضع يحتاجه دائماً لمن لا يملك `clients_approve_stage`.
 */
export class ClientStatusUseCases {
  constructor(
    private readonly contexts: ClientsContextFactory,
    private readonly clients: ClientRepository,
    private readonly reference: ClientsReferenceRepository,
    private readonly visibility: ClientVisibility,
    private readonly notifications: NotificationGate,
    private readonly log: ClientsLog,
    private readonly uow: UnitOfWork,
  ) {}

  private async load(userId: number, meta: RequestMeta, clientId: number): Promise<{ ctx: ClientsContext; client: ClientRow }> {
    const ctx = await this.contexts.load(userId, meta, CLIENT_PERMISSIONS.changeStatus);
    const client = await this.clients.find(clientId);
    if (!client) throw AppError.notFound('CLIENT_NOT_FOUND', 'العميل غير موجود.');
    await this.visibility.assertAccess(ctx, client.id, GUARD_MESSAGE);
    return { ctx, client };
  }

  private statusNeedsApproval(ctx: ClientsContext) {
    return !ctx.can('clients_approve_status') && ctx.settings.statusChangeRequiresApproval();
  }

  private stageNeedsApproval(ctx: ClientsContext) {
    return !ctx.can('clients_approve_stage');
  }

  /** ما يحتاجه نموذجا التغيير: الخيارات، وهل يلزم اعتماد، ومن يعتمد */
  async options(userId: number, meta: RequestMeta, clientId: number) {
    const { ctx, client } = await this.load(userId, meta, clientId);
    const statusNeeds = this.statusNeedsApproval(ctx);
    const stageNeeds = this.stageNeedsApproval(ctx);

    const [statuses, stages, statusApprovers, stageApprovers] = await Promise.all([
      this.reference.assignableStatuses(),
      this.reference.registrationStages(),
      statusNeeds ? this.reference.approvers('clients_approve_status') : Promise.resolve([]),
      stageNeeds ? this.reference.approvers('clients_approve_stage') : Promise.resolve([]),
    ]);

    return {
      currentStatusId: client.statusId,
      currentStageId: client.registrationStageId,
      statuses,
      stages,
      statusNeedsApproval: statusNeeds,
      stageNeedsApproval: stageNeeds,
      statusApprovers,
      stageApprovers,
    };
  }

  /** الطلب القادم من زيارة يحمل رقمها في السبب — زيارة هذا العميل وحده */
  private async notesWithVisitTag(client: ClientRow, visitId: number | null, notes: string | null): Promise<string | null> {
    let tag = '';
    if (visitId) {
      const visit = await this.clients.visitOf(visitId);
      if (visit && visit.clientId === client.id) {
        tag = `[من زيارة ${visit.visitNumber || `#${visit.id}`} بتاريخ ${visit.visitDate ? visit.visitDate.slice(0, 10) : ''}] `;
      }
    }
    return `${tag}${(notes ?? '').trim()}`.trim() || null;
  }

  async updateStatus(userId: number, meta: RequestMeta, clientId: number, body: Record<string, unknown>) {
    const { ctx, client } = await this.load(userId, meta, clientId);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const newId = input.integer('statusId', { required: true });
    const rawNotes = input.string('notes', { max: 1000 });
    const managerId = input.integer('managerId');
    const visitId = input.integer('visitId');
    if (newId !== null && !(await this.reference.assignableStatuses()).some((s) => s.id === newId)) {
      errors.add('statusId', 'الحالة المختارة غير متاحة — اختر من قائمة حالات العميل.');
    }
    errors.throwIfAny();

    const oldId = client.statusId && (await this.reference.statusExists(client.statusId)) ? client.statusId : null;
    const notes = await this.notesWithVisitTag(client, visitId, rawNotes);
    const needsApproval = this.statusNeedsApproval(ctx);

    if (needsApproval && !(await this.reference.isApprover(managerId ?? 0, 'clients_approve_status'))) {
      throw AppError.validation({ managerId: ['اختر مسؤولاً يملك صلاحية اعتماد حالات العملاء.'] }, 'اختر مسؤولاً يملك صلاحية اعتماد حالات العملاء (managerId).');
    }
    if (!needsApproval && oldId === newId) {
      throw new AppError('NO_CHANGE', 'العميل على هذه الحالة أصلاً.', 422);
    }

    const oldName = (await this.reference.statusName(oldId)) ?? 'غير معروف';
    const newName = (await this.reference.statusName(newId)) ?? 'غير معروف';
    const reason = notes ? ` — السبب: ${notes}` : '';
    const now = ctx.nowSql;

    await this.uow.run(async (tx) => {
      if (needsApproval) {
        await this.clients.insertStatusRequest(
          'client_status_requests',
          { client_id: client.id, requested_by: ctx.user.id, old_status_id: oldId, new_status_id: newId, status: 'pending', notes, created_at: now, updated_at: now },
          tx,
        );
        await this.log.record(ctx, 'status_change_requested', client.id, `طلب تغيير حالة العميل من «${oldName}» إلى «${newName}» بانتظار الاعتماد — من تطبيق الجوال${reason}`, {
          old: { status_id: oldId },
          new: { status_id: newId },
        }, tx);
        await this.notifications.send(
          {
            userId: ctx.user.id,
            receiverId: managerId,
            clientId: client.id,
            title: 'طلب اعتماد حالة عميل',
            description: `طلب ${ctx.user.name} تغيير حالة العميل ${client.tradeName ?? ''} إلى «${newName}»${reason}`,
            type: 'client_status_request',
            read: false,
            popupShown: false,
            isSent: true,
          },
          ctx.now,
          tx,
        );
        return;
      }

      await this.clients.setColumn(client.id, 'status_id', newId, now, tx);
      await this.clients.insertStatusRequest(
        'client_status_requests',
        { client_id: client.id, requested_by: ctx.user.id, old_status_id: oldId, new_status_id: newId, status: 'approved', approved_by: ctx.user.id, notes, created_at: now, updated_at: now },
        tx,
      );
      await this.log.record(ctx, 'status_changed', client.id, `تغيير حالة العميل من «${oldName}» إلى «${newName}» — من تطبيق الجوال${reason}`, {
        old: { status_id: oldId },
        new: { status_id: newId },
      }, tx);
    });

    return {
      data: { clientId: client.id, statusId: needsApproval ? oldId : newId, pendingApproval: needsApproval },
      message: needsApproval ? 'رُفع طلب تغيير الحالة للمسؤول وأُشعِر به.' : 'تم تغيير حالة العميل.',
    };
  }

  async updateStage(userId: number, meta: RequestMeta, clientId: number, body: Record<string, unknown>) {
    const { ctx, client } = await this.load(userId, meta, clientId);

    const errors = new FieldErrors();
    const input = new FormInput(body, errors);
    const newId = input.integer('stageId');
    const rawNotes = input.string('notes', { max: 1000 });
    const managerId = input.integer('managerId');
    const visitId = input.integer('visitId');
    if (newId !== null && !(await this.reference.registrationStages()).some((s) => s.id === newId)) {
      errors.add('stageId', 'الوضع المختار غير موجود في قائمة أوضاع العملاء.');
    }
    errors.throwIfAny();

    const oldId = client.registrationStageId && (await this.reference.statusExists(client.registrationStageId)) ? client.registrationStageId : null;
    const notes = await this.notesWithVisitTag(client, visitId, rawNotes);
    const needsApproval = this.stageNeedsApproval(ctx);

    if (needsApproval && !(await this.reference.isApprover(managerId ?? 0, 'clients_approve_stage'))) {
      throw AppError.validation({ managerId: ['اختر مسؤولاً يملك صلاحية اعتماد وضع العملاء.'] }, 'اختر مسؤولاً يملك صلاحية اعتماد وضع العملاء (managerId).');
    }
    if (!needsApproval && oldId === newId) {
      throw new AppError('NO_CHANGE', 'العميل على هذا الوضع أصلاً.', 422);
    }

    const oldName = oldId ? (await this.reference.statusName(oldId)) ?? 'بلا وضع' : 'بلا وضع';
    const newName = newId ? (await this.reference.statusName(newId)) ?? 'بلا وضع' : 'بلا وضع';
    const reason = notes ? ` — السبب: ${notes}` : '';
    const now = ctx.nowSql;

    await this.uow.run(async (tx) => {
      if (needsApproval) {
        await this.clients.insertStatusRequest(
          'client_stage_requests',
          { client_id: client.id, requested_by: ctx.user.id, old_stage_id: oldId, new_stage_id: newId, status: 'pending', notes, created_at: now, updated_at: now },
          tx,
        );
        await this.log.record(ctx, 'stage_change_requested', client.id, `طلب تغيير وضع العميل من «${oldName}» إلى «${newName}» بانتظار الاعتماد — من تطبيق الجوال${reason}`, {
          old: { registration_stage_id: oldId },
          new: { registration_stage_id: newId },
        }, tx);
        await this.notifications.send(
          {
            userId: ctx.user.id,
            receiverId: managerId,
            clientId: client.id,
            title: 'طلب اعتماد وضع عميل',
            description: `طلب ${ctx.user.name} تغيير وضع العميل ${client.tradeName ?? ''} إلى «${newName}»${reason}`,
            type: 'client_stage_request',
            read: false,
            popupShown: false,
            isSent: true,
          },
          ctx.now,
          tx,
        );
        return;
      }

      await this.clients.setColumn(client.id, 'registration_stage_id', newId, now, tx);
      await this.clients.insertStatusRequest(
        'client_stage_requests',
        { client_id: client.id, requested_by: ctx.user.id, old_stage_id: oldId, new_stage_id: newId, status: 'approved', approved_by: ctx.user.id, notes, created_at: now, updated_at: now },
        tx,
      );
      await this.log.record(ctx, 'stage_changed', client.id, `تغيير وضع العميل من «${oldName}» إلى «${newName}» — من تطبيق الجوال${reason}`, {
        old: { registration_stage_id: oldId },
        new: { registration_stage_id: newId },
      }, tx);
    });

    return {
      data: { clientId: client.id, stageId: needsApproval ? oldId : newId, pendingApproval: needsApproval },
      message: needsApproval ? 'رُفع طلب تغيير الوضع للمسؤول وأُشعِر به.' : 'تم تغيير وضع العميل.',
    };
  }
}
