import { Knex } from 'knex';
import { Role } from '../../domain/entities';
import { RoleRepository } from '../../domain/repositories';

export class KnexRoleRepository implements RoleRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: number): Promise<Role | null> {
    const row = await this.db('roles').select('id', 'name').where('id', id).first();
    return row ? { id: Number(row.id), name: String(row.name) } : null;
  }

  async permissionNames(roleId: number): Promise<string[]> {
    const rows = await this.db('role_has_permissions as rp')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .where('rp.role_id', roleId)
      .pluck('p.name');
    return rows.map(String);
  }
}
