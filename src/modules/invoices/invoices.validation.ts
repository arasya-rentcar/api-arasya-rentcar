import { z } from "zod";

/**
 * A yes/no flag that may arrive as JSON or as a multipart string. Only an
 * explicit yes counts ("false", "0" and absent are no); z.coerce.boolean()
 * would read the string "false" as true.
 */
const flag = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? fallback : v === true || v === "true" || v === "1" || v === 1),
    z.boolean(),
  );

/** The same flag, but undefined when the client did not send it at all. */
const optionalFlag = () =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? undefined : v === true || v === "true" || v === "1" || v === 1),
    z.boolean().optional(),
  );

export const generateInvoiceSchema = z
  .object({
  invoice_type: z.enum(["DP", "SETTLEMENT", "FULL", "ADDITIONAL", "COMBINED", "ADJUSTMENT"]),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]),
  // The part of the order total this invoice covers (gross). The cash asked
  // (stored as `amount`) is this minus the saldo lebih applied.
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
  // #10: optional issue date (defaults to now). Allows issuing/back-dating an
  // invoice for an order from a previous day.
  issue_date: z.string().datetime().optional(),
  // B8: made by the client when the form opens and reused on a retry; a
  // resend returns the invoice already made (200) instead of a second one.
  // Optional until every dashboard sends it.
  client_ref: z.string().uuid().optional(),
  // Saldo lebih reduces the cash asked by default (owner, 7 Oct 2026); the
  // admin unticks it to keep the credit for a refund.
  apply_credit: flag(true),
  // ADJUSTMENT ("Invoice Penyesuaian"): the paid invoice whose shortfall it bills.
  adjusts_invoice_id: z.string().uuid().optional(),
  })
  .refine((v) => v.invoice_type === "ADJUSTMENT" || v.adjusts_invoice_id === undefined, {
    message: "adjusts_invoice_id hanya untuk invoice ADJUSTMENT",
    path: ["adjusts_invoice_id"],
  })
  .refine((v) => v.invoice_type !== "ADJUSTMENT" || v.adjusts_invoice_id !== undefined, {
    message: "Invoice penyesuaian harus menyebut invoice yang kurang dibayar (adjusts_invoice_id)",
    path: ["adjusts_invoice_id"],
  });

export const reviseInvoiceSchema = z.object({
  // Gross, as on generate (the part of the total the revision covers, before
  // saldo lebih), not the cash asked.
  amount: z.number().positive("Amount must be a positive number"),
  note: z.string().optional(),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
  // B8, as on generate: a resend returns the revision already made.
  client_ref: z.string().uuid().optional(),
  // Absent = true, except on an invoice that used saldo lebih: there the
  // client must say it (reviseInvoice answers 409 otherwise), because an
  // older dashboard sends the cash it shows as `amount`, not the gross.
  apply_credit: optionalFlag(),
});

export const markInvoicePaidSchema = z.object({
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "QRIS", "OTHER"]).optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
  // Sprint 2: actual money received, which may differ from the invoice amount
  // (overpayment). Defaults to the invoice amount when omitted. Coerced because
  // multipart form fields arrive as strings.
  // Whole rupiah, like every amount billed (B12).
  amount_received: z.coerce.number().int("amount_received harus rupiah bulat (tanpa sen)").positive().optional(),
  // Required when amount_received differs from the invoice amount (finance
  // design §3.4): without it the API answers 409 with both numbers and the
  // effect, so a typo ("750.000,00" pasted as 75.000.000) is not recorded.
  amount_mismatch_ack: flag(false),
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
