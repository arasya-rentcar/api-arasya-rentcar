import { z } from 'zod';

export const createDriverSchema = z.object({
  user_id: z.string().uuid('Invalid user_id format'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
});

export const updateDriverSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  status: z.enum(['AVAILABLE', 'ON_DUTY', 'OFF']).optional(),
});

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
