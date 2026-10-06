import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { logger } from './config/logger';
import { globalLimiter, authLimiter, botLimiter, notificationsLimiter } from './middleware/rateLimit.middleware';

import authRoutes from './modules/auth/auth.route';
import usersRoutes from './modules/users/users.route';
import driversRoutes from './modules/drivers/drivers.route';
import carsRoutes from './modules/cars/cars.route';
import ordersRoutes from './modules/orders/orders.route';
import invoicesRoutes from './modules/invoices/invoices.route';
import expensesRoutes from './modules/expenses/expenses.route';
import botRoutes from './modules/bot/bot.route';
import finalOrdersRoutes from './modules/final-orders/final-orders.route';
import sheetImportsRoutes from './modules/sheet-imports/sheet-imports.route';
import customersRoutes from './modules/customers/customers.route';
import externalVendorsRoutes from './modules/external-vendors/external-vendors.route';
import scheduleRoutes from './modules/schedule/schedule.route';
import payablesRoutes from './modules/payables/payables.route';
import analyticsRoutes from './modules/analytics/analytics.route';
import leadsRoutes, { publicLeadsRouter } from './modules/leads/leads.route';
import devicesRoutes from './modules/devices/devices.route';
import driverAppRoutes from './modules/driver-app/driver-app.route';
import driverRequestsRoutes from './modules/driver-requests/driver-requests.route';
import etollCardsRoutes from './modules/etoll-cards/etoll-cards.route';
import adminNotificationsRoutes from './modules/admin-notifications/admin-notifications.route';
import pricesRoutes, { publicPricesRouter } from './modules/prices/prices.route';

import { errorMiddleware } from './middleware/error.middleware';

const app = express();

// Behind nginx: trust the proxy so req.ip and rate limiting use the real client IP.
app.set('trust proxy', env.TRUST_PROXY);

// Security headers.
app.use(helmet());

// Public, unauthenticated: the website's booking form. Registered before the
// dashboard CORS policy because it has its own allowed origins.
app.use('/api/v1/public/leads', publicLeadsRouter);
// Public, read-only: the published price list for the website (same origins).
app.use('/api/v1/public/prices', publicPricesRouter);

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  allowedOrigins.push(
    'https://dashboard.haikuy.com',
    'https://management.arasyarentcar.com',
    'http://localhost:3000'
  );
}

app.use(cors({
  origin: function (origin, callback) {

    // allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.options("/*", cors());

app.use(express.json({ limit: '10mb' }));

// Structured request logging (replaces ad-hoc console.log).
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'arasya-rentcar-api' });
});

// Admin notification bell: polled by every dashboard tab, so it is registered
// before the global limiter with a budget of its own.
app.use('/api/v1/notifications', notificationsLimiter, adminNotificationsRoutes);

// Global rate limit on the API surface (/health is registered above and excluded).
app.use('/api/', globalLimiter);

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/drivers', driversRoutes);
app.use('/api/v1/cars', carsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/invoices', invoicesRoutes);
app.use('/api/v1/final-orders', finalOrdersRoutes);
app.use('/api/v1/sheet-imports', sheetImportsRoutes);
app.use('/api/v1/customers', customersRoutes);
app.use('/api/v1/external-vendors', externalVendorsRoutes);
app.use('/api/v1/schedule', scheduleRoutes);
app.use('/api/v1/payables', payablesRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/leads', leadsRoutes);
app.use('/api/v1/devices', devicesRoutes);
app.use('/api/v1/driver', driverAppRoutes);
// Admin side of driver requests (e-toll top-up); the driver side is /driver/requests.
app.use('/api/v1/driver-requests', driverRequestsRoutes);
// Office e-toll cards (pool, handovers, history); the driver side is /driver/etoll-cards.
app.use('/api/v1/etoll-cards', etollCardsRoutes);
// Official price list (working copy + publishing); the website reads /public/prices.
app.use('/api/v1/prices', pricesRoutes);
// Merge: expenses now hang off service-day lines (the line IS the trip).
app.use('/api/v1/lines', expensesRoutes);
app.use('/api/v1/bot', botLimiter, botRoutes);

app.use(errorMiddleware);

export default app;
