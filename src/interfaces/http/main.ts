import { env, listenTarget } from '../../config/env';
import { buildContainer } from '../../container';
import { logger } from '../../infrastructure/logger';
import { createApp } from './app';

process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

const container = buildContainer();
const app = createApp(container);

const onListening = () => {
  logger.info({ listen: listenTarget, db: env.DB_CLIENT, node: process.version, env: env.NODE_ENV }, 'FawtraSmart mobile API listening');
};

const server = typeof listenTarget === 'number' ? app.listen(listenTarget, onListening) : app.listen(listenTarget, onListening);

server.on('error', (err) => {
  logger.fatal({ err, listen: listenTarget }, 'server failed to listen');
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await container.db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
