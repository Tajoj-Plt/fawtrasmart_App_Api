import { Tx } from '../../application/ports';
import { ModuleSettingsRow, SettingRow } from '../services/clients/ClientSettings';
import { TreeNode } from '../services/clients/BranchTree';
import { SerialSetting } from '../services/clients/DocumentNumberFormat';

/**
 * عقود مستودعات وحدة العملاء — طبقة التطبيق لا تعرف knex. كل دالّة كتابة تقبل
 * سياق معاملةٍ اختيارياً (`tx`) لتُنفَّذ ضمن `UnitOfWork.run()` كلّها أو لا شيء.
 */

// ─────────────────────────── أنواع مرجعية ───────────────────────────

export interface NamedOption {
  id: number;
  name: string;
}

export interface StatusOption extends NamedOption {
  color: string | null;
}

export interface CurrencyRow {
  code: string;
  symbol: string;
  decimalPlaces: number;
  thousandsSeparator: string;
  decimalSeparator: string;
  positiveFormat: string;
  negativeFormat: string;
  roundingMethod: string;
}

export interface LedgerParent {
  id: number;
  code: string;
  accountType: string | null;
  balanceType: string | null;
}

export interface PlanUsageItem {
  label: string;
  period: string | null;
  unlimited: boolean;
  allowance: number;
  used: number;
}

