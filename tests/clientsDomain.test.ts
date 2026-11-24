import { describe, expect, it } from 'vitest';
import { CurrencyFormatter } from '../src/application/services/clients/ClientsSupport';
import { BranchTree, TreeNode } from '../src/domain/services/clients/BranchTree';
import { ClientSettings } from '../src/domain/services/clients/ClientSettings';
import { formatNumber, isResetDue, trailingNumber } from '../src/domain/services/clients/DocumentNumberFormat';
import { addYears, localNow } from '../src/domain/services/clients/LocalTime';
import { noteShiftLabel, parseShiftRange, shiftLabel, shiftRangeValue } from '../src/domain/services/clients/ShiftRange';
import { dayNameEn, getWeekAndYear } from '../src/domain/services/clients/WeekCalendar';
import { replyThreads, replyTitleKey, replyTitleMatches, statusDecisionFor } from '../src/domain/services/clients/NotificationThreads';
import { ThreadNotification } from '../src/domain/repositories/followup';

const at = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);

describe('WeekCalendar — identical to App\\Helpers\\WeekHelper (outputs captured from PHP)', () => {
  const cases: Array<[string, number, number, string]> = [
    ['2026-01-01 00:00:00', 1, 2026, 'Thursday'],
    ['2026-01-03 00:00:00', 2, 2026, 'Saturday'],
    ['2026-01-03 10:00:00', 2, 2026, 'Saturday'],
    ['2026-01-02 12:00:00', 2, 2026, 'Friday'],
    ['2026-09-26 00:00:00', 40, 2026, 'Saturday'],
    ['2026-09-26 13:00:00', 40, 2026, 'Saturday'],
    ['2026-09-25 23:59:00', 40, 2026, 'Friday'],
    ['2025-12-31 10:00:00', 53, 2025, 'Wednesday'],
    ['2027-01-01 08:00:00', 2, 2027, 'Friday'],
    ['2027-01-02 23:00:00', 2, 2027, 'Saturday'],
    ['2028-12-30 12:00:00', 53, 2028, 'Saturday'],
    ['2028-12-31 00:00:00', 53, 2028, 'Sunday'],
    ['2029-01-01 05:00:00', 1, 2029, 'Monday'],
  ];

  it.each(cases)('%s → week %i of %i (%s)', (when, week, year, day) => {
    expect(getWeekAndYear(at(when))).toEqual({ week, year });
    expect(dayNameEn(at(when))).toBe(day);
  });
});

describe('LocalTime', () => {
  it('reads the wall clock of the configured zone as a naive date', () => {
    const utc = new Date('2026-09-26T21:30:00Z');
    expect(localNow('Asia/Riyadh', utc).toISOString()).toBe('2026-09-27T00:30:00.000Z');
  });

  it('subYears keeps Feb 29 inside February like Carbon', () => {
    expect(addYears(at('2028-02-29 10:00:00'), -1).toISOString()).toBe('2027-02-28T10:00:00.000Z');
  });
});

describe('BranchTree — Branch model helpers', () => {
  const node = (id: number, parentId: number | null, extra: Partial<TreeNode> = {}): TreeNode => ({
    id, name: `n${id}`, code: `C${id}`, parentId, nodeType: 'branch', isTerritory: false, territoryOfficeId: null, isMain: false, status: 1, ...extra,
  });
  const tree = new BranchTree([
    node(1, null, { isMain: true, name: 'الرئيسي' }),
    node(2, 1, { name: 'الرياض' }),
    node(3, 2, { nodeType: 'group', isTerritory: true, name: 'منطقة شمال' }),
    node(4, 3, { nodeType: 'outlet', name: 'منفذ 1' }),
    node(5, 2, { name: 'فرع فرعي' }),
  ]);

  it('subtree is the node and every descendant', () => {
    expect(tree.subtree(2).sort()).toEqual([2, 3, 4, 5]);
  });

  it('accounting branch of an outlet is the nearest branch above it', () => {
    expect(tree.resolveAccountingBranchId(4)).toBe(2);
    expect(tree.resolveAccountingBranchId(5)).toBe(5);
  });

  it('neighborhood territory walks up to the territory, else down', () => {
    expect(tree.resolveTerritoryForNeighborhood(4)).toBe(3);
    expect(tree.resolveTerritoryForNeighborhood(2)).toBe(3);
  });

  it('lineage path from the root', () => {
    expect(tree.lineagePathLabel(4)).toBe('الرئيسي ← الرياض ← منطقة شمال ← منفذ 1');
  });

  it('organisational children skip nested accounting branches', () => {
    expect(tree.withOrganisationalChildren([2])!.sort()).toEqual([2, 3, 4]);
  });
});

