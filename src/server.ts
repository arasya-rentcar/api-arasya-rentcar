import './config/env'; // load env first
import app from './app';
import { env } from './config/env';

const server = app.listen(env.PORT, () => {
  console.log(`[server] ARASYA RENTCAR API running on port ${env.PORT}`);
  console.log(`[server] Environment: ${env.NODE_ENV}`);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received. Shutting down gracefully.');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled Rejection:', reason);
  server.close(() => process.exit(1));
});
