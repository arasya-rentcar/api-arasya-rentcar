import { z } from 'zod';

export const createDriverSchema = z.object({
  user_id: z.string().uuid('Invalid user_id format'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  type: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  location: z.string().optional(),
});

export const updateDriverSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  type: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
  location: z.string().optional(),
  status: z.enum(['AVAILABLE', 'ON_DUTY', 'OFF']).optional(),
});

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
