import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '../../config/env';
import { Container } from '../../container';
import { logger } from '../../infrastructure/logger';
import { errorHandler, notFound } from './middlewares/errorHandler';
import { apiLimiter } from './middlewares/rateLimit';
import { buildRouter } from './routes';

export function createApp(container: Container) {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim()) }));
  // 4MB: توقيعات الزيارة تصل base64 داخل JSON (حتى 3MB كما يقبلها الويب)
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false } }));

  app.use('/api/v1', apiLimiter, buildRouter(container));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
