import { z } from "zod";

export const generateInvoiceSchema = z.object({
  invoice_type: z.enum(["DP", "SETTLEMENT", "FULL", "ADDITIONAL", "COMBINED"]),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]),
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
});

export const reviseInvoiceSchema = z.object({
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
});

export const markInvoicePaidSchema = z.object({
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
  paid_at: z.string().optional(),
});

export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;
export type ReviseInvoiceInput = z.infer<typeof reviseInvoiceSchema>;
export type MarkInvoicePaidInput = z.infer<typeof markInvoicePaidSchema>;

export const sendInvoiceWhatsappSchema = z.object({
  target_name: z.string().optional(),
  target_phone: z.string().min(1, "Target phone is required"),
  message_note: z.string().optional(),
});

export type SendInvoiceWhatsappInput = z.infer<
  typeof sendInvoiceWhatsappSchema
>;
