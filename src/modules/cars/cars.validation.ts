import { z } from 'zod';

export const createCarSchema = z.object({
  plate_number: z.string().min(1, 'Plate number is required'),
  unit_code: z.string().optional(),
  model: z.string().min(1, 'Model is required'),
  type: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  origin_location: z.string().optional(),
});

export const updateCarSchema = z.object({
  plate_number: z.string().min(1).optional(),
  unit_code: z.string().optional(),
  model: z.string().min(1).optional(),
  type: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
  origin_location: z.string().optional(),
  status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE']).optional(),
});

export type CreateCarInput = z.infer<typeof createCarSchema>;
export type UpdateCarInput = z.infer<typeof updateCarSchema>;
