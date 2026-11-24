import { afterEach, describe, expect, it, vi } from 'vitest';

const base = { JWT_SECRET: 'a-long-enough-secret-123456', DB_CLIENT: 'mysql2' };

async function load(env: Record<string, string>) {
  vi.resetModules();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, base, env);
  try {
    return (await import('../src/config/env')).env;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

afterEach(() => vi.resetModules());

describe('env parsing is forgiving about hosting-panel mistakes', () => {
  it.each(['production', ' production ', '"production"', "'Production'", 'PRODUCTION', 'prod'])('accepts NODE_ENV=%s', async (value) => {
    expect((await load({ NODE_ENV: value })).NODE_ENV).toBe('production');
  });

  it('still rejects an unknown NODE_ENV', async () => {
    await expect(load({ NODE_ENV: 'staging' })).rejects.toThrow('NODE_ENV');
  });

  it('adds https:// to ERP_API_URL too (a bare domain made every bridge call fail as unreachable)', async () => {
    expect((await load({ ERP_API_URL: 'fawtrasmart.com/' })).ERP_API_URL).toBe('https://fawtrasmart.com');
    expect((await load({ ERP_API_URL: '' })).ERP_API_URL).toBeUndefined();
    expect((await load({ ERP_MEDIA_URL: '' })).ERP_MEDIA_URL).toBeUndefined();
  });

  it('adds https:// to ERP_PUBLIC_URL when missing and strips the trailing slash', async () => {
    expect((await load({ ERP_PUBLIC_URL: 'erp.example.com/' })).ERP_PUBLIC_URL).toBe('https://erp.example.com');
  });

  it('requires JWT_SECRET', async () => {
    await expect(load({ JWT_SECRET: '' })).rejects.toThrow('JWT_SECRET');
  });
});
