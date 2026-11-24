import { describe, expect, it } from 'vitest';
import { describeDbError, mask } from '../src/interfaces/http/dbDiagnostics';

const env = { DB_HOST: 'srv1234.hstgr.io', DB_PORT: 3306, DB_DATABASE: 'u123456789_erp', DB_USERNAME: 'u123456789_mobile', DB_PASSWORD: 'super-secret' };

describe('describeDbError', () => {
  it("reports the address MySQL saw and never leaks the password or full username", () => {
    const out = describeDbError(
      { code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'u123456789_mobile'@'77.37.50.43' (using password: YES)" },
      env,
    );
    expect(out.dbCode).toBe('ER_ACCESS_DENIED_ERROR');
    expect(out.mysqlSaw).toEqual({ username: 'u123***', fromHost: '77.37.50.43', usingPassword: 'YES' });
    expect(out.configured).toMatchObject({ username: 'u123***', passwordProvided: true, port: 3306 });
    const json = JSON.stringify(out);
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain('u123456789_mobile');
  });

  it('detects "not using a password"', () => {
    const out = describeDbError({ code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'x'@'1.2.3.4' (using password: NO)" }, { ...env, DB_PASSWORD: '' });
    expect(out.mysqlSaw?.usingPassword).toBe('NO');
    expect(out.configured.passwordProvided).toBe(false);
  });

  it('maps connection errors', () => {
    expect(describeDbError({ code: 'ECONNREFUSED', message: 'x' }, env).hint).toContain('Remote MySQL');
    expect(describeDbError({ code: 'SQLITE_ERROR', message: 'no such table: users' }, env).dbCode).toBe('ER_NO_SUCH_TABLE');
  });

  it('masks short values completely', () => {
    expect(mask('abc')).toBe('***');
    expect(mask('')).toBe('(empty)');
  });
});
