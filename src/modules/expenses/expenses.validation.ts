import { z } from 'zod';

export const createExpenseSchema = z.object({
  type: z.enum(['FUEL', 'TOLL', 'PARKING', 'OTHER'], {
    errorMap: () => ({ message: 'type must be one of: FUEL, TOLL, PARKING, OTHER' }),
  }),
  amount: z.number().positive('Amount must be a positive number'),
  note: z.string().optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