/** صفّ `fawtra_subscription` بما يقرؤه `EnsureSubscription::state()` — `null` إن لا صفّ */
export interface SubscriptionRecord {
  hasSnapshot: boolean;
  isActive: boolean;
  isExpired: boolean;
  isTrial: boolean;
  status: string | null;
  endDate: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface ClientsReferenceRepository {
  subscriptionRecord(): Promise<SubscriptionRecord | null>;
  /** `SubscriptionGate::allows()` + اسم الميزة كما تعرضه شاشة الاشتراك */
  planFeature(key: string): Promise<{ allowed: boolean; label: string }>;
  settingRows(): Promise<SettingRow[]>;
  moduleSettings(): Promise<ModuleSettingsRow>;
  treeNodes(): Promise<TreeNode[]>;
  assignableStatuses(): Promise<StatusOption[]>;
  registrationStages(): Promise<StatusOption[]>;
  statusName(id: number | null): Promise<string | null>;
  statusExists(id: number): Promise<boolean>;
  categories(): Promise<NamedOption[]>;
  approvers(permission: string): Promise<NamedOption[]>;
  isApprover(userId: number, permission: string): Promise<boolean>;
  defaultCurrency(): Promise<CurrencyRow | null>;
  ledgerParent(key: string): Promise<LedgerParent | null>;
  notificationSettings(): Promise<Record<string, boolean>>;
  planUsage(feature: string): Promise<{ item: PlanUsageItem | null; subscriptionStart: string | null }>;
  userProximityRadius(userId: number): Promise<number | null>;
  regionGroupIds(employeeId: number): Promise<number[]>;
  assignableEmployees(departmentIds: number[], alsoIds: number[]): Promise<Array<{ id: number; name: string; department: string | null; departmentId: number | null }>>;
  employeeDepartment(employeeId: number): Promise<{ exists: boolean; departmentId: number | null }>;
  activeCompetitors(): Promise<NamedOption[]>;
  userNames(ids: number[]): Promise<Map<number, { name: string; roleId: number | null; roleName: string | null }>>;
}

// ─────────────────────────── السجلّات والأرقام والإشعارات ───────────────────────────

export interface OperationLogInput {
  action: string;
  module: string;
  subjectId: number | null;
  description: string;
  userId: number | null;
  ip: string | null;
  userAgent: string | null;
  route: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

export interface OperationFailureInput {
  module: string;
  action: string;
  error: Error;
  userId: number | null;
  subjectId?: number | null;
  ip: string | null;
  userAgent: string | null;
  url: string | null;
}

/** `OperationLog::record()` / `failure()` — سجلّات النشاط والأحداث والأخطاء في الويب */
export interface OperationLogRepository {
  record(input: OperationLogInput, tx?: Tx): Promise<void>;
  failure(input: OperationFailureInput): Promise<void>;
}

export interface DocumentNumberRepository {
  /** يقفل صفّ الإعداد ويستهلك الرقم التالي الشاغر — ضمن المعاملة الممرّرة */
  next(section: string, now: Date, tx: Tx): Promise<string>;
  peek(section: string, now: Date): Promise<string>;
  load(section: string): Promise<SerialSetting | null>;
}

export interface NotificationInput {
  userId: number | null;
  receiverId: number | null;
  clientId?: number | null;
  parentId?: number | null;
  title: string;
  description: string | null;
  type: string;
  read?: boolean;
  isSent?: boolean;
  popupShown?: boolean;
}

export interface NotificationWriteRepository {
  /** يُعيد المعرّف، أو null إن كان النوع معطَّلاً من إعدادات الإشعارات */
  insert(input: NotificationInput, now: Date, tx?: Tx): Promise<number>;
  countCreatedBetween(from: string, to: string): Promise<number>;
  supportsParentLink(): Promise<boolean>;
}

// ─────────────────────────── العملاء ───────────────────────────

/**
 * «أيّ العملاء أرى» مترجَمةً إلى قيدٍ يطبّقه المستودع على `clients`:
 *   none    ← لا شيء (`1 = 0`)
 *   all     ← بلا قيد
 *   tree    ← «تابع لـ» ضمن عقد الشجرة (`AffiliationTree::constrainClients`)
 *   ids     ← معرّفات صريحة
 *   regions ← حيّ العميل في إحدى مجموعات المناطق (`neighborhood.Region`)
 */
export type ClientScope =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'tree'; nodeIds: number[] }
  | { kind: 'ids'; ids: number[] }
  | { kind: 'regions'; groupIds: number[] };

export interface DateWindow {
  from: string;
  to: string;
}

export interface ClientListFilters {
  search?: string;
  clientId?: number;
  name?: string;
  status?: number | 'no_status';
  registrationStageId?: number;
  /** فلتر «المنطقة» بعد توسيعه في الشجرة — مصفوفة فارغة = لا شيء */
  regionNodeIds?: number[];
  /** فلتر «الفرع» بعد توسيعه — مصفوفة فارغة = لا شيء */
  branchNodeIds?: number[];
  neighborhood?: string;
  dateFrom?: string;
  dateTo?: string;
  categoryId?: number;
  clientType?: number;
  employeeId?: number;
  overCreditLimit?: boolean;
  customerTarget?: number | 'no_target';
  lastInvoice?: DateWindow;
  lastPayment?: DateWindow;
  lastActivity?: DateWindow;
  excludeIds?: number[];
  onlyIds?: number[];
  withLocation?: boolean;
  sort?: 'newest' | 'name';
}

export interface ClientRow {
  id: number;
  code: string | null;
  tradeName: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  statusId: number | null;
  registrationStageId: number | null;
  categoryId: number | null;
  branchId: number | null;
  treeNodeId: number | null;
  clientType: number | null;
  taxNumber: string | null;
  commercialRegistration: string | null;
  currency: string | null;
  printingMethod: number | null;
  itemQuantityLimit: number | null;
  creditLimit: number | null;
  notes: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  attachments: string | null;
  exemptVisitLocation: boolean;
  createdAt: string | null;
}

/** ما يُلحق بكل صفّ عميل للعرض — بعلاقات الويب نفسها */
export interface ClientExtras {
  status: StatusOption | null;
  branch: NamedOption | null;
  neighborhood: { name: string; regionId: number | null } | null;
  location: { latitude: number; longitude: number } | null;
}

export interface ClientContactRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface ClientRepository {
  page(scope: ClientScope, filters: ClientListFilters, page: number, perPage: number): Promise<{ rows: ClientRow[]; total: number }>;
  list(scope: ClientScope, filters: ClientListFilters, limit: number): Promise<ClientRow[]>;
  find(id: number, tx?: Tx): Promise<ClientRow | null>;
  inScope(scope: ClientScope, clientId: number): Promise<boolean>;
  extras(rows: ClientRow[]): Promise<Map<number, ClientExtras>>;
  dueBalances(ids: number[]): Promise<Map<number, number>>;
  /** اسمٌ تجاريّ ورمزٌ لكل عميل — مرتّبةً بالاسم (شريط «أُنهيت زياراتهم اليوم») */
  briefs(ids: number[]): Promise<Array<{ id: number; tradeName: string; code: string | null }>>;
  category(id: number | null): Promise<NamedOption | null>;
  contacts(clientId: number): Promise<ClientContactRow[]>;
  assignedEmployees(clientId: number): Promise<NamedOption[]>;

  // اليوم والزيارة
  todayVisits(userId: number, clientIds: number[], today: string): Promise<Array<{ id: number; clientId: number; stage: string | null; departed: boolean }>>;
  openVisitId(userId: number, clientId: number, today: string): Promise<number | null>;
  pendingItineraryClientIds(userId: number, today: string): Promise<number[]>;
  finishedTodayClientIds(userId: number, today: string): Promise<number[]>;
  hiddenClientIds(userId: number, now: string, dayStart: string): Promise<number[]>;
  itineraryClientIds(userIds: number[] | null, dayNameEn: string, year: number, week: number): Promise<number[]>;
  todayItineraryRows(userId: number, today: string): Promise<Array<{ clientId: number; addedBy: number | null }>>;
  assignedClientIds(employeeIds: number[]): Promise<number[]>;
  employeeGroupIds(employeeIds: number[]): Promise<number[]>;
  allEmployeeIds(): Promise<number[]>;

