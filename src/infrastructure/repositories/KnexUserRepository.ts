import { Knex } from 'knex';
import { User } from '../../domain/entities';
import { UserRepository } from '../../domain/repositories';
import { parseDate, sqlNow } from '../db/knex';

const COLUMNS = ['id', 'name', 'email', 'phone', 'password', 'role', 'role_id', 'employee_id', 'branch_id', 'client_id', 'avatar', 'last_login_at'];

function map(row: Record<string, unknown>): User {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    phone: (row.phone as string | null) ?? null,
    passwordHash: String(row.password ?? ''),
    role: (row.role as string | null) ?? null,
    roleId: row.role_id === null || row.role_id === undefined ? null : Number(row.role_id),
    employeeId: row.employee_id === null || row.employee_id === undefined ? null : Number(row.employee_id),
    branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    clientId: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    avatar: (row.avatar as string | null) ?? null,
    lastLoginAt: parseDate(row.last_login_at),
  };
}

export class KnexUserRepository implements UserRepository {
  constructor(private readonly db: Knex) {}

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db('users').select(COLUMNS).whereRaw('LOWER(email) = ?', [email]).first();
    return row ? map(row) : null;
  }

  async findById(id: number): Promise<User | null> {
    const row = await this.db('users').select(COLUMNS).where('id', id).first();
    return row ? map(row) : null;
  }

  async recordLogin(id: number, ip: string | null): Promise<void> {
    await this.db('users').where('id', id).update({ last_login_at: sqlNow(), last_login_ip: ip, updated_at: sqlNow() });
  }

  async updateProfile(id: number, data: { name?: string; phone?: string | null }): Promise<void> {
    const patch: Record<string, unknown> = { updated_at: sqlNow() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.phone !== undefined) patch.phone = data.phone;
    await this.db('users').where('id', id).update(patch);
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.db('users').where('id', id).update({ password: passwordHash, remember_token: null, updated_at: sqlNow() });
  }

  async updateAvatar(id: number, avatarPath: string): Promise<void> {
    await this.db('users').where('id', id).update({ avatar: avatarPath, updated_at: sqlNow() });
  }

  async idsByBranchIds(branchIds: number[]): Promise<number[]> {
    if (branchIds.length === 0) return [];
    const rows = await this.db('users').whereIn('branch_id', branchIds).pluck('id');
    return rows.map(Number);
  }

  async idsByEmployeeIds(employeeIds: number[]): Promise<number[]> {
    if (employeeIds.length === 0) return [];
    const rows = await this.db('users').whereIn('employee_id', employeeIds).pluck('id');
    return rows.map(Number);
  }

  async updateBranch(id: number, branchId: number | null): Promise<void> {
    await this.db('users').where('id', id).update({ branch_id: branchId, updated_at: sqlNow() });
  }
}
