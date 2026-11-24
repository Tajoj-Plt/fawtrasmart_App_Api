import { describe, expect, it } from 'vitest';
import { errorCodeOf, probeErp } from '../src/interfaces/http/erpDiagnostics';

const response = (status: number) => ({ status }) as Response;

describe('probeErp', () => {
  it('treats any HTTP answer (even 401 without a token) as reachable', async () => {
    const probe = await probeErp('https://erp.example.com', true, (async () => response(401)) as unknown as typeof fetch);
    expect(probe).toMatchObject({ success: true, host: 'erp.example.com', status: 401 });
  });

  it('reports the network cause of a failed request', async () => {
    const fail = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const probe = await probeErp('https://erp.example.com', true, fail);
    expect(probe).toMatchObject({ success: false, code: 'ENOTFOUND' });
    expect(probe.hint).toContain('does not resolve');
  });

  it('says so when no ERP address is configured (default 127.0.0.1:8000)', async () => {
    const probe = await probeErp('http://127.0.0.1:8000', false);
    expect(probe).toMatchObject({ success: false, code: 'NOT_CONFIGURED' });
  });
});

describe('errorCodeOf', () => {
  it('maps abort, certificate and plain codes', () => {
    expect(errorCodeOf({ name: 'AbortError' })).toBe('TIMEOUT');
    expect(errorCodeOf({ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })).toBe('CERT');
    expect(errorCodeOf({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
  });
});
