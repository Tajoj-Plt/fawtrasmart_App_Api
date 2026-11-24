import pino from 'pino';
import { env, isProduction } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isProduction
    ? {}
    : { transport: undefined }),
  base: { service: 'fawtrasmart-backend' },
  redact: ['req.headers.authorization', 'req.body.password', 'req.body.currentPassword', 'req.body.newPassword'],
});
