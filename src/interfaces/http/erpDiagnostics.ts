/**
 * تشخيص الاتصال بنظام الإدارة (Laravel) لنقطة /health/erp — لماذا يظهر «تعذّر الاتصال بنظام الإدارة».
 * يعرض اسم النطاق فقط (عنوان النظام عامٌّ أصلاً)، ولا رموز ولا مفاتيح.
 */

const HINTS: Record<string, string> = {
  NOT_CONFIGURED: 'ERP_PUBLIC_URL (or ERP_API_URL) is not set, so the app tries http://127.0.0.1:8000. Set ERP_PUBLIC_URL=https://<ERP domain> in the host environment variables and restart.',
  ECONNREFUSED: 'The ERP address refused the connection: wrong host or port, or nothing is listening there.',
  ENOTFOUND: 'The ERP host name does not resolve. Check the spelling of ERP_PUBLIC_URL / ERP_API_URL.',
  EAI_AGAIN: 'DNS lookup of the ERP host failed temporarily on the app server.',
  ETIMEDOUT: 'Timed out reaching the ERP: a firewall blocks the app server, or the host is wrong.',
  TIMEOUT: 'The ERP did not answer in time.',
  ECONNRESET: 'The ERP closed the connection (often a firewall / WAF blocking server-to-server requests).',
  CERT: 'TLS certificate problem on the ERP domain. Use its valid https domain (not an IP) or fix the certificate.',
};

export interface ErpProbe {
  success: boolean;
  url: string;
  host: string;
  configured: boolean;
  status?: number;
  code?: string;
  hint?: string;
}

export function errorCodeOf(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === 'AbortError') return 'TIMEOUT';
  const code = err?.cause?.code ?? err?.code ?? 'UNKNOWN';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'CERT';
  return code;
}

export function hintFor(code: string): string {
  return HINTS[code] ?? 'The app server could not reach the ERP. Check ERP_PUBLIC_URL / ERP_API_URL and that the ERP domain is reachable from the app server.';
}

/** طلبٌ بلا رمزٍ إلى مسار الجسر: أيّ ردٍّ HTTP (ولو 401) يعني أن الشبكة سليمة */
export async function probeErp(baseUrl: string, configured: boolean, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ErpProbe> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/mobile/accounting/forms/expenses/options`;
  let host = '(invalid)';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return { success: false, url: baseUrl, host, configured, code: 'INVALID_URL', hint: 'ERP_API_URL / ERP_PUBLIC_URL is not a valid URL.' };
  }
  if (!configured) return { success: false, url: baseUrl, host, configured, code: 'NOT_CONFIGURED', hint: hintFor('NOT_CONFIGURED') };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    return { success: true, url: baseUrl, host, configured, status: res.status };
  } catch (e) {
    const code = errorCodeOf(e);
    return { success: false, url: baseUrl, host, configured, code, hint: hintFor(code) };
  } finally {
    clearTimeout(timer);
  }
}
