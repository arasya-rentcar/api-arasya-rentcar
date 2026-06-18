import { z } from 'zod';

export const listPayablesQuerySchema = z.object({
  kind: z.enum(['DRIVER', 'VENDOR']).optional(),
  status: z.enum(['UNPAID', 'PAID']).optional(),
  driver_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
});
export type ListPayablesQuery = z.infer<typeof listPayablesQuerySchema>;

export const payableExtraSchema = z.object({
  label: z.string().min(1),
  amount: z.number(),
});

export const updatePayableSchema = z
  .object({
    base_amount: z.number().optional(),
    extras: z.array(payableExtraSchema).optional(),
    keterangan: z.string().nullable().optional(),
  })
  .strict();
export type UpdatePayableInput = z.infer<typeof updatePayableSchema>;

export const markPayablePaidSchema = z
  .object({
    paid_at: z.string().optional(),
    payment_method: z
      .enum(['CASH', 'BANK_TRANSFER', 'QRIS', 'OTHER'])
      .optional(),
  })
  .strict();
export type MarkPayablePaidInput = z.infer<typeof markPayablePaidSchema>;

export const bulkMarkPaidSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1),
    paid_at: z.string().optional(),
  })
  .strict();
export type BulkMarkPaidInput = z.infer<typeof bulkMarkPaidSchema>;
