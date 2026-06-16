import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { logger } from './config/logger';
import { globalLimiter, authLimiter, botLimiter } from './middleware/rateLimit.middleware';

import authRoutes from './modules/auth/auth.route';
import usersRoutes from './modules/users/users.route';
import driversRoutes from './modules/drivers/drivers.route';
import carsRoutes from './modules/cars/cars.route';
import ordersRoutes from './modules/orders/orders.route';
import tripsRoutes from './modules/trips/trips.route';
import botRoutes from './modules/bot/bot.route';
import finalOrdersRoutes from './modules/final-orders/final-orders.route';
import sheetImportsRoutes from './modules/sheet-imports/sheet-imports.route';

import { errorMiddleware } from './middleware/error.middleware';

const app = express();

// Behind nginx: trust the proxy so req.ip and rate limiting use the real client IP.
app.set('trust proxy', env.TRUST_PROXY);

// Security headers.
app.use(helmet());

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

// Global rate limit on the API surface (/health is registered above and excluded).
app.use('/api/', globalLimiter);

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/drivers', driversRoutes);
app.use('/api/v1/cars', carsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/final-orders', finalOrdersRoutes);
app.use('/api/v1/sheet-imports', sheetImportsRoutes);
app.use('/api/v1/trips', tripsRoutes);
app.use('/api/v1/bot', botLimiter, botRoutes);

app.use(errorMiddleware);

export default app;
