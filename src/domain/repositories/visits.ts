import { Tx } from '../../application/ports';
import { NamedOption } from './clients';

/**
 * عقود خطّ السير ومساحة الزيارة — جداول الويب نفسها:
 * `employee_client_visits` (صفوف خطّ السير، `employee_id` = `users.id`)،
 * `visits` (الزيارة الفعلية)، `visit_competitor_observations`، `competitors`.
 * الأوقات نصوصٌ ساذجة بتوقيت النظام (`Y-m-d H:i:s`).
 */

export interface ItineraryRow {
  id: number;
  employeeId: number;
  clientId: number;
  addedBy: number | null;
  visitDate: string | null;
  plannedTime: string | null;
  dayOfWeek: string | null;
  year: number | null;
  weekNumber: number | null;
  sequence: number | null;
  status: string | null;
  visitStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** بطاقة العميل في خطّ السير — `ItineraryWeekService::describeClients()` */
export interface DescribedClient {
  id: number;
  name: string;
  code: string;
  status: { name: string; color: string | null } | null;
  nodeId: number | null;
  lat: number | null;
  lng: number | null;
  lastVisit: string | null;
}

export interface ItineraryRepository {
  dayRows(userId: number, date: string): Promise<ItineraryRow[]>;
  row(id: number): Promise<ItineraryRow | null>;
  describeClients(ids: number[]): Promise<Map<number, DescribedClient>>;
  clientContacts(ids: number[]): Promise<Map<number, { phone: string | null; mobile: string | null; city: string | null; street1: string | null }>>;
  startedWorkspaceClientIds(userId: number, today: string): Promise<number[]>;
  recentNotes(clientId: number, limit: number): Promise<Array<{ description: string | null; attachments: string | null; createdAt: string | null }>>;
  openClientIds(userId: number, date: string): Promise<number[]>;
  countDay(userId: number, date: string, tx?: Tx): Promise<number>;
  existsOnDay(userId: number, date: string, clientId: number): Promise<boolean>;
  isDayStarted(userId: number, year: number, week: number, day: string): Promise<boolean>;
  renumberDay(userId: number, date: string, tx: Tx): Promise<number>;
  insertRow(values: Record<string, unknown>, tx?: Tx): Promise<number>;
  updateRow(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void>;
  assignedClientIds(userId: number): Promise<number[]>;

  /** مندوبو المُنتقي — بنطاق المستخدم وأقسام موظفي العملاء وفرع الهيدر */
  employeeOptions(opts: { scopeUserIds: number[] | null; headerNodeIds: number[] | null; departmentIds: number[]; excludeUserId: number }): Promise<NamedOption[]>;
  usersWithEmployees(ids: number[]): Promise<NamedOption[]>;
  userInDepartments(userId: number, departmentIds: number[]): Promise<boolean>;
  userInNodes(userId: number, nodeIds: number[]): Promise<boolean>;
  /** كلُّ فروع الموظف (`employee_branch`) — ما يبلغه في الويب بمبدّل الفرع في الشريط */
  employeeBranchIds(employeeId: number): Promise<number[]>;
  userName(id: number): Promise<string | null>;
  userExists(id: number): Promise<boolean>;

  /** عملاء «تابع لـ» — كل مجموعة عقدٍ قيدٌ مستقلّ (نطاق المستخدم ثم فرع الهيدر) */
  pickerClients(constraints: number[][], term: string, limit: number): Promise<{ ids: number[]; total: number }>;
  clientsWithin(constraints: number[][], ids: number[]): Promise<number[]>;
}

export interface VisitRow {
  id: number;
  employeeId: number;
  employeeName: string | null;
  clientId: number;
  visitNumber: string | null;
  visitDate: string | null;
  stage: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  totalPausedSeconds: number;
  arrivalTime: string | null;
  departureTime: string | null;
  outcome: string | null;
  outcomeNotes: string | null;
  cancelReason: string | null;
  recordingMethod: string | null;
  clientLatitude: number | null;
  clientLongitude: number | null;
}

export interface VisitDocument {
  group: string;
  type: string;
  id: number;
  number: string | null;
  amount: number | null;
  at: string | null;
  paymentStatus?: number;
}

export interface ClientNotificationRow {
  id: number;
  title: string | null;
  description: string | null;
  read: boolean;
  from: string | null;
  createdAt: string | null;
  replies: Array<{ description: string | null; createdAt: string | null }>;
  userId: number | null;
  clientId: number | null;
}

export interface VisitRepository {
  find(id: number): Promise<VisitRow | null>;
  openToday(userId: number, clientId: number, today: string, tx?: Tx): Promise<VisitRow | null>;
  /** زيارة المستخدم التي بدأت اليوم ولم تُنهَ ولم تُلغَ — شرط قفل التنقّل في الويب (`LockToOpenVisit`) */
  startedOpenToday(userId: number, today: string): Promise<VisitRow | null>;
  update(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void>;
  /** تحديثٌ لا يقع إلا إن بقيت الزيارة على حالها (`notStarted` | `open`) — يمنع النقر المزدوج من التكرار */
  updateIf(id: number, guard: 'notStarted' | 'open', values: Record<string, unknown>): Promise<boolean>;
  /** يقفل صفّ العميل حتى نهاية المعاملة — فتحُ زيارتين متزامنتين للعميل نفسه يُسلسَل */
  lockClient(clientId: number, tx: Tx): Promise<void>;
  markStartedFor(employeeId: number, clientId: number, date: string, now: string): Promise<void>;
  markCompletedFor(employeeId: number, clientId: number, date: string, now: string, durationMinutes: number | null): Promise<void>;

  // خطوات الزيارة
  contactShifts(clientId: number): Promise<Array<{ shiftStart: string | null; shiftEnd: string | null }>>;
  hasNoteSince(clientId: number, userId: number, since: string): Promise<boolean>;
  latestNoteIdSince(clientId: number, userId: number, since: string): Promise<number | null>;
  hasSaleOrCollectionSince(clientId: number, userId: number, since: string): Promise<boolean>;
  hasObservations(visitId: number): Promise<boolean>;

  // المنافسون
  observations(visitId: number): Promise<Array<{ competitorId: number | null; name: string; assetCount: number; photoPath: string | null }>>;
  observationScope(visitId: number, noteId: number | null, userId: number): Promise<{ any: boolean; competitorIds: number[] }>;
  insertObservation(values: Record<string, unknown>, tx: Tx): Promise<void>;
  countNoteCompetitors(noteId: number): Promise<number>;
  setNoteCompetitorDocuments(noteId: number, count: number): Promise<void>;
  activeCompetitors(ids: number[]): Promise<Map<number, string>>;
  competitorByName(name: string): Promise<{ id: number; name: string; isActive: boolean } | null>;
  insertCompetitor(values: Record<string, unknown>): Promise<number>;

  // مسؤول العميل
  updateContactShift(contactId: number, start: string, end: string, now: string): Promise<void>;

  // إشعارات الإدارة عن العميل
  clientNotifications(clientId: number, userId: number, now: string): Promise<ClientNotificationRow[]>;
  ownedClientNotification(id: number, clientId: number, userId: number): Promise<ClientNotificationRow | null>;
  markNotificationRead(id: number, now: string, tx?: Tx): Promise<void>;

  // المستندات
  documents(opts: { clientId: number; creators: number[]; since: string | null; until: string | null; visitOnly: boolean; limit: number }): Promise<VisitDocument[]>;
  hasSpatieRole(userId: number, role: string): Promise<boolean>;
  /** سند قبضٍ ماليّ (`receipts`) لهذا العميل — بعميله أو بحسابه كقائمة مستندات الزيارة */
  clientReceipt(receiptId: number, clientId: number): Promise<VisitReceipt | null>;
}

export interface VisitReceipt {
  id: number;
  code: string | null;
  date: string | null;
  amount: number;
  totalAmount: number;
  description: string | null;
  seller: string | null;
  currency: string | null;
  cancelled: boolean;
}
