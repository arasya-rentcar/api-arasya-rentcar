import { z } from "zod";

export const generateInvoiceSchema = z.object({
  invoice_type: z.enum(["DP", "SETTLEMENT", "FULL", "ADDITIONAL", "COMBINED"]),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]),
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
  // #10: optional issue date (defaults to now). Allows issuing/back-dating an
  // invoice for an order from a previous day.
  issue_date: z.string().datetime().optional(),
  // B8: made by the client when the form opens and reused on a retry; a
  // resend returns the invoice already made (200) instead of a second one.
  // Optional until every dashboard sends it.
  client_ref: z.string().uuid().optional(),
});

export const reviseInvoiceSchema = z.object({
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
  // B8, as on generate: a resend returns the revision already made.
  client_ref: z.string().uuid().optional(),
});

export const markInvoicePaidSchema = z.object({
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
  // Sprint 2: actual money received, which may differ from the invoice amount
  // (overpayment). Defaults to the invoice amount when omitted. Coerced because
  // multipart form fields arrive as strings.
  amount_received: z.coerce.number().positive().optional(),
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

// Send the kwitansi/receipt PDF to the customer over WhatsApp. Same shape as
// the invoice send (recipient + optional admin note); the receipt PDF + caption
// are resolved server-side from the (PAID) invoice.
export const sendReceiptWhatsappSchema = z.object({
  target_name: z.string().optional(),
  target_phone: z.string().min(1, "Target phone is required"),
  message_note: z.string().optional(),
});

export type SendReceiptWhatsappInput = z.infer<
  typeof sendReceiptWhatsappSchema
>;
