import { z } from "zod";

export const tripsQuerySchema = z.object({
  scope: z.enum(["active", "history"]).default("active"),
});

// When the driver pressed the button on the phone. Actions queued offline
// are sent later; this keeps the recorded time true to what happened.
const occurredAt = z.string().datetime({ offset: true }).optional();

// Idempotency key from the phone: resending the same action is a no-op.
const clientRef = z.string().uuid().optional();

export const actionSchema = z.object({ occurred_at: occurredAt, client_ref: clientRef });

export const finishSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  occurred_at: occurredAt,
  client_ref: clientRef,
});

export const reportSchema = z.object({
  report_type: z.enum([
    "ODOMETER_START",
    "ODOMETER_END",
    "FUEL",
    "TOLL",
    "PARKING",
    "OTHER_COST",
    "PHOTO",
    "NOTE",
  ]),
  client_ref: z.string().uuid(),
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
  // Rupiah for FUEL/TOLL/PARKING/OTHER_COST, km for ODOMETER_START/END.
  amount: z.coerce.number().int().min(0).max(100_000_000).optional(),
  occurred_at: occurredAt,
});
export type ReportInput = z.infer<typeof reportSchema>;
