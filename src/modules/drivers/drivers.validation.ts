import { z } from 'zod';

export const createDriverSchema = z.object({
  user_id: z.string().uuid('Invalid user_id format'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  type: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  location: z.string().optional(),
  // E-toll card the driver carries, e.g. "Mandiri 6032 ••••1234".
  etoll_card: z.string().trim().max(60).nullish(),
});

export const updateDriverSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  type: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
  location: z.string().optional(),
  status: z.enum(['AVAILABLE', 'ON_DUTY', 'OFF']).optional(),
  // Empty or null clears it.
  etoll_card: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
});

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;

export const setAppPasswordSchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
});
