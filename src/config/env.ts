import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const isProd = (process.env.NODE_ENV || 'development') === 'production';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),
  SUPABASE_STORAGE_BUCKET: z.string().default('invoices'),
  // Required in production so bot endpoints never run unauthenticated.
  BOT_INTERNAL_TOKEN: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),
  // Trust proxy hops (nginx). Rate limiting + real IP need this set to 1 behind nginx.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  // #A1/#A2 H-1 trip-team confirmation sweep. Local WIB time "HH:MM" (24h).
  // Set CONFIRMATION_SWEEP_ENABLED=false to disable the daily cron entirely.
  CONFIRMATION_SWEEP_TIME: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'CONFIRMATION_SWEEP_TIME must be HH:MM')
    .default('17:00'),
  // Website booking-form leads: origins allowed to POST /api/v1/public/leads.
  PUBLIC_LEAD_ORIGINS: z
    .string()
    .default(
      'https://arasya-web.vercel.app,https://arasyarentcar.com,https://www.arasyarentcar.com,http://localhost:4321',
    ),
  // GA4 Measurement Protocol: report a "purchase" when a website lead's order
  // gets its first payment. Both empty = reporting off.
  GA4_MEASUREMENT_ID: z.string().default(''),
  GA4_API_SECRET: z.string().default(''),
  // Website deploy hook, called after "Terbitkan" on the price list so the
  // site rebuilds with the new prices. Secret (the URL is the credential);
  // empty = off (the publication is still stored, deploy_status SKIPPED).
  WEB_DEPLOY_HOOK_URL: z.string().default(''),
  CONFIRMATION_SWEEP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Driver ON_DUTY / car IN_USE follow the WIB date of their trips: refresh
  // them at startup and every 10 minutes. false = off.
  RESOURCE_STATUS_REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`[env] Invalid environment configuration:\n${issues}`);
  throw new Error('Invalid environment configuration');
}

const data = parsed.data;

// Fail loudly in production if the bot integration token is missing,
// otherwise /api/v1/bot/* would 500 on every call.
if (isProd && !data.BOT_INTERNAL_TOKEN) {
  throw new Error(
    '[env] BOT_INTERNAL_TOKEN must be set in production (bot endpoints require it)',
  );
}

export const env = data;
