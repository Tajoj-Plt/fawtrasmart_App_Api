import { Tx } from '../../application/ports';
import { NamedOption } from './clients';
import { VisitRow } from './visits';

/**
 * المتابعة بعد الزيارة — الزيارات المنسيّة، وتبريرات الزيارات غير المكتملة،
 * وتفاصيل الإشعار وردوده، وتتبّع الموقع. جداول الويب نفسها.
 */

// ─────────────────────────── الزيارات المنسيّة ───────────────────────────

export interface ForgottenVisitRow extends VisitRow {
  clientName: string | null;
  clientCode: string | null;
}

export interface ForgottenVisitRepository {
  /** `Visit::openWorkspaceVisit()` وقد بدأت قبل `threshold` أو لم تبدأ ومن يومٍ سابق */
  list(threshold: string, today: string, userIds: number[] | null, limit: number): Promise<ForgottenVisitRow[]>;
  find(id: number, threshold: string, today: string): Promise<ForgottenVisitRow | null>;
  usersWithRoleNames(roles: string[]): Promise<number[]>;
}

// ─────────────────────────── التبريرات ───────────────────────────

export interface JustificationRow {
  id: number;
  employeeId: number;
  clientId: number;
  visitDate: string | null;
  dayOfWeek: string | null;
  justification: string | null;
  justificationDate: string | null;
  justificationApproved: number | null;
  approvedBy: string | null;
  client: { id: number; tradeName: string | null; code: string | null } | null;
}

export interface JustificationPeriodRow {
  id: number;
  client: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  status: number | string | null;
  reason: string | null;
}

export interface JustificationRepository {
  needing(userId: number, today: string, ids?: number[] | null, limit?: number): Promise<JustificationRow[]>;
  awaitingApprovalCount(userId: number, today: string): Promise<number>;
  submitted(userId: number, page: number, perPage: number): Promise<{ rows: JustificationRow[]; total: number }>;
  periods(userId: number, limit: number): Promise<JustificationPeriodRow[]>;
  own(userId: number, id: number): Promise<JustificationRow | null>;
  update(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void>;
  /** `users.role` بالاسم (admin/manager) — مستقبِلو إشعار التبريرات في الويب */
  managerIds(): Promise<number[]>;
}

// ─────────────────────────── الإشعار وردوده ───────────────────────────

export interface NotificationDetailRow {
  id: number;
  title: string | null;
  description: string | null;
  type: string | null;
  read: boolean;
  userId: number | null;
  receiverId: number | null;
  clientId: number | null;
  isScheduled: boolean;
  scheduledAt: string | null;
  createdAt: string | null;
  from: NamedOption | null;
  to: NamedOption | null;
  client: { id: number; tradeName: string | null } | null;
}

export interface ThreadNotification {
  id: number;
  title: string | null;
  description?: string | null;
  clientId: number | null;
  userId: number | null;
  receiverId: number | null;
  createdAt: string | null;
  parentId?: number | null;
}

export interface StatusRequestRow {
  id: number;
  clientId: number;
  requestedBy: number;
  oldStatusId: number | null;
  newStatusId: number | null;
  status: string | null;
  approvedBy: number | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NotificationThreadRepository {
  visible(id: number, userId: number): Promise<NotificationDetailRow | null>;
  markRead(id: number, now: string): Promise<void>;
  /** أوّل ردٍّ مربوطٍ بـ`parent_id` — ما بعده كلّه مربوط */
  linkedRepliesSince(): Promise<string | null>;
  linkedReplies(parentId: number): Promise<Array<{ id: number; description: string | null; from: string | null; createdAt: string | null }>>;
  legacyReplyPossible(row: ThreadNotification, titles: string[]): Promise<boolean>;
  allReplies(): Promise<ThreadNotification[]>;
  threadOriginals(opts: { titles: string[]; clientIds: number[]; repliers: number[]; addressees: number[] }): Promise<ThreadNotification[]>;
  repliesByIds(ids: number[]): Promise<Array<{ id: number; description: string | null; from: string | null; createdAt: string | null }>>;
  statusRequests(clientId: number): Promise<StatusRequestRow[]>;
  statusNames(ids: number[]): Promise<Map<number, string>>;
  userNames(ids: number[]): Promise<Map<number, string>>;
}

// ─────────────────────────── تتبّع الموقع ───────────────────────────

export interface TrackingPoint {
  latitude: number;
  longitude: number;
  trackingDate: string;
  createdAt: string;
}

export interface CurrentLocation {
  employeeId: number;
  latitude: number;
  longitude: number;
  updatedAt: string | null;
}

export interface TrackingRepository {
  lastPoint(userId: number, tx: Tx): Promise<TrackingPoint | null>;
  insertPoint(userId: number, point: TrackingPoint, tx: Tx): Promise<void>;
  /** `Location::firstOrNew(['employee_id', 'client_id' => null, 'client_relation_id' => null])` */
  saveCurrent(userId: number, latitude: number, longitude: number, now: string, tx: Tx): Promise<void>;
  path(userId: number, date: string): Promise<TrackingPoint[]>;
  current(userId: number): Promise<CurrentLocation | null>;
  team(since: string, userIds: number[] | null): Promise<CurrentLocation[]>;
  userNames(ids: number[]): Promise<Map<number, string>>;
}
