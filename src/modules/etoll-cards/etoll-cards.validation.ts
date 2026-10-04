import { z } from "zod";

// Empty form fields mean "not sent".
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const rupiah = z.coerce.number().min(0).max(100_000_000);
const optionalRupiah = z.preprocess(blank, rupiah.optional());
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || undefined);
// When it happened on the phone (offline actions are sent later).
const occurredAt = z.string().datetime({ offset: true }).optional();

export const ISSUERS = ["MANDIRI", "BCA", "BRI", "BNI", "DKI", "OTHER"] as const;

// "6032 9800 1234 5678" or "6032-9800-…": stored as digits only.
const cardNumber = z
  .string()
  .transform((s) => s.replace(/[\s.-]/g, ""))
  .pipe(z.string().regex(/^\d{8,20}$/, "Nomor kartu harus 8–20 angka"));

export const createCardSchema = z.object({
  issuer: z.enum(ISSUERS),
  name: z.string().trim().min(1, "Nama kartu wajib diisi").max(40),
  card_number: cardNumber,
  // Balance on the card now, when known: the first balance check.
  balance: optionalRupiah,
  note: optionalText(300),
});
export type CreateCardInput = z.infer<typeof createCardSchema>;

export const updateCardSchema = z.object({
  issuer: z.enum(ISSUERS).optional(),
  name: z.string().trim().min(1).max(40).optional(),
  card_number: cardNumber.optional(),
  // Empty or null clears it.
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  // Why it is no longer used, e.g. "Hilang", "Rusak", "Diganti".
  inactive_reason: optionalText(100),
});
export type UpdateCardInput = z.infer<typeof updateCardSchema>;

export const listCardsQuerySchema = z.object({
  status: z.preprocess(
    (v) => (typeof v === "string" ? v.toUpperCase() : v),
    z.enum(["ACTIVE", "INACTIVE", "ALL"]).default("ALL"),
  ),
});

/** Admin records a top-up, a toll or a balance it read (e.g. from m-banking). */
export const addTransactionSchema = z
  .object({
    type: z.enum(["TOPUP", "TOLL", "BALANCE_CHECK"]),
    amount: optionalRupiah,
    balance_after: optionalRupiah,
    occurred_at: occurredAt,
    driver_id: z.preprocess(blank, z.string().uuid().optional()),
    note: optionalText(300),
    client_ref: z.preprocess(blank, z.string().uuid().optional()),
  })
  .refine((v) => v.type === "BALANCE_CHECK" || (v.amount != null && v.amount > 0), {
    message: "Nominal wajib diisi",
    path: ["amount"],
  })
  .refine((v) => v.type !== "BALANCE_CHECK" || v.balance_after != null, {
    message: "Saldo wajib diisi",
    path: ["balance_after"],
  });
export type AddTransactionInput = z.infer<typeof addTransactionSchema>;

export const voidTransactionSchema = z.object({ reason: optionalText(200) });

/** Admin: the card went with a driver (or came back to the office). */
export const giveCardSchema = z.object({
  driver_id: z.string().uuid(),
  service_item_id: z.preprocess(blank, z.string().uuid().optional()),
  balance: optionalRupiah,
});
export const returnCardSchema = z.object({ balance: optionalRupiah });

// ── Driver app ──────────────────────────────────────────────────────────────
const source = z.enum(["MANUAL", "NFC"]).default("MANUAL");

/** "Ambil kartu": client_ref makes a resend a no-op. */
export const driverTakeSchema = z.object({
  client_ref: z.string().uuid(),
  occurred_at: occurredAt,
  balance: optionalRupiah,
  // The trip the card is taken for, when the driver took it from a trip.
  trip_id: z.preprocess(blank, z.string().uuid().optional()),
  source,
});
export const driverReturnSchema = z.object({
  client_ref: z.string().uuid(),
  occurred_at: occurredAt,
  balance: optionalRupiah,
  source,
});
/** "Catat sisa saldo": the balance the driver read on the card. */
export const driverBalanceSchema = z.object({
  client_ref: z.string().uuid(),
  occurred_at: occurredAt,
  balance: rupiah,
  source,
});
