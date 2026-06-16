import './config/env'; // load + validate env first
import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';

const server = app.listen(env.PORT, () => {
  logger.info(`ARASYA RENTCAR API running on port ${env.PORT} (${env.NODE_ENV})`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully.');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
  server.close(() => process.exit(1));
});
