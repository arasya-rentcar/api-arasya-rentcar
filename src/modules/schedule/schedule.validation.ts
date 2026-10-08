import { z } from 'zod';

export const listScheduleQuerySchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  driver_id: z.string().uuid().optional(),
  car_id: z.string().uuid().optional(),
  external_vendor_id: z.string().uuid().optional(),
  type: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
  status: z
    .enum(['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'CANCELLED'])
    .optional(),
  search: z.string().optional(),
  // "Belum ditutup": open trips (SCHEDULED/ASSIGNED/IN_PROGRESS) dated before
  // yesterday (WIB). The driver app no longer lists most of them.
  overdue: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
});
export type ListScheduleQuery = z.infer<typeof listScheduleQuerySchema>;

export const assignScheduleLineSchema = z
  .object({
    is_external: z.boolean().optional(),
    driver_id: z.string().uuid().nullable().optional(),
    car_id: z.string().uuid().nullable().optional(),
    external_vendor_id: z.string().uuid().nullable().optional(),
    external_car_id: z.string().uuid().nullable().optional(),
    // EXTERNAL lines only: the partner's driver + plate for this day (the
    // vendor driver does not use the app). Ignored on internal lines; cleared
    // when a line switches back to internal. Empty string clears.
    driver_name_raw: z.string().max(120).nullable().optional(),
    driver_phone_raw: z.string().max(40).nullable().optional(),
    plate_raw: z.string().max(30).nullable().optional(),
    line_status: z
      .enum(['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'CANCELLED'])
      .optional(),
    service_date: z.string().datetime().nullable().optional(),
    start_at: z.string().datetime().nullable().optional(),
    end_at: z.string().datetime().nullable().optional(),
    rtr_amount: z.number().nonnegative().nullable().optional(),
    // Driver pay (2026-10-03): the day's fee, how it was built, uang jalan.
    driver_fee: z.number().nonnegative().max(100_000_000).nullable().optional(),
    driver_fee_note: z.string().max(200).nullable().optional(),
    travel_advance: z.number().nonnegative().max(100_000_000).nullable().optional(),
    // Legacy: older dashboards send "Biaya Ops". Accepted and ignored; ops_cost
    // is derived from the approved trip costs (recomputeLineMoney).
    ops_cost: z.number().nonnegative().optional(),
    notes: z.string().nullable().optional(),
    // Per-day cancellation (A3), read only when line_status turns CANCELLED:
    // the reason (required then), the fee the admin saw in the quote (a
    // different server fee → 409 CANCEL_FEE_CHANGED) and when the customer
    // asked to cancel (≤ now, ≥ now − 3 days; the tier follows it).
    // `expected_cancel_fee` is always the AUTOMATIC fee; `cancel_fee` is the
    // fee set by hand (owner, 8 Oct 2026; whole rupiah, ≤ the day's price,
    // else 400 INVALID_CANCEL_FEE), absent = the automatic fee.
    cancel_reason: z.string().trim().min(1).max(500).optional(),
    expected_cancel_fee: z.number().nonnegative().optional(),
    cancel_fee: z.number().int('Biaya pembatalan harus rupiah bulat').nonnegative().optional(),
    cancel_requested_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type AssignScheduleLineInput = z.infer<typeof assignScheduleLineSchema>;

export const driverAvailabilityQuerySchema = z.object({
  date: z.string().optional(), // YYYY-MM-DD; defaults to today
  type: z.enum(['INTERNAL', 'EXTERNAL']).optional(),
});
export type DriverAvailabilityQuery = z.infer<
  typeof driverAvailabilityQuerySchema
>;

// #12 stock monitor: driver + car used/free/down/total for a WIB date.
export const scheduleStockQuerySchema = z.object({
  date: z.string().optional(), // YYYY-MM-DD (WIB); defaults to today
});
export type ScheduleStockQuery = z.infer<typeof scheduleStockQuerySchema>;

// Trip History: finished (DONE) service lines, per-line, with full detail
// (actual timestamps, ops cost, driver fee/payable, margin, driver reports).
// finance filter: all | finalized (parent order DONE) | awaiting (line DONE but
// order still awaiting_finalization).
export const tripHistoryQuerySchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  driver_id: z.string().uuid().optional(),
  car_id: z.string().uuid().optional(),
  finance: z.enum(['all', 'finalized', 'awaiting']).default('all'),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
});
export type TripHistoryQuery = z.infer<typeof tripHistoryQuerySchema>;

// Week timeline: 7 WIB days of resource availability in one call. `from` is the
// week's first day (YYYY-MM-DD, WIB); defaults to the Monday of the current WIB
// week. `resource` chooses which fleet to expand into rows (both always have
// capacity counts).
export const scheduleWeekQuerySchema = z.object({
  from: z.string().optional(),
  resource: z.enum(['drivers', 'cars']).default('drivers'),
});
export type ScheduleWeekQuery = z.infer<typeof scheduleWeekQuerySchema>;

// GET /schedule/lines/:id/cancel-quote and GET /orders/:id/cancel-quote.
export const cancelQuoteQuerySchema = z.object({
  requested_at: z.string().datetime({ offset: true }).optional(),
});
