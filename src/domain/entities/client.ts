/** أنواع وحدة العملاء — صفوف القوائم كما تُعرض في التطبيق */

export interface ClientRow {
  id: number;
  code: number | null;
  name: string;
  phone: string | null;
  mobile: string | null;
  city: string | null;
  region: string | null;
  statusId: number | null;
  statusName: string | null;
  statusColor: string | null;
  categoryName: string | null;
  clientType: number | null;
  creditLimit: number | null;
  employeeId: number | null;
}

export interface CompetitorRow {
  id: number;
  name: string;
  notes: string | null;
  active: boolean;
}

export interface DoubtfulDebtRow {
  id: number;
  clientId: number;
  clientName: string | null;
  originalBalance: number;
  provisionAmount: number;
  provisionPercentage: number;
  status: string;
  collectedAmount: number;
  collectedDate: string | null;
  notes: string | null;
}

export interface ItineraryVisitRow {
  id: number;
  clientId: number;
  clientName: string | null;
  clientPhone: string | null;
  clientCity: string | null;
  status: string;
  justificationApproved: number | null;
}

/** نطاق رؤية العملاء — محورا الأشخاص والمكان لا يجتمعان أبداً (كما في الويب) */
export type ClientScope =
  | { mode: 'unrestricted' }
  | { mode: 'branch'; branchIds: number[] }
  /** خط السير اليومي: عملاء لهم زيارة اليوم لأحد هؤلاء الموظفين */
  | { mode: 'itinerary'; employeeIds: number[]; dayOfWeek: string; year: number; week: number }
  /** العملاء المُسنَدون لأحد هؤلاء الموظفين (client_employee) */
  | { mode: 'assigned'; employeeIds: number[] }
  /** لا صلاحية تعطي نطاقاً — لا عملاء */
  | { mode: 'none' };

export interface ClientListQuery {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
  categoryId?: number;
}

export interface ClientOverviewFigures {
  total: number;
  active: number;
  stopped: number;
  /** عدد زيارات خط السير اليوم لنطاق المستخدم */
  todayItinerary: number | null;
}
