/**
 * تحليل أخطاء الاتصال بقاعدة البيانات لنقطة /health/db.
 * لا يُرجع كلمة المرور ولا اسم المستخدم كاملاً: أوّل حروف فقط للمطابقة مع ما أُدخل في لوحة الاستضافة.
 */

const HINTS: Record<string, string> = {
  ER_ACCESS_DENIED_ERROR: 'Wrong DB_USERNAME / DB_PASSWORD, or this MySQL user is not allowed from the app server (enable Remote MySQL for the app IP).',
  ER_DBACCESS_DENIED_ERROR: 'The MySQL user has no permission on DB_DATABASE.',
  ER_BAD_DB_ERROR: 'DB_DATABASE does not exist on that server.',
  ECONNREFUSED: 'Cannot connect to DB_HOST:DB_PORT. localhost only works from the ERP itself: use the real MySQL host and allow this app in Remote MySQL.',
  ETIMEDOUT: 'Timed out reaching DB_HOST:DB_PORT. The MySQL host blocks this app (Remote MySQL / firewall) or the host or port is wrong.',
  EHOSTUNREACH: 'DB_HOST is not reachable from the app server.',
  ENOTFOUND: 'DB_HOST is not a known host name.',
  ER_NO_SUCH_TABLE: 'Connected, but the ERP tables were not found: DB_DATABASE is not the ERP database.',
};

export function mask(value: string | undefined): string {
  if (!value) return '(empty)';
  return value.length <= 4 ? '***' : `${value.slice(0, 4)}***`;
}

export interface DbEnv {
  DB_HOST: string;
  DB_PORT: number;
  DB_DATABASE: string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
}

export function describeDbError(e: unknown, env: DbEnv) {
  const err = e as { code?: string; message?: string };
  const message = err.message ?? '';
  const code = /no such table|doesn't exist/i.test(message) ? 'ER_NO_SUCH_TABLE' : String(err.code ?? 'UNKNOWN');

  // "Access denied for user 'u123_x'@'77.37.50.43' (using password: YES)"
  const denied = /Access denied for user '([^']*)'@'([^']*)'(?: \(using password: (YES|NO)\))?/i.exec(message);

  return {
    code: 'DATABASE_UNAVAILABLE',
    dbCode: code,
    hint: HINTS[code] ?? 'Check the DB_* environment variables.',
    // ما تراه هذه الخدمة من إعداداتها (مقنَّعاً) — للمطابقة مع لوحة الاستضافة
    configured: {
      host: mask(env.DB_HOST),
      port: env.DB_PORT,
      database: mask(env.DB_DATABASE),
      username: mask(env.DB_USERNAME),
      passwordProvided: env.DB_PASSWORD.length > 0,
    },
    // ما ردّ به MySQL: عنوان هذا التطبيق كما رآه — هو ما يجب السماح به في Remote MySQL
    mysqlSaw: denied ? { username: mask(denied[1]), fromHost: denied[2], usingPassword: denied[3] ?? null } : undefined,
  };
}
