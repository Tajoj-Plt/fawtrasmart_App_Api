import { describe, expect, it } from 'vitest';
import { AttendanceUseCases } from '../src/application/use-cases/hr/AttendanceUseCases';
import { AppError } from '../src/domain/errors/AppError';
import { AccessContext } from '../src/domain/services/catalogKit';
import { resolveHrSections } from '../src/domain/services/HrCatalog';
import { MODULES, resolveModules } from '../src/domain/services/ModuleCatalog';

const ctx = (permissions: string[], over: Partial<AccessContext> = {}): AccessContext => ({
  permissions: new Set(permissions),
  applicationStatuses: {},
  subscriptionLinked: false,
  planPermissions: {},
  ...over,
});

const keys = (c: AccessContext) => resolveHrSections(c).flatMap((g) => g.items.map((i) => i.key));

describe('«سجّل حضوري» in the hr catalog', () => {
  it('follows its own web permission, apart from payroll', () => {
    expect(keys(ctx(['attendance_registration.mobile']))).toEqual(['attendance']);
    expect(keys(ctx(['loans.create']))).not.toContain('attendance');
    expect(keys(ctx(['attendance_registration.mobile', 'loans.create']))).toEqual(['overview', 'attendance', 'advanceRequests']);
  });

  it('disappears when the attendance application is switched off', () => {
    expect(keys(ctx(['attendance_registration.mobile'], { applicationStatuses: { employee_attendance: false } }))).toEqual([]);
  });

  it('has its own home card, so a rep without payroll permissions still reaches it', () => {
    const card = MODULES.find((m) => m.key === 'attendance');
    expect(card).toMatchObject({ registryKey: 'employee_attendance', gate: { type: 'any', permissions: ['attendance_registration.mobile'] } });
    const cards = resolveModules({ permissions: new Set(['attendance_registration.mobile']), applicationStatuses: {}, subscriptionLinked: false, planPermissions: {} } as never).map((m) => m.key);
    expect(cards).toContain('attendance');
    expect(cards).not.toContain('hr');
  });
});

/** جسرٌ يردّ ما يُلقَّن — ويسجّل ما طُلب منه */
function setup(response: { status: number; body: unknown }, permissions = ['attendance_registration.mobile']) {
  const calls: Array<{ method: string; module: string; path: string; body?: unknown }> = [];
  const guard = {
    load: async () => ({ user: { id: 42 }, ctx: ctx(permissions) }),
    assertSection: (key: string, c: AccessContext) => {
      if (!keys(c).includes(key as never)) throw AppError.forbidden('SECTION_FORBIDDEN', 'لا تملك صلاحية الوصول إلى هذا القسم.');
    },
  };
  const bridge = {
    request: async (input: { method: string; module: string; path: string; body?: unknown }) => {
      calls.push({ method: input.method, module: input.module, path: input.path, body: input.body });
      return response;
    },
  };
  return { uc: new AttendanceUseCases(guard as never, bridge as never), calls };
}

describe('attendance through the web bridge', () => {
  it('reads the screen state from the web «سجّل حضوري» controller', async () => {
    const { uc, calls } = setup({ status: 200, body: { success: true, data: { channel: 'field', mode: 'in' } } });
    await expect(uc.state(42, 'ar')).resolves.toEqual({ channel: 'field', mode: 'in' });
    expect(calls).toEqual([{ method: 'GET', module: 'hr', path: '/attendance', body: undefined }]);
  });

  it('checks in with the position, and returns the web message and warnings', async () => {
    const { uc, calls } = setup({ status: 200, body: { success: true, message: 'تم تسجيل الحضور بنجاح', warnings: ['تنبيه'], data: { status_code: 'present' } } });
    const r = await uc.checkIn(42, { latitude: 24.7, longitude: 46.7, accuracy: 5 }, 'ar');
    expect(r).toEqual({ message: 'تم تسجيل الحضور بنجاح', data: { result: { status_code: 'present' }, warnings: ['تنبيه'] } });
    expect(calls[0]).toEqual({ method: 'POST', module: 'hr', path: '/attendance/check-in', body: { latitude: 24.7, longitude: 46.7, accuracy: 5 } });
  });

  it('a refused stamp keeps the web reason, its code and its stage', async () => {
    const { uc } = setup({ status: 403, body: { success: false, stage: 'location', code: 'outside_geofence', message: 'أنت خارج نطاق «مقر الرياض» — تبعد 950 متراً والمسموح 200 متر.' } });
    await expect(uc.checkOut(42, { latitude: 1, longitude: 1 }, 'ar')).rejects.toMatchObject({
      code: 'ATTENDANCE_REJECTED',
      status: 422,
      message: 'أنت خارج نطاق «مقر الرياض» — تبعد 950 متراً والمسموح 200 متر.',
      details: { reason: 'outside_geofence', stage: 'location' },
    });
  });

  it('the break sends its action; the position is optional', async () => {
    const { uc, calls } = setup({ status: 200, body: { success: true, message: 'بدأت الاستراحة', data: { on_break: true } } });
    await uc.toggleBreak(42, 'start', {}, 'ar');
    expect(calls[0]).toMatchObject({ path: '/attendance/break', body: { action: 'start' } });
  });

  it('refuses before reaching the web without the attendance permission', async () => {
    const { uc, calls } = setup({ status: 200, body: { success: true } }, ['loans.create']);
    await expect(uc.state(42, 'ar')).rejects.toMatchObject({ code: 'SECTION_FORBIDDEN' });
    expect(calls).toEqual([]);
  });
});
