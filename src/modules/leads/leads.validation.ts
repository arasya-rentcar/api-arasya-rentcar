import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** What the website's booking form sends (see arasya-web BookingBar). */
export const publicLeadSchema = z.object({
  lead_code: z.string().regex(/^ARS-[A-Z2-9]{5}$/, "invalid lead_code"),
  name: z.string().trim().min(1).max(120),
  trip_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  pickup_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  pickup_location: z.string().trim().min(1).max(300),
  destination: text(300),
  unit: text(120),
  passenger_count: z.coerce.number().int().min(1).max(60).optional(),
  duration: text(80),
  duration_key: z.enum(["12h", "allin", "oneway", "return", "multi"]).optional(),
  notes: text(1000),
  page_path: text(300),
  language: text(10),
  campaign: text(500),
  gclid: text(300),
  ga_client_id: text(100),
  ga_session_id: text(100),
  // Honeypot: real visitors never see or fill this field.
  website: z.string().optional(),
});
export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

export const listLeadsQuerySchema = z.object({
  status: z.enum(["NEW", "CONVERTED", "IGNORED"]).optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

export const ignoreLeadSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const linkLeadSchema = z.object({
  order_id: z.string().uuid(),
});
