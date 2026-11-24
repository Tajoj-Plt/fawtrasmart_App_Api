import { User } from '../../domain/entities';
import { BranchRepository, EmployeeRepository, RoleRepository } from '../../domain/repositories';
import { toUserDTO, UserDTO } from '../dto';
import { AccessService } from './AccessService';

/** يبني UserDTO الكامل (المستخدم + الموظف + الفرع + الدور + الصلاحيات) */
export class UserPresenter {
  constructor(
    private readonly employees: EmployeeRepository,
    private readonly branches: BranchRepository,
    private readonly roles: RoleRepository,
    private readonly access: AccessService,
    private readonly publicUrl: string,
  ) {}

  async present(user: User): Promise<UserDTO> {
    const [employee, role, permissions] = await Promise.all([
      user.employeeId ? this.employees.findDetails(user.employeeId) : Promise.resolve(null),
      user.roleId ? this.roles.findById(user.roleId) : Promise.resolve(null),
      this.access.permissionsFor(user),
    ]);

    const branchId = user.branchId ?? employee?.branchId ?? null;
    const branch = branchId ? await this.branches.findById(branchId) : null;

    return toUserDTO(user, employee, branch, role, Array.from(permissions).sort(), this.publicUrl);
  }
}
