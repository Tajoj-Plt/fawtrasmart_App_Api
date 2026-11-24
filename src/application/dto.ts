import { Branch, EmployeeDetails, Notification, PointsTier, PointsTransaction, User } from '../domain/entities';

export interface UserDTO {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  /** الحرف الأول للاسم — كما تعرضه ترويسة الويب حين لا صورة */
  initial: string;
  role: { id: number; name: string } | null;
  isEmployee: boolean;
  isClient: boolean;
  branch: { id: number; name: string; code: string } | null;
  employee: {
    id: number;
    fullName: string;
    code: string | null;
    photoUrl: string | null;
    jobTitle: string | null;
    department: string | null;
    hireDate: string | null;
    mobile: string | null;
  } | null;
  permissions: string[];
  lastLoginAt: string | null;
}

export interface AuthResultDTO {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: UserDTO;
}

export interface NotificationDTO {
  id: number;
  title: string | null;
  description: string | null;
  read: boolean;
  type: string | null;
  createdAt: string | null;
  sender: string | null;
  receiver: string | null;
  isSender: boolean;
  isReceiver: boolean;
}

export interface BranchDTO {
  id: number;
  name: string;
  code: string;
  isMain: boolean;
  city: string | null;
  current: boolean;
}

export interface ProfileDTO {
  user: UserDTO;
  branches: {
    canSwitch: boolean;
    canSwitchToAll: boolean;
    items: BranchDTO[];
  };
  points: {
    month: number;
    year: number;
    balance: number;
    monthEarned: number;
    monthSpent: number;
    totalEarned: number;
    totalSpent: number;
    currentTier: PointsTier | null;
    nextTier: PointsTier | null;
    pointsToNextTier: number | null;
    progressToNextTier: number;
    recent: PointsTransaction[];
  } | null;
}

export function toBranchDTO(branch: Branch, currentId: number | null): BranchDTO {
  return {
    id: branch.id,
    name: branch.name,
    code: branch.code,
    isMain: branch.isMain,
    city: branch.city,
    current: branch.id === currentId,
  };
}

export function toNotificationDTO(n: Notification, userId: number): NotificationDTO {
  return {
    id: n.id,
    title: n.title,
    description: n.description,
    read: n.read,
    type: n.type,
    createdAt: n.createdAt,
    sender: n.senderName,
    receiver: n.receiverName ?? 'الجميع',
    isSender: n.userId === userId,
    isReceiver: n.receiverId === userId,
  };
}

export function assetUrl(publicUrl: string, path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${publicUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function toUserDTO(
  user: User,
  employee: EmployeeDetails | null,
  branch: Branch | null,
  role: { id: number; name: string } | null,
  permissions: string[],
  publicUrl: string,
): UserDTO {
  const fullName = employee
    ? [employee.firstName, employee.middleName, employee.nickname].filter(Boolean).join(' ').trim()
    : '';

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: assetUrl(publicUrl, user.avatar) ?? assetUrl(publicUrl, employee?.photo ?? null),
    initial: (user.name || '?').trim().charAt(0),
    role,
    isEmployee: user.employeeId !== null,
    isClient: role?.name === 'client',
    branch: branch ? { id: branch.id, name: branch.name, code: branch.code } : null,
    employee: employee
      ? {
          id: employee.id,
          fullName,
          code: employee.code,
          photoUrl: assetUrl(publicUrl, employee.photo),
          jobTitle: employee.jobTitleName,
          department: employee.departmentName,
          hireDate: employee.hireDate,
          mobile: employee.mobile,
        }
      : null,
    permissions,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
  };
}
