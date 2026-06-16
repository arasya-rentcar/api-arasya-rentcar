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
