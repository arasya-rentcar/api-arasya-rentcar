import rateLimit from 'express-rate-limit';

// Global limiter: generous, protects against runaway clients / scraping.
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' },
});

// Auth limiter: tight, protects /auth/login from brute force.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Count only failed attempts toward the limit.
  skipSuccessfulRequests: true,
  message: {
    status: 'error',
    message: 'Too many login attempts, please try again in a few minutes.',
  },
});

// Public lead intake (website booking form): a person sends a few at most.
export const publicLeadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' },
});

// Bot limiter: moderate; bot is a single trusted client but bursty.
export const botLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Bot request rate exceeded.' },
});
