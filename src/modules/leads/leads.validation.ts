import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * A map coordinate from the website, or undefined when it is missing or
 * unusable. Never an error: the form posts by sendBeacon and does not see the
 * answer, so rejecting the body would lose the lead over a bad map point.
 */
const lenientCoordinate = (limit: number) =>
  z.unknown().transform((v) => {
    const n =
      typeof v === "number"
        ? v
        : typeof v === "string" && v.trim() !== ""
          ? Number(v)
          : NaN;
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
  });

/** Map place id / name: trimmed, dropped (not an error) when too long. */
const lenientPlaceText = (max: number) =>
  z.unknown().transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t && t.length <= max ? t : undefined;
  });

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
  // Map points picked on the website (all optional, see the transform below).
  pickup_lat: lenientCoordinate(90),
  pickup_lng: lenientCoordinate(180),
  pickup_place_id: lenientPlaceText(300),
  pickup_place_name: lenientPlaceText(300),
  destination_lat: lenientCoordinate(90),
  destination_lng: lenientCoordinate(180),
  destination_place_id: lenientPlaceText(300),
  destination_place_name: lenientPlaceText(300),
  // Honeypot: real visitors never see or fill this field.
  website: z.string().optional(),
}).transform((lead) => {
  // A side (pickup / destination) is kept only with both lat and lng valid;
  // otherwise its four fields are dropped (stored as null) and the lead is
  // still saved.
  const out = { ...lead };
  if (out.pickup_lat === undefined || out.pickup_lng === undefined) {
    out.pickup_lat = out.pickup_lng = undefined;
    out.pickup_place_id = out.pickup_place_name = undefined;
  }
  if (out.destination_lat === undefined || out.destination_lng === undefined) {
    out.destination_lat = out.destination_lng = undefined;
    out.destination_place_id = out.destination_place_name = undefined;
  }
  return out;
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
