import { z } from "zod";

export const botCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  is_primary: z.boolean().optional(),
});

export const botServiceItemSchema = z
  .object({
    service_date: z.string().datetime().optional(),
    start_at: z.string().datetime().optional(),
    end_at: z.string().datetime().optional(),
    description: z.string().optional(),
    service_kind: z.string().optional(),
    service_package: z.string().optional(),
    pickup_location: z.string().min(1),
    dropoff_location: z.string().min(1),
    driver_origin_location: z.string().optional(),
    quantity: z.number().int().positive().default(1),
    unit_price: z.number().min(0).default(0),
    total_price: z.number().min(0).optional(),
    notes: z.string().optional(),
    sort_order: z.number().int().optional(),
  })
  .refine(
    (v) =>
      !v.start_at || !v.end_at || new Date(v.end_at) >= new Date(v.start_at),
    {
      path: ["end_at"],
      message: "item end_at must be after start_at",
    },
  );

export const botCreateOrderSchema = z.object({
  order_code: z.string().min(1).optional(),
  customer_name: z.string().min(1),
  customer_phone: z.string().default(""),
  customers: z.array(botCustomerSchema).optional(),
  service_items: z.array(botServiceItemSchema).optional(),
  pickup_location: z.string().min(1),
  dropoff_location: z.string().min(1),
  order_date: z.string().datetime(),
  final_price: z.number().nonnegative().default(0),
  service_type: z.string().optional(),
  passenger_count: z.number().int().positive().optional(),
  notes: z.string().optional(),
  area: z.string().optional(),
  driver_origin: z.string().optional(),
  raw_order_text: z.string().optional(),
  whatsapp_message_id: z.string().optional(),
  driver_name: z.string().optional(),
  driver_phone: z.string().optional(),
  driver_type: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
  car_query: z.string().optional(),
  car_model: z.string().optional(),
  car_plate: z.string().optional(),
});

export const botAssignSchema = z.object({
  driver_id: z.string().uuid().optional(),
  car_id: z.string().uuid().optional(),
  driver_name: z.string().optional(),
  driver_phone: z.string().optional(),
  driver_type: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
  driver_origin: z.string().optional(),
  car_query: z.string().optional(),
  car_model: z.string().optional(),
  car_plate: z.string().optional(),
});

export const botReportSchema = z.object({
  order_code: z.string().optional(),
  driver_phone: z.string().optional(),
  report_type: z.string().min(1),
  input_type: z
    .enum(["TEXT", "IMAGE", "PDF", "DOCUMENT", "MIXED"])
    .default("TEXT"),
  notes: z.string().optional(),
  extracted_text: z.string().optional(),
  file_url: z.string().optional(),
  file_mime: z.string().optional(),
  match_method: z.string().optional(),
  status: z.enum(["MATCHED", "UNMATCHED", "NEEDS_REVIEW"]).default("MATCHED"),
});

export const botFinishSchema = z.object({
  driver_phone: z.string().optional(),
  notes: z.string().optional(),
  generated_summary: z.string().optional(),
});

export type BotCreateOrderInput = z.infer<typeof botCreateOrderSchema>;
export type BotAssignInput = z.infer<typeof botAssignSchema>;
export type BotReportInput = z.infer<typeof botReportSchema>;
export type BotFinishInput = z.infer<typeof botFinishSchema>;
