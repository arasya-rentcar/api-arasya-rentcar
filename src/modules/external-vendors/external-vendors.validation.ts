import { z } from 'zod';

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export const createVendorCarSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  plate_number: z.string().optional(),
  notes: z.string().optional(),
});

export const updateVendorCarSchema = z.object({
  model: z.string().min(1).optional(),
  plate_number: z.string().optional(),
  notes: z.string().optional(),
});

export const listVendorsQuerySchema = z.object({
  search: z.string().optional(),
  sort: z.enum(['order_count', 'name', 'created_at']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(200).optional(),
});

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type CreateVendorCarInput = z.infer<typeof createVendorCarSchema>;
export type UpdateVendorCarInput = z.infer<typeof updateVendorCarSchema>;
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>;
