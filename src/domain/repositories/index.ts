import {
  ApplicationStatuses,
  Branch,
  Employee,
  EmployeeDetails,
  Notification,
  PersonalAccessToken,
  PointsSummary,
  PointsTier,
  PointsTransaction,
  Role,
  SubscriptionSnapshot,
  SystemLanguage,
  ThemeRecord,
  User,
} from '../entities';

/**
 * واجهات المستودعات — طبقة التطبيق لا تعرف knex ولا MySQL،
 * فقط هذه العقود. التنفيذ في infrastructure/repositories.
 */

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: number): Promise<User | null>;
  recordLogin(id: number, ip: string | null): Promise<void>;
  updateProfile(id: number, data: { name?: string; phone?: string | null }): Promise<void>;
  updatePassword(id: number, passwordHash: string): Promise<void>;
  updateAvatar(id: number, avatarPath: string): Promise<void>;
  updateBranch(id: number, branchId: number | null): Promise<void>;
  /** حسابات المستخدمين في هذه الفروع/الموظفين — لنطاق الرؤية (DataScope) */
  idsByBranchIds(branchIds: number[]): Promise<number[]>;
  idsByEmployeeIds(employeeIds: number[]): Promise<number[]>;
}

export interface EmployeeRepository {
  /** يشمل المؤرشَف (deletedAt غير فارغ) كي يقرّر منطق الدخول بنفسه */
  findById(id: number): Promise<Employee | null>;
  findDetails(id: number): Promise<EmployeeDetails | null>;
  assignedBranchIds(employeeId: number): Promise<number[]>;
  /** كل التابعين في السلسلة الإدارية (direct_manager_id) بلا حدّ للعمق */
  descendantIds(employeeId: number): Promise<number[]>;
  branchIdsOf(employeeIds: number[]): Promise<number[]>;
  idsByBranchIds(branchIds: number[]): Promise<number[]>;
  idsByDepartment(departmentId: number): Promise<number[]>;
}

export interface RoleRepository {
  findById(id: number): Promise<Role | null>;
  permissionNames(roleId: number): Promise<string[]>;
}

export interface BranchRepository {
  findById(id: number): Promise<Branch | null>;
  /** الفروع الفعّالة (status != 1) مرتّبة بالاسم */
  active(): Promise<Branch[]>;
  activeByIds(ids: number[]): Promise<Branch[]>;
  descendantIds(branchId: number): Promise<number[]>;
  /** الفروع التنظيمية تحت هذه الجذور (مجموعات/منافذ لا فروعاً محاسبية) — `AffiliationTree::withOrganisationalChildren` */
  organisationalChildren(rootIds: number[]): Promise<number[]>;
}

export interface SettingsRepository {
  applicationStatuses(): Promise<ApplicationStatuses>;
  subscription(): Promise<SubscriptionSnapshot>;
  theme(): Promise<ThemeRecord | null>;
  activeLanguages(): Promise<SystemLanguage[]>;
}

export interface NotificationListParams {
  userId: number;
  /** من يملك notifications_view_system_notifications يرى الكل */
  seeAll: boolean;
  unreadOnly: boolean;
  /** آخر 24 ساعة فقط (سلوك جرس الترويسة في الويب) */
  last24hOnly: boolean;
  page: number;
  perPage: number;
}

export interface NotificationRepository {
  list(params: NotificationListParams): Promise<{ items: Notification[]; total: number }>;
  unreadCount(userId: number, seeAll: boolean): Promise<number>;
  markRead(ids: number[], userId: number, seeAll: boolean): Promise<number>;
  markAllRead(userId: number, seeAll: boolean): Promise<number>;
}

export interface TokenRepository {
  create(data: {
    userId: number;
    name: string;
    tokenHash: string;
    abilities: string[];
    expiresAt: Date;
  }): Promise<number>;
  findByHash(tokenHash: string): Promise<PersonalAccessToken | null>;
  touch(id: number): Promise<void>;
  delete(id: number): Promise<void>;
  deleteAllForUser(userId: number, namePrefix?: string): Promise<void>;
}

export interface TrustedDeviceInput {
  userId: number;
  fingerprint: string;
  deviceName: string;
  ip: string | null;
  userAgent: string;
  browser: string;
  os: string;
}

export interface DeviceRepository {
  upsertTrusted(input: TrustedDeviceInput): Promise<void>;
}

export interface ActivityLogInput {
  createdBy: number | null;
  description: string;
  action: string;
  ip: string | null;
  os: string;
  device: string;
  route: string;
}

export interface ActivityLogRepository {
  log(input: ActivityLogInput): Promise<void>;
}

export interface PointsRepository {
  summary(employeeId: number, month: number, year: number): Promise<PointsSummary>;
  tiers(): Promise<PointsTier[]>;
  recent(employeeId: number, month: number, year: number, limit: number): Promise<PointsTransaction[]>;
}
