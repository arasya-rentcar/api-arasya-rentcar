import './config/env'; // load + validate env first
import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { startConfirmationScheduler } from './modules/confirmation/confirmation.scheduler';
import { startResourceStatusRefresh } from './modules/schedule/resource-status.scheduler';

const server = app.listen(env.PORT, () => {
  logger.info(`ARASYA RENTCAR API running on port ${env.PORT} (${env.NODE_ENV})`);
  // #A1/#A2 H-1 trip-team confirmation sweep (config-driven WIB time).
  startConfirmationScheduler();
  // Driver ON_DUTY / car IN_USE follow the date of their trips.
  startResourceStatusRefresh();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully.');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
  server.close(() => process.exit(1));
});
