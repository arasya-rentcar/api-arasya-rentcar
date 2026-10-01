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
    rtr_amount: z.number().nullable().optional(),
    ops_cost: z.number().nonnegative().optional(),
    notes: z.string().nullable().optional(),
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
