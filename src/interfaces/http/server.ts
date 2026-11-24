import { createServer } from 'node:http';
import { ConfigError } from '../../config/ConfigError';

/**
 * نقطة التشغيل. تحمّل التطبيق الفعلي (main.ts) داخل try/catch:
 * إن فشل الإقلاع (إعداد ناقص، وحدة مفقودة…) يبقى الخادم يجيب برسالة JSON توضّح السبب
 * بدل أن تموت العملية ويرى المستخدم 503 بلا تفسير. لا تُعرَض إلا أسماء الإعدادات لا قيمها.
 */
try {
  require('./main');
} catch (err) {
  const isConfig = err instanceof ConfigError;
  // السطر الأول فقط: بقية رسالة require تكشف مسارات الخادم
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0];
  // eslint-disable-next-line no-console
  console.error('FATAL: server failed to start:', message);

  const body = JSON.stringify({
    success: false,
    error: {
      code: isConfig ? 'INVALID_CONFIGURATION' : 'STARTUP_FAILED',
      message: isConfig ? 'Server configuration is invalid. Fix the listed environment variables and restart.' : message,
      details: isConfig ? (err as ConfigError).details : undefined,
    },
  });

  const raw = process.env.PORT ?? '4000';
  const target: number | string = /^\d+$/.test(raw) ? Number(raw) : raw;

  createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(body);
  }).listen(target as never, () => {
    // eslint-disable-next-line no-console
    console.error('Diagnostic server listening on', target);
  });
}
