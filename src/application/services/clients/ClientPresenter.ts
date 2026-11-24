import { ClientContactRow, ClientExtras, ClientRow, NamedOption } from '../../../domain/repositories/clients';
import { BranchTree } from '../../../domain/services/clients/BranchTree';
import { round } from '../../../domain/services/clients/Geo';
import { CurrencyFormatter } from './ClientsSupport';

export interface ClientSummaryDTO {
  id: number;
  code: string | null;
  tradeName: string | null;
  phone: string | null;
  mobile: string | null;
  status: { id: number; name: string; color: string | null } | null;
  branch: NamedOption | null;
  neighborhood: string | null;
  location: { latitude: number; longitude: number } | null;
  balance: number;
  balanceFormatted: string;
  balanceDirection: 'debit' | 'credit' | null;
  [extra: string]: unknown;
}

/**
 * العميل في التطبيق — `ClientResource` في تكامل لارافل بحقوله نفسها (بأسماء camelCase).
 * `balance` هو «المستحق» في شاشة العملاء: مجموع حسابات العميل (موجبٌ = مدين).
 */
export class ClientPresenter {
  constructor(
    private readonly money: CurrencyFormatter,
    private readonly tree: BranchTree,
    private readonly publicUrl: (relativePath: string) => string,
  ) {}

  summary(c: ClientRow, extras: ClientExtras | undefined, due: number, extra: Record<string, unknown> = {}): ClientSummaryDTO {
    return {
      id: c.id,
      code: c.code,
      tradeName: c.tradeName,
      phone: c.phone,
      mobile: c.mobile,
      status: extras?.status ? { id: extras.status.id, name: extras.status.name, color: extras.status.color } : null,
      branch: extras?.branch ?? null,
      neighborhood: extras?.neighborhood?.name ?? null,
      location: extras?.location ?? null,
      balance: round(due, 2),
      balanceFormatted: this.money.format(Math.abs(due)),
      balanceDirection: due > 0 ? 'debit' : due < 0 ? 'credit' : null,
      ...extra,
    };
  }

  /** `Client::resolveTreeNode()` — التبعيّة الصريحة، ثم منطقة الحيّ، ثم الفرع */
  treeNodeOf(c: ClientRow, extras: ClientExtras | undefined): number | null {
    if (c.treeNodeId) return this.tree.find(c.treeNodeId) ? c.treeNodeId : null;
    const regionId = extras?.neighborhood?.regionId ?? null;
    if (regionId && this.tree.find(regionId)) return regionId;
    return c.branchId && this.tree.find(c.branchId) ? c.branchId : null;
  }

  /** `branchTreeDisplayPaths()['main'] ?? branch.name` */
  branchPath(c: ClientRow, extras: ClientExtras | undefined): string | null {
    const node = this.treeNodeOf(c, extras);
    return (node ? this.tree.lineagePathLabel(node) : null) ?? extras?.branch?.name ?? null;
  }

  detail(
    c: ClientRow,
    extras: ClientExtras | undefined,
    due: number,
    related: {
      category: NamedOption | null;
      registrationStage: NamedOption | null;
      employees: NamedOption[];
      contacts: ClientContactRow[];
    },
  ) {
    const displayName = c.tradeName && c.tradeName.trim() !== '' ? c.tradeName : `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || `#${c.id}`;

    return {
      ...this.summary(c, extras, due),
      displayName,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      clientType: c.clientType,
      taxNumber: c.taxNumber,
      commercialRegistration: c.commercialRegistration,
      currency: c.currency,
      printingMethod: c.printingMethod,
      itemQuantityLimit: c.itemQuantityLimit,
      creditLimit: c.creditLimit,
      notes: c.notes,
      street1: c.street1,
      street2: c.street2,
      city: c.city,
      region: c.region,
      postalCode: c.postalCode,
      country: c.country,
      category: related.category,
      registrationStage: related.registrationStage,
      treeNodeId: c.treeNodeId,
      branchPath: this.branchPath(c, extras),
      attachmentUrl: c.attachments ? this.publicUrl(`assets/uploads/${c.attachments}`) : null,
      assignedEmployees: related.employees,
      contacts: related.contacts,
      createdAt: c.createdAt,
    };
  }
}
