import { z } from "zod";

export const tripsQuerySchema = z.object({
  scope: z.enum(["active", "history"]).default("active"),
});

export const finishSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
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
  amount: z.coerce.number().int().min(0).max(100_000_000).optional(),
});
export type ReportInput = z.infer<typeof reportSchema>;
