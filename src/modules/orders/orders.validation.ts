import { z } from "zod";

const orderCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  is_primary: z.boolean().optional(),
});

const orderServiceItemSchema = z
  .object({
    // Edit Order: the existing day this row is (absent = a new day). Ignored
    // when creating an order.
    id: z.string().uuid().optional(),
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

export const createOrderSchema = z
  .object({
    // Sprint 5 #15: optionally lock the primary PIC to an existing master customer.
    customer_id: z.string().uuid().optional(),
    customer_name: z.string().min(1, "Customer name is required"),
    customer_phone: z.string().min(1, "Customer phone is required"),
    customers: z.array(orderCustomerSchema).optional(),
    service_items: z.array(orderServiceItemSchema).optional(),
    pickup_location: z.string().min(1, "Pickup location is required"),
    dropoff_location: z.string().min(1, "Dropoff location is required"),
    order_date: z
      .string()
      .datetime({ message: "order_date must be ISO 8601 datetime string" }),
    service_start_at: z.string().datetime().optional(),
    service_end_at: z.string().datetime().optional(),
    final_price: z.number().positive("final_price must be a positive number"),
    service_type: z.string().optional(),
    passenger_count: z.number().int().positive().optional(),
    area: z.string().optional(),
    notes: z.string().optional(),
    driver_origin: z.string().optional(),
    is_external: z.boolean().optional(),
    external_vendor_id: z.string().uuid().optional(),
    external_car_id: z.string().uuid().optional(),
    // Website lead this order was made from (Lead Website inbox).
    web_lead_id: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      !v.service_end_at ||
      new Date(v.service_end_at) >=
        new Date(v.service_start_at || v.order_date),
    {
      path: ["service_end_at"],
      message: "service_end_at must be after service_start_at",
    },
  );

export const updateOrderSchema = z
  .object({
    customer_name: z.string().min(1).optional(),
    customer_phone: z.string().min(1).optional(),
    customers: z.array(orderCustomerSchema).optional(),
    service_items: z.array(orderServiceItemSchema).optional(),
    pickup_location: z.string().min(1).optional(),
    dropoff_location: z.string().min(1).optional(),
    order_date: z.string().datetime().optional(),
    service_start_at: z.string().datetime().optional(),
    service_end_at: z.string().datetime().optional(),
    final_price: z.number().positive().optional(),
    service_type: z.string().optional(),
    passenger_count: z.number().int().positive().optional(),
    area: z.string().optional(),
    notes: z.string().optional(),
    driver_origin: z.string().optional(),
    is_external: z.boolean().optional(),
    external_vendor_id: z.string().uuid().optional(),
    external_car_id: z.string().uuid().optional(),
    // payment_status is not editable here: it follows the money recorded on
    // invoices (markInvoicePaid), which the owner's DP rule depends on.
    change_reason: z.string().optional(),
  })
  .refine(
    (v) =>
      !v.service_start_at ||
      !v.service_end_at ||
      new Date(v.service_end_at) >= new Date(v.service_start_at),
    {
      path: ["service_end_at"],
      message: "service_end_at must be after service_start_at",
    },
  );

const money = z.number().nonnegative().nullable().optional();
export const upsertOrderFinanceSchema = z.object({
  total_user_amount: money,
  sell_price: money,
  rtr_amount: money,
  total_ops_cost: money,
  fuel_amount: money,
  toll_amount: money,
  parking_cash_amount: money,
  driver_fee_amount: money,
  total_driver_amount: money,
  finance_note: z.string().nullable().optional(),
});

export const assignOrderSchema = z.object({
  driver_id: z.string().uuid("Invalid driver_id format"),
  car_id: z.string().uuid("Invalid car_id format"),
});

export const createAdjustmentSchema = z.object({
  type: z
    .enum([
      "ROUTE_CHANGE",
      "TIME_CHANGE",
      "EXTRA_DESTINATION",
      "OVERTIME",
      "PARKING",
      "TOLL",
      "FUEL",
      "DISCOUNT",
      "OTHER",
    ])
    .default("OTHER"),
  description: z.string().min(1),
  amount: z.number().default(0),
  quantity: z.number().int().positive().default(1),
  is_billable: z.boolean().default(true),
  created_by: z.string().optional(),
  // B8: a resend with the same client_ref returns the charge already made.
  client_ref: z.string().uuid().optional(),
});

export const createChangeLogSchema = z.object({
  field: z.string().optional(),
  old_value: z.string().optional(),
  new_value: z.string().optional(),
  note: z.string().optional(),
  actor: z.string().optional(),
});

// The old "refund settled" endpoint, kept as an alias for one release:
// amount optional (defaults to the whole saldo lebih, bounded by it); proof
// file is required and validated in the service.
export const markOrderRefundedSchema = z.object({
  note: z.string().optional(),
  amount: z.coerce.number().int("Nominal pengembalian harus rupiah bulat (tanpa sen)").positive().optional(),
});

// POST /orders/:id/refunds (multipart; proof file required, field "proof").
// The amount is at most the saldo lebih; client_ref makes a resend a no-op.
export const createRefundSchema = z.object({
  amount: z.coerce
    .number()
    .int("Nominal pengembalian harus rupiah bulat (tanpa sen)")
    .positive("Nominal pengembalian harus lebih dari 0"),
  note: z.string().trim().max(500).optional(),
  client_ref: z.string().uuid(),
});

// Full-order cancellation. A reason is required (kept in the audit log + on the
// cancellation-fee invoice). The penalty tier is computed server-side from the
// service date + current time; the client never sends an amount.
export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1, "Cancellation reason is required"),
  actor: z.string().optional(),
});

export type UpsertOrderFinanceInput = z.infer<typeof upsertOrderFinanceSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type AssignOrderInput = z.infer<typeof assignOrderSchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type CreateChangeLogInput = z.infer<typeof createChangeLogSchema>;
export type MarkOrderRefundedInput = z.infer<typeof markOrderRefundedSchema>;
export type CreateRefundInput = z.infer<typeof createRefundSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
