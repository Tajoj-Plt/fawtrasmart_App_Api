/** كيانات المجال — انعكاس مباشر لجداول النظام الحالي (users, employees, ...) */

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: string | null;
  roleId: number | null;
  employeeId: number | null;
  branchId: number | null;
  clientId: number | null;
  avatar: string | null;
  lastLoginAt: Date | null;
}

export interface Employee {
  id: number;
  firstName: string;
  middleName: string | null;
  nickname: string | null;
  photo: string | null;
  code: string | null;
  email: string;
  mobile: string | null;
  allowSystemAccess: boolean;
  status: number;
  branchId: number | null;
  departmentId: number | null;
  jobTitleId: number | null;
  directManagerId: number | null;
  hireDate: string | null;
  deletedAt: string | null;
}

export interface EmployeeDetails extends Employee {
  departmentName: string | null;
  jobTitleName: string | null;
}

export interface Branch {
  id: number;
  name: string;
  code: string;
  isMain: boolean;
  parentId: number | null;
  status: number;
  city: string | null;
}

export interface Role {
  id: number;
  name: string;
}

export interface Notification {
  id: number;
  title: string | null;
  description: string | null;
  read: boolean;
  userId: number | null;
  receiverId: number | null;
  type: string | null;
  parentId: number | null;
  createdAt: string | null;
  senderName: string | null;
  receiverName: string | null;
}

export interface ApplicationStatuses {
  [key: string]: 'active' | 'inactive';
}

export interface SubscriptionSnapshot {
  linked: boolean;
  isActive: boolean;
  isExpired: boolean;
  isTrial: boolean;
  status: string | null;
  planName: string | null;
  endDate: string | null;
  daysRemaining: number | null;
  /** صلاحيات الباقة كما ترسلها فوترة: مفتاح ← مسموح */
  permissions: Record<string, boolean>;
}

export interface ThemeRecord {
  color: string | null;
  primaryColor: string | null;
  successColor: string | null;
  dangerColor: string | null;
  infoColor: string | null;
  warningColor: string | null;
  linkColor: string | null;
  fontFamily: string | null;
  layoutMode: string | null;
  borderRadius: string | null;
  appTitle: string | null;
  loginLogo: string | null;
  favicon: string | null;
}

export interface SystemLanguage {
  code: string;
  name: string;
  nativeName: string | null;
  direction: 'rtl' | 'ltr';
  isDefault: boolean;
  flag: string | null;
  dateFormat: string;
  timeFormat: string;
}

export interface PointsTier {
  id: number;
  name: string;
  nameEn: string | null;
  minPoints: number;
  maxPoints: number | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
}

export interface PointsTransaction {
  id: number;
  actionType: string;
  points: number;
  balanceAfter: number;
  description: string | null;
  status: string;
  createdAt: string | null;
}

export interface PointsSummary {
  monthEarned: number;
  monthSpent: number;
  monthNet: number;
  totalEarned: number;
  totalSpent: number;
}

export interface PersonalAccessToken {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  abilities: string[];
  expiresAt: Date | null;
}