describe('ShiftRange — ClientEmployeeNote', () => {
  it('parses full and HH:00|HH:00, rejects the rest', () => {
    expect(parseShiftRange('full')).toEqual(['00:00', '24:00']);
    expect(parseShiftRange('08:00|16:00')).toEqual(['08:00', '16:00']);
    expect(parseShiftRange('08:30|16:00')).toBeNull();
    expect(parseShiftRange('08:00|08:00')).toBeNull();
    expect(parseShiftRange('nonsense')).toBeNull();
  });

  it('labels like the web', () => {
    expect(shiftLabel('08:00', '16:00')).toBe('من 8:00 صباحاً إلى 4:00 مساءً');
    expect(shiftRangeValue('00:00', '24:00')).toBe('full');
    expect(noteShiftLabel('14:00', '22:00')).toBe('2:00 مساءً إلى 10:00 مساءً (مسائي)');
  });
});

describe('ClientSettings — defaults when a row is missing', () => {
  const s = new ClientSettings([], { visitsEnabled: true, itineraryEnabled: true, locationEnabled: true, exemptLocationEnabled: true, notesEnabled: true });

  it('mirrors ClientSettingsHelper defaults', () => {
    expect(s.isLocationRequired()).toBe(true);
    expect(s.requirePhone()).toBe(true);
    expect(s.requireMobile()).toBe(false);
    expect(s.visitProximityRadiusKm()).toBe(0.3);
    expect(s.visitProximityRadiusKmFor(1.5)).toBe(1.5);
    expect(s.maxUploadSizeKb()).toBe(102400);
    expect(s.clientTypeScope()).toBe('Both');
  });
});

describe('DocumentNumberFormat — DocumentNumberService::format()', () => {
  const setting = { section: 'customer', currentNumber: 0, numberOfDigits: 6, prefix: 'C', separator: '-', suffix: null, mode: 0, resetYearly: false, resetPeriod: 'never', lastResetAt: null };

  it('pads with the separator', () => {
    expect(formatNumber(setting, 42, at('2026-09-26 10:00:00'))).toBe('C-000042');
  });

  it('never resets when the period is never', () => {
    expect(isResetDue(setting, at('2026-09-26 10:00:00'))).toBe(false);
  });

  it('reads the trailing number of a code', () => {
    expect(trailingNumber('PUR-00002')).toBe(2);
    expect(trailingNumber('C-000120')).toBe(120);
  });
});

describe('CurrencyFormatter — CurrencySettings::format() in Arabic', () => {
  it('suffixes the symbol and groups thousands', () => {
    const f = new CurrencyFormatter({ code: 'SAR', symbol: 'ر.س', decimalPlaces: 2, thousandsSeparator: ',', decimalSeparator: '.', positiveFormat: 'standard', negativeFormat: 'standard', roundingMethod: 'round' });
    expect(f.format(1234.5)).toBe('1,234.50 ر.س');
    expect(f.format(0.005)).toBe('0.01 ر.س');
  });

  it('falls back to SAR with no default currency', () => {
    expect(new CurrencyFormatter(null).format(10)).toBe('10.00 SAR');
  });
});

describe('NotificationThreads — notifications::replyThreads()', () => {
  const n = (id: number, over: Partial<ThreadNotification>): ThreadNotification => ({ id, title: null, description: null, clientId: null, userId: null, receiverId: null, createdAt: null, parentId: null, ...over });

  it('title keys ignore spacing and a trailing ellipsis', () => {
    expect(replyTitleKey('  زيارة   العميل...  ')).toBe('زيارة العميل');
    expect(replyTitleMatches('زيارة العميل اليوم مهمة', 'زيارة العميل…')).toBe(true);
    expect(replyTitleMatches('شغل', 'شغل العميل من جديد')).toBe(false);
  });

  it('links a legacy reply to the nearest earlier original between the same people', () => {
    const originals = [
      n(2, { title: 'صفي الفاتورة', userId: 1, receiverId: 9, createdAt: '2020-01-02 10:00:00' }),
      n(1, { title: 'صفي الفاتورة', userId: 1, receiverId: 9, createdAt: '2019-01-01 10:00:00' }),
    ];
    const replies = [n(3, { title: 'رد على: صفي الفاتورة', userId: 9, receiverId: 1, createdAt: '2020-01-02 11:00:00' })];
    const threads = replyThreads(replies, originals);
    expect(threads.get(2)).toEqual([3]);
    expect(threads.get(1)).toBeUndefined();
  });

  it('keeps linked replies under their parent', () => {
    expect(replyThreads([n(5, { parentId: 4, title: 'رد على: x' })], []).get(4)).toEqual([5]);
  });

  it('decision of an approved status request', () => {
    const d = statusDecisionFor(
      { id: 1, type: 'client_status_request', userId: 7, clientId: 3, createdAt: '2026-09-26 10:00:00' },
      [{ id: 11, clientId: 3, requestedBy: 7, oldStatusId: 1, newStatusId: 2, status: 'approved', approvedBy: 8, notes: null, createdAt: '2026-09-26 10:00:01', updatedAt: '2026-09-26 12:30:45' }],
      new Map([[1, 'نشط'], [2, 'موقوف']]),
      new Map([[8, 'المدير']]),
    );
    expect(d).toEqual({ text: 'تم اعتماد الطلب: من «نشط» إلى «موقوف»', byId: 8, byName: 'المدير', at: '2026-09-26 12:30' });
  });
});
