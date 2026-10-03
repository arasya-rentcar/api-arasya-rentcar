import { z } from 'zod';

const costType = z.enum(['FUEL', 'TOLL', 'PARKING', 'OTHER'], {
  errorMap: () => ({ message: 'type must be one of: FUEL, TOLL, PARKING, OTHER' }),
});

export const createExpenseSchema = z.object({
  type: costType,
  amount: z.number().positive('Amount must be a positive number').max(100_000_000),
  note: z.string().max(300).optional(),
  // Admin entries (2026-10-03): who paid and whether the customer pays it.
  paid_by: z.enum(['DRIVER', 'COMPANY']).optional(),
  bill_to_customer: z.boolean().optional(),
  // Idempotency key (admin form): a resend after a lost answer is a no-op.
  client_ref: z.string().uuid().optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

/** Admin review / correction of one trip cost. */
export const updateExpenseSchema = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
    paid_by: z.enum(['DRIVER', 'COMPANY']).optional(),
    bill_to_customer: z.boolean().optional(),
    type: costType.optional(),
    amount: z.number().positive().max(100_000_000).optional(),
    note: z.string().max(300).nullable().optional(),
    review_note: z.string().max(300).nullable().optional(),
  })
  .strict();

export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
