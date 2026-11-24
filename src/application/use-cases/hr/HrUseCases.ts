import { AdvanceRepository, HrReferenceRepository } from '../../../domain/repositories/hr';
import { HR_OVERVIEW_PERMISSIONS, HrSectionKey, resolveHrSections } from '../../../domain/services/HrCatalog';
import { RequestMeta } from '../../services/clients/ClientsContext';
import { HrAccess } from '../../services/HrAccess';
import { HrContextFactory } from '../../services/hr/HrContext';
import { DeductionUseCases } from './DeductionUseCases';
import { PayslipUseCases } from './PayslipUseCases';

const OVERVIEW_SECTIONS: HrSectionKey[] = ['advanceRequests', 'advances', 'deductions', 'salarySlips', 'payslips'];

/**
 * شاشتا الوحدة العامّتان: قائمةُ الأقسام التي يراها الدور، و«نظرة عامة» التي
 * تجمع بطاقاتها من الأقسام المرئيّة غير المقفلة وحدها — فمن لا يرى الخصميات
 * لا يُحسب له عددُها، ولا تُستعلم أصلاً.
 */
export class HrUseCases {
  constructor(
    private readonly guard: HrAccess,
    private readonly contexts: HrContextFactory,
    private readonly reference: HrReferenceRepository,
    private readonly advances: AdvanceRepository,
    private readonly deductions: DeductionUseCases,
    private readonly payslips: PayslipUseCases,
  ) {}

  async sections(userId: number) {
    const { ctx } = await this.guard.load(userId);
    return { groups: resolveHrSections(ctx) };
  }

  async overview(userId: number, meta: RequestMeta) {
    // الحارسُ أوّلاً (الاشتراك ومفتاح «المرتّبات» وصلاحيةُ قسمٍ واحدٍ على الأقل)، ثمّ الكتالوج
    const hr = await this.contexts.load(userId, meta, { permissions: [[...HR_OVERVIEW_PERMISSIONS]] });
    const { ctx } = await this.guard.load(userId);
    const visible = HrAccess.visibleKeys(ctx, OVERVIEW_SECTIONS);

    const employeeId = hr.employeeId;
    const scope = await hr.accessibleEmployeeIds();
    const card = employeeId ? await this.reference.employeeCard(employeeId) : null;

    const seesAdvances = visible.has('advances') || visible.has('advanceRequests');

    const [advanceSummary, advanceCounts, deductions, payslip] = await Promise.all([
      seesAdvances ? this.reference.advanceSummary(card?.advanceAccountId ?? null) : Promise.resolve(null),
      seesAdvances ? this.advances.counts(scope) : Promise.resolve(null),
      visible.has('deductions') ? this.deductions.overview(scope) : Promise.resolve(null),
      visible.has('payslips') && employeeId ? this.payslips.latestForEmployee(employeeId, hr.today) : Promise.resolve(null),
    ]);

    return {
      employee: card ? { id: card.id, name: card.name, jobTitle: card.jobTitle, department: card.department, hasAdvanceAccount: card.hasAdvanceAccount } : null,
      advances: advanceSummary && advanceCounts ? { ...advanceSummary, pending: advanceCounts.pending, active: advanceCounts.active } : null,
      deductions,
      payslip,
    };
  }
}
