import pino from 'pino';
import { env } from './env';

const isProd = env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  // Pretty output in dev only; JSON in prod for log aggregation.
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-bot-token"]',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
});