  // الكتابة
  insert(fields: Record<string, unknown>, tx: Tx): Promise<number>;
  update(id: number, fields: Record<string, unknown>, tx: Tx): Promise<void>;
  phoneTaken(phone: string, exceptId: number | null): Promise<boolean>;
  emailTaken(email: string, exceptUserId: number | null): Promise<boolean>;
  loginUserId(clientId: number): Promise<number | null>;
  createContact(clientId: number, values: Record<string, unknown>, now: string, tx: Tx): Promise<void>;
  syncContacts(clientId: number, incoming: Array<Record<string, unknown>>, now: string, tx: Tx): Promise<void>;
  replaceAssignments(clientId: number, employeeIds: number[], now: string, tx: Tx): Promise<void>;
  addAssignment(clientId: number, employeeId: number, now: string, tx: Tx): Promise<void>;
  ensureAssignment(clientId: number, employeeId: number, now: string, tx: Tx): Promise<void>;
  addLocation(clientId: number, latitude: unknown, longitude: unknown, now: string, tx: Tx): Promise<void>;
  replaceLocation(clientId: number, latitude: unknown, longitude: unknown, now: string, tx: Tx): Promise<void>;
  neighborhood(clientId: number, tx?: Tx): Promise<{ id: number; name: string; regionId: number | null } | null>;
  createNeighborhood(clientId: number, name: string, regionId: number, now: string, tx: Tx): Promise<void>;
  upsertNeighborhood(clientId: number, name: string, regionId: number, now: string, tx: Tx): Promise<void>;
  createLoginUser(clientId: number, payload: { name: string; email: string; phone: string }, passwordHash: string, now: string, tx: Tx): Promise<void>;
  updateLoginUser(userId: number, payload: { name: string; email: string; phone: string }, now: string, tx: Tx): Promise<void>;
  ledgerAccountId(clientId: number, tx?: Tx): Promise<number | null>;
  createLedgerAccount(clientId: number, name: string, parent: LedgerParent, now: string, tx: Tx): Promise<number>;
  renameLedgerAccount(accountId: number, name: string, now: string, tx: Tx): Promise<void>;
  /** `EmployeeClientVisit::updateOrCreate()` — `created` لتشغيل خطّاف الإنشاء في طبقة التطبيق */
  upsertItineraryRow(values: { employeeId: number; clientId: number; dayOfWeek: string; year: number; weekNumber: number; visitDate: string }, now: string, tx: Tx): Promise<{ id: number; created: boolean }>;
  /** يُطفئ «استبعاد الموقع» إن كان مضاءً — يُعيد اسم العميل حين غيّره */
  clearExemptLocation(clientId: number, now: string, tx?: Tx): Promise<string | null>;
  createVisit(values: Record<string, unknown>, tx?: Tx): Promise<number>;
  visitOf(visitId: number): Promise<{ id: number; clientId: number; visitNumber: string | null; visitDate: string | null } | null>;
  setColumn(clientId: number, column: 'status_id' | 'registration_stage_id' | 'last_note_at', value: unknown, now: string, tx: Tx): Promise<void>;
  insertStatusRequest(table: 'client_status_requests' | 'client_stage_requests', values: Record<string, unknown>, tx: Tx): Promise<void>;
  invoiceBelongsTo(invoiceId: number, clientId: number): Promise<boolean>;
}

// ─────────────────────────── مسؤولو العميل والملاحظات ───────────────────────────

export interface ContactPersonRow {
  id: number;
  clientId: number;
  userId: number;
  employeeName: string;
  employeePosition: string | null;
  employeePhone: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  isPrimary: boolean;
  invoiceId: number | null;
  invoiceCode: string | null;
  image: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface NoteRow {
  id: number;
  clientId: number;
  userId: number | null;
  description: string | null;
  process: string | null;
  status: string | null;
  depositCount: number | null;
  competitorDocuments: number;
  siteType: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  attachments: string[];
  additionalData: Record<string, unknown>;
  contact: NamedOption | null;
  employee: NamedOption | null;
  competitors: Array<{ competitorId: number | null; name: string; assetCount: number; photoPath: string | null }>;
  createdAt: string | null;
}

export interface ClientNotesRepository {
  contacts(clientId: number): Promise<ContactPersonRow[]>;
  contactOfClient(id: number, clientId: number): Promise<ContactPersonRow | null>;
  insertContact(values: Record<string, unknown>): Promise<number>;

  notes(clientId: number, ownerUserId: number | null, page: number, perPage: number): Promise<{ rows: NoteRow[]; total: number }>;
  note(id: number): Promise<NoteRow | null>;
  insertNote(values: Record<string, unknown>, tx: Tx): Promise<number>;
  updateNote(id: number, values: Record<string, unknown>, tx?: Tx): Promise<void>;
  deleteNote(id: number, tx: Tx): Promise<void>;
  insertNoteLocation(values: Record<string, unknown>, tx: Tx): Promise<void>;
  clientPoint(clientId: number): Promise<{ latitude: number; longitude: number } | null>;
}
