import { z } from "zod";

export const tripsQuerySchema = z.object({
  scope: z.enum(["active", "history"]).default("active"),
});

// When the driver pressed the button on the phone. Actions queued offline
// are sent later; this keeps the recorded time true to what happened.
const occurredAt = z.string().datetime({ offset: true }).optional();

// Idempotency key from the phone: resending the same action is a no-op.
const clientRef = z.string().uuid().optional();

// Multipart fields arrive as strings; an empty field means "not sent".
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const num = (min: number, max: number) =>
  z.preprocess(blank, z.coerce.number().min(min).max(max).optional());

// GPS fix from the phone (arrival photo, "sampai di lokasi jemput").
const locationFields = {
  latitude: num(-90, 90),
  longitude: num(-180, 180),
  location_accuracy_m: num(0, 1_000_000).transform((v) => (v == null ? v : Math.round(v))),
  location_at: occurredAt,
  // Android: the fix came from a mock-location app.
  location_mocked: z.preprocess(
    (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : undefined),
    z.boolean().optional(),
  ),
};
const bothOrNone = (v: { latitude?: number; longitude?: number }) =>
  (v.latitude == null) === (v.longitude == null);

export const actionSchema = z
  .object({ occurred_at: occurredAt, client_ref: clientRef, ...locationFields })
  .refine(bothOrNone, { message: "latitude and longitude go together", path: ["longitude"] });
export type ActionInput = z.infer<typeof actionSchema>;

export const finishSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  occurred_at: occurredAt,
  client_ref: clientRef,
});

export const reportSchema = z
  .object({
    report_type: z.enum([
      "ODOMETER_START",
      "ODOMETER_END",
      "FUEL",
      "TOLL",
      "PARKING",
      "OTHER_COST",
      "PHOTO",
      "NOTE",
      // Photo taken at the pickup point, stamped with driver, time and GPS.
      "ARRIVAL_PHOTO",
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
    ...locationFields,
  })
  .refine(bothOrNone, { message: "latitude and longitude go together", path: ["longitude"] });
export type ReportInput = z.infer<typeof reportSchema>;

export const notificationsQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const readNotificationsSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all || (v.ids && v.ids.length > 0), { message: "ids or all is required" });
