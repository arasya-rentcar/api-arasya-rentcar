import { z } from 'zod';

export const generateInvoiceSchema = z.object({
  invoice_type: z.enum(['DP', 'SETTLEMENT', 'FULL']),
  payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'QRIS', 'OTHER']),
  amount: z.number().positive('Amount must be a positive number'),
  note: z.string().optional(),
});

export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;
