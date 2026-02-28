import { z } from 'zod';

export const createCarSchema = z.object({
  plate_number: z.string().min(1, 'Plate number is required'),
  model: z.string().min(1, 'Model is required'),
});

export const updateCarSchema = z.object({
  plate_number: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE']).optional(),
});

export type CreateCarInput = z.infer<typeof createCarSchema>;
export type UpdateCarInput = z.infer<typeof updateCarSchema>;
