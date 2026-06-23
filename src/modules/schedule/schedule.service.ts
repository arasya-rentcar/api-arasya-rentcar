import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { computeLineMargin, MARGIN_FORMULA_VERSION } from '../../utils/margin';
import { syncPayableForLine } from '../payables/payables.service';
import {
  deriveAndSetOrderStatus,
  syncDriverStatus,
  syncCarStatus,
  tripTimestampsForLine,
} from './order-derive.service';
import {
  deriveState,
  maybeAutoSendOnAssign,
} from '../confirmation/confirmation.service';
import {
  ListScheduleQuery,
  AssignScheduleLineInput,
  DriverAvailabilityQuery,
  TripHistoryQuery,
  ScheduleWeekQuery,
} from './schedule.validation';
import type { Prisma, ScheduleStatus } from '@prisma/client';

const lineInclude = {
  order: {
    select: {
      id: true,
      order_code: true,
      customer_name: true,
      order_status: true,
      payment_status: true,
    },
  },
  driver: { select: { id: true, name: true, phone: true } },
  car: { select: { id: true, model: true, plate_number: true } },
  external_vendor: { select: { id: true, name: true, phone: true } },
  external_car: { select: { id: true, model: true, plate_number: true } },
} satisfies Prisma.OrderServiceItemInclude;

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7, no DST.

/**
 * Day window for a calendar date interpreted in **Asia/Jakarta (WIB, GMT+7)**.
 * A date of 2026-06-20 (WIB) spans 2026-06-19T17:00:00Z .. 2026-06-20T16:59:59.999Z.
 * Fixes the old UTC-based bounds that day-shifted late-evening Jakarta lines.
 */
function dayBounds(dateStr?: string): { start: Date; end: Date } {
  // Determine the target Y/M/D in WIB. If a date string is given, take its WIB
  // calendar date; otherwise use "today" in WIB.
  const base = dateStr ? new Date(dateStr) : new Date();
  const wib = new Date(base.getTime() + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth();
  const d = wib.getUTCDate();
  // WIB midnight expressed in UTC = that wall-clock instant minus 7h.
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - WIB_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** List schedule day-lines with filters + pagination. */
export async function listSchedule(query: ListScheduleQuery) {
  const where: Prisma.OrderServiceItemWhereInput = {};

  if (query.date_from || query.date_to) {
    where.service_date = {};
    // Interpret both ends as WIB calendar days so a late-evening Jakarta line
    // isn't pushed into the wrong day by UTC parsing.
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = dayBounds(
        query.date_from,
      ).start;
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = dayBounds(
        query.date_to,
      ).end;
  }
  if (query.driver_id) where.driver_id = query.driver_id;
  if (query.car_id) where.car_id = query.car_id;
  if (query.external_vendor_id)
    where.external_vendor_id = query.external_vendor_id;
  if (query.type === 'INTERNAL') where.is_external = false;
  if (query.type === 'EXTERNAL') where.is_external = true;
  if (query.status) where.line_status = query.status;
  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { driver_name_raw: { contains: query.search, mode: 'insensitive' } },
      { plate_raw: { contains: query.search, mode: 'insensitive' } },
      { pickup_location: { contains: query.search, mode: 'insensitive' } },
      { dropoff_location: { contains: query.search, mode: 'insensitive' } },
      {
        order: {
          customer_name: { contains: query.search, mode: 'insensitive' },
        },
      },
      {
        order: { order_code: { contains: query.search, mode: 'insensitive' } },
      },
    ];
  }

  const skip = (query.page - 1) * query.page_size;
  const [rawItems, total, agg] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where,
      relationLoadStrategy: 'join',
      include: lineInclude,
      orderBy: [{ service_date: 'asc' }, { sort_order: 'asc' }],
      skip,
      take: query.page_size,
    }),
    prisma.orderServiceItem.count({ where }),
    prisma.orderServiceItem.aggregate({
      where,
      _sum: { total_price: true, ops_cost: true, margin_amount: true },
    }),
  ]);

  // Attach the derived #A1/#A2 confirmation badge state to each line.
  const items = rawItems.map((it) => ({
    ...it,
    confirmation_state: deriveState(it),
  }));

  return {
    items,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
    },
    totals: {
      revenue: agg._sum.total_price ?? 0,
      ops_cost: agg._sum.ops_cost ?? 0,
      margin: agg._sum.margin_amount ?? 0,
    },
  };
}

/** Update assignment / status / finance for a single day-line and recompute
 * its margin, then roll up the parent order's totals. */
export async function assignScheduleLine(
  id: string,
  input: AssignScheduleLineInput,
) {
  const line = await prisma.orderServiceItem.findUnique({ where: { id } });
  if (!line) throw new AppError('Schedule line not found', 404);

  const isExternal = input.is_external ?? line.is_external;

  // Validate referenced entities exist (and respect internal/external mode).
  // These reads are independent, so run them concurrently — over the Supabase
  // pooler each serial round-trip costs ~1s, so parallelising the existence
  // checks shaves real latency off every assign.
  if (!isExternal) {
    const [d, c] = await Promise.all([
      input.driver_id
        ? prisma.driver.findUnique({ where: { id: input.driver_id } })
        : Promise.resolve(null),
      input.car_id
        ? prisma.car.findUnique({ where: { id: input.car_id } })
        : Promise.resolve(null),
    ]);
    if (input.driver_id && !d) throw new AppError('Driver not found', 404);
    if (input.car_id && !c) throw new AppError('Car not found', 404);
  } else {
    const [v, ec] = await Promise.all([
      input.external_vendor_id
        ? prisma.externalVendor.findUnique({
            where: { id: input.external_vendor_id },
          })
        : Promise.resolve(null),
      input.external_car_id
        ? prisma.externalCar.findUnique({
            where: { id: input.external_car_id },
          })
        : Promise.resolve(null),
    ]);
    if (input.external_vendor_id && !v)
      throw new AppError('External vendor not found', 404);
    if (input.external_car_id && !ec)
      throw new AppError('External car not found', 404);
  }

  const revenue = Number(line.total_price ?? 0);
  const ops = input.ops_cost != null ? input.ops_cost : Number(line.ops_cost ?? 0);
  const rtr =
    input.rtr_amount !== undefined
      ? input.rtr_amount
      : line.rtr_amount != null
        ? Number(line.rtr_amount)
        : null;
  const margin = computeLineMargin({
    isExternal,
    revenue,
    ops_cost: ops,
    rtr_amount: rtr,
  });

  const data: Prisma.OrderServiceItemUncheckedUpdateInput = {
    is_external: isExternal,
    margin_amount: margin,
    margin_formula_version: MARGIN_FORMULA_VERSION,
    ops_cost: ops,
    rtr_amount: rtr,
  };
  // When switching mode, clear the other side's links.
  if (isExternal) {
    data.driver_id = null;
    data.car_id = null;
    if (input.external_vendor_id !== undefined)
      data.external_vendor_id = input.external_vendor_id;
    if (input.external_car_id !== undefined)
      data.external_car_id = input.external_car_id;
  } else {
    data.external_vendor_id = null;
    data.external_car_id = null;
    if (input.driver_id !== undefined) data.driver_id = input.driver_id;
    if (input.car_id !== undefined) data.car_id = input.car_id;
  }
  if (input.line_status !== undefined) {
    data.line_status = input.line_status;
    // The line IS the trip: derive journey timestamps from the status change.
    const ts = tripTimestampsForLine(input.line_status, {
      trip_started_at: line.trip_started_at,
      trip_finished_at: line.trip_finished_at,
    });
    if (ts.trip_started_at !== undefined) data.trip_started_at = ts.trip_started_at;
    if (ts.trip_finished_at !== undefined)
      data.trip_finished_at = ts.trip_finished_at;
  }
  if (input.service_date !== undefined)
    data.service_date = input.service_date ? new Date(input.service_date) : null;
  if (input.start_at !== undefined)
    data.start_at = input.start_at ? new Date(input.start_at) : null;
  if (input.end_at !== undefined)
    data.end_at = input.end_at ? new Date(input.end_at) : null;
  if (input.notes !== undefined) data.notes = input.notes;

  // Capture the line's resource links BEFORE the update so a reassignment can
  // also release the previously-linked driver/car if they are now idle.
  const prevDriverId = line.driver_id;
  const prevCarId = line.car_id;

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.orderServiceItem.update({
      where: { id },
      data,
      include: lineInclude,
    });
    await syncPayableForLine(tx, id);
    await rollupOrderFinance(tx, line.order_id);

    // Batch 2: keep order status derived from the lines inside this same
    // transaction so order_status / awaiting_finalization never drift.
    await deriveAndSetOrderStatus(tx, line.order_id);

    return u;
  }, { timeout: 20000, maxWait: 10000 });

  // Driver/car ON_DUTY/AVAILABLE status is NOT on the critical path: the
  // schedule timeline + stock derive free/busy from the lines themselves and
  // only read driver.status for the hard OFF / MAINTENANCE down-flag (which
  // these syncs never touch). So defer them to fire-and-forget AFTER commit,
  // in parallel — each was several serial pooler round-trips (~1s each) and
  // was the bulk of the assign latency. Idempotent, so a later run is safe.
  const driversToSync = new Set<string>();
  const carsToSync = new Set<string>();
  if (prevDriverId) driversToSync.add(prevDriverId);
  if (updated.driver_id) driversToSync.add(updated.driver_id);
  if (prevCarId) carsToSync.add(prevCarId);
  if (updated.car_id) carsToSync.add(updated.car_id);
  if (driversToSync.size || carsToSync.size) {
    void Promise.all([
      ...[...driversToSync].map((d) => syncDriverStatus(prisma, d)),
      ...[...carsToSync].map((c) => syncCarStatus(prisma, c)),
    ]).catch((err) =>
      console.error('deferred resource status sync failed', { lineId: id, err }),
    );
  }

  // #A1/#A2: same-day auto-send. Best-effort, never blocks the assign response.
  // Only fires when an internal driver+car are both set on the line.
  if (!updated.is_external && updated.driver_id && updated.car_id) {
    void maybeAutoSendOnAssign(id);
  }

  return { ...updated, confirmation_state: deriveState(updated) };
}

/** Recompute the order's rolled-up totals + margin from its day-lines. */
export async function rollupOrderFinance(
  tx: Prisma.TransactionClient,
  orderId: string,
) {
  const lines = await tx.orderServiceItem.findMany({
    where: { order_id: orderId },
  });
  let revenue = 0;
  let ops = 0;
  let rtr = 0;
  let margin = 0;
  let anyExternal = false;
  for (const l of lines) {
    revenue += Number(l.total_price ?? 0);
    ops += Number(l.ops_cost ?? 0);
    rtr += Number(l.rtr_amount ?? 0);
    margin += Number(l.margin_amount ?? 0);
    if (l.is_external) anyExternal = true;
  }
  // Billable adjustments (overtime/parking/etc.) bump the order total too, so
  // include them — otherwise re-running the rollup would wipe additional
  // charges back down to the bare service-line sum.
  const adjustments = await tx.orderAdjustment.findMany({
    where: { order_id: orderId, is_billable: true },
  });
  const adjustmentsTotal = adjustments.reduce(
    (s, a) => s + Number(a.amount ?? 0) * (a.quantity ?? 1),
    0,
  );
  const finalPrice = revenue + adjustmentsTotal;
  // Additional billable charges also add to revenue + margin (they are pure
  // markup with no extra resource cost recorded here).
  margin += adjustmentsTotal;
  // External lines pay RTR to the vendor; internal lines pay ops_cost to the
  // driver. Roll RTR up so the order-level Finance card no longer shows a
  // blank RTR for external orders. total_driver_amount stays a manual/optional
  // override (Driver Cost) so it does not duplicate Ops Cost.
  await tx.order.update({
    where: { id: orderId },
    data: { final_price: finalPrice, is_external: anyExternal },
  });
  await tx.orderFinalFinance.upsert({
    where: { order_id: orderId },
    update: {
      total_user_amount: finalPrice,
      total_ops_cost: ops,
      rtr_amount: rtr,
      margin_amount: margin,
      margin_formula_version: MARGIN_FORMULA_VERSION,
    },
    create: {
      order_id: orderId,
      total_user_amount: finalPrice,
      total_ops_cost: ops,
      rtr_amount: rtr,
      margin_amount: margin,
      margin_formula_version: MARGIN_FORMULA_VERSION,
    },
  });
}

/**
 * Driver availability for a given day, derived from the SCHEDULE (not orders).
 * A driver is BUSY if they have a non-cancelled line on that day, else FREE.
 */
export async function driverAvailability(query: DriverAvailabilityQuery) {
  const { start, end } = dayBounds(query.date);
  const drivers = await prisma.driver.findMany({
    where: query.type ? { type: query.type } : undefined,
    select: { id: true, name: true, phone: true, type: true, status: true },
    orderBy: { name: 'asc' },
  });
  const lines = await prisma.orderServiceItem.findMany({
    where: {
      driver_id: { not: null },
      line_status: { not: 'CANCELLED' },
      service_date: { gte: start, lte: end },
    },
    include: {
      order: { select: { id: true, order_code: true, customer_name: true } },
    },
  });
  const byDriver = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!l.driver_id) continue;
    if (!byDriver.has(l.driver_id)) byDriver.set(l.driver_id, []);
    byDriver.get(l.driver_id)!.push(l);
  }
  return {
    date: start.toISOString().slice(0, 10),
    drivers: drivers.map((d) => {
      const busy = byDriver.get(d.id) || [];
      return {
        ...d,
        availability: busy.length ? 'BUSY' : 'FREE',
        bookings: busy.map((b) => ({
          line_id: b.id,
          order_id: b.order?.id,
          order_code: b.order?.order_code,
          customer_name: b.order?.customer_name,
          route: `${b.pickup_location} -> ${b.dropoff_location}`,
          status: b.line_status,
        })),
      };
    }),
  };
}

/**
 * #12 Stock / availability monitor for a WIB calendar date.
 * Rules (locked with TEN):
 *  - total = ALL internal Driver/Car owned.
 *  - down  = units off the road today (Driver.status OFF / Car.status MAINTENANCE).
 *  - used  = distinct internal units on lines that day with line_status in
 *            (SCHEDULED, IN_PROGRESS). DONE/CANCELLED do NOT occupy a unit.
 *  - free  = total - used - down (a unit counted once; down takes precedence).
 * Only INTERNAL stock is counted (external vendors = unlimited 3rd-party supply).
 */
export async function scheduleStock(query: { date?: string }) {
  const { start, end } = dayBounds(query.date);
  const ACTIVE: ScheduleStatus[] = ['SCHEDULED', 'IN_PROGRESS'];

  const [drivers, cars, lines] = await Promise.all([
    prisma.driver.findMany({
      where: { type: 'INTERNAL' },
      select: { id: true, name: true, phone: true, status: true },
      orderBy: { name: 'asc' },
    }),
    prisma.car.findMany({
      where: { type: 'INTERNAL' },
      select: {
        id: true,
        model: true,
        plate_number: true,
        unit_code: true,
        status: true,
      },
      orderBy: { model: 'asc' },
    }),
    prisma.orderServiceItem.findMany({
      where: {
        is_external: false,
        line_status: { in: ACTIVE },
        service_date: { gte: start, lte: end },
      },
      select: {
        id: true,
        driver_id: true,
        car_id: true,
        line_status: true,
        pickup_location: true,
        dropoff_location: true,
        order: { select: { id: true, order_code: true, customer_name: true } },
      },
    }),
  ]);

  type Booking = {
    line_id: string;
    order_id?: string;
    order_code?: string | null;
    customer_name?: string;
    route: string;
    status: ScheduleStatus;
  };
  const bookingOf = (l: (typeof lines)[number]): Booking => ({
    line_id: l.id,
    order_id: l.order?.id,
    order_code: l.order?.order_code,
    customer_name: l.order?.customer_name,
    route: `${l.pickup_location} -> ${l.dropoff_location}`,
    status: l.line_status,
  });

  const driverBookings = new Map<string, Booking[]>();
  const carBookings = new Map<string, Booking[]>();
  for (const l of lines) {
    if (l.driver_id) {
      if (!driverBookings.has(l.driver_id)) driverBookings.set(l.driver_id, []);
      driverBookings.get(l.driver_id)!.push(bookingOf(l));
    }
    if (l.car_id) {
      if (!carBookings.has(l.car_id)) carBookings.set(l.car_id, []);
      carBookings.get(l.car_id)!.push(bookingOf(l));
    }
  }

  // Drivers
  const driverDown: typeof drivers = [];
  const driverUsed: { id: string; name: string; phone: string; bookings: Booking[] }[] = [];
  const driverFree: { id: string; name: string; phone: string }[] = [];
  for (const d of drivers) {
    if (d.status === 'OFF') {
      driverDown.push(d);
    } else if (driverBookings.has(d.id)) {
      driverUsed.push({ id: d.id, name: d.name, phone: d.phone, bookings: driverBookings.get(d.id)! });
    } else {
      driverFree.push({ id: d.id, name: d.name, phone: d.phone });
    }
  }

  // Cars
  const carDown: typeof cars = [];
  const carUsed: {
    id: string;
    model: string;
    plate_number: string;
    unit_code: string | null;
    bookings: Booking[];
  }[] = [];
  const carFree: { id: string; model: string; plate_number: string; unit_code: string | null }[] = [];
  for (const c of cars) {
    if (c.status === 'MAINTENANCE') {
      carDown.push(c);
    } else if (carBookings.has(c.id)) {
      carUsed.push({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
        bookings: carBookings.get(c.id)!,
      });
    } else {
      carFree.push({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
      });
    }
  }

  return {
    date: start.toISOString(),
    date_wib: new Date(start.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10),
    drivers: {
      total: drivers.length,
      down: driverDown.length,
      used: driverUsed.length,
      free: driverFree.length,
      down_list: driverDown.map((d) => ({ id: d.id, name: d.name })),
      used_list: driverUsed,
      free_list: driverFree,
    },
    cars: {
      total: cars.length,
      down: carDown.length,
      used: carUsed.length,
      free: carFree.length,
      down_list: carDown.map((c) => ({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
      })),
      used_list: carUsed,
      free_list: carFree,
    },
  };
}

/** WIB calendar date (YYYY-MM-DD) for a given instant. */
function wibDateStr(d: Date): string {
  return new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Monday (WIB) of the week containing the given WIB date string. */
function wibWeekStart(dateStr: string): string {
  const { start } = dayBounds(dateStr); // WIB midnight as UTC instant
  // getUTCDay on the WIB-shifted instant gives the WIB weekday.
  const wib = new Date(start.getTime() + WIB_OFFSET_MS);
  const dow = (wib.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(start.getTime() - dow * 24 * 60 * 60 * 1000);
  return wibDateStr(monday);
}

/**
 * Week Timeline: 7 WIB days of fleet availability in ONE response, for the
 * dashboard Schedule > Timeline view.
 *
 * Rows are the chosen resource (drivers by default, or cars); each row carries
 * a 7-cell array aligned to the week's days. A cell is either free or holds the
 * active bookings (SCHEDULED/IN_PROGRESS internal lines) for that resource on
 * that WIB day. Each day also gets capacity counts (free/used/down/total for
 * BOTH drivers and cars) so the UI can show a per-day capacity ribbon without
 * extra calls. Two queries total (fleet + lines), bucketed in memory.
 */
export async function scheduleWeek(query: ScheduleWeekQuery) {
  const weekStart = wibWeekStart(query.from ?? wibDateStr(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => {
    const ds = wibDateStr(
      new Date(dayBounds(weekStart).start.getTime() + i * 24 * 60 * 60 * 1000),
    );
    return ds;
  });
  const windowStart = dayBounds(days[0]).start;
  const windowEnd = dayBounds(days[6]).end;
  const ACTIVE: ScheduleStatus[] = ['SCHEDULED', 'IN_PROGRESS'];

  const [drivers, cars, lines] = await Promise.all([
    prisma.driver.findMany({
      where: { type: 'INTERNAL' },
      select: { id: true, name: true, phone: true, status: true },
      orderBy: { name: 'asc' },
    }),
    prisma.car.findMany({
      where: { type: 'INTERNAL' },
      select: {
        id: true,
        model: true,
        plate_number: true,
        unit_code: true,
        status: true,
      },
      orderBy: { model: 'asc' },
    }),
    prisma.orderServiceItem.findMany({
      where: {
        is_external: false,
        line_status: { in: ACTIVE },
        service_date: { gte: windowStart, lte: windowEnd },
      },
      relationLoadStrategy: 'join',
      select: {
        id: true,
        driver_id: true,
        car_id: true,
        line_status: true,
        service_date: true,
        pickup_location: true,
        dropoff_location: true,
        order: { select: { id: true, order_code: true, customer_name: true } },
      },
    }),
  ]);

  type WeekBooking = {
    line_id: string;
    order_id?: string;
    order_code?: string | null;
    customer_name?: string;
    route: string;
    status: ScheduleStatus;
  };
  const bookingOf = (l: (typeof lines)[number]): WeekBooking => ({
    line_id: l.id,
    order_id: l.order?.id,
    order_code: l.order?.order_code,
    customer_name: l.order?.customer_name,
    route: `${l.pickup_location} -> ${l.dropoff_location}`,
    status: l.line_status,
  });

  const dayIndex = new Map(days.map((d, i) => [d, i]));
  // resourceDayBookings[resourceId][dayIdx] = bookings
  const driverGrid = new Map<string, WeekBooking[][]>();
  const carGrid = new Map<string, WeekBooking[][]>();
  const emptyGrid = () => Array.from({ length: 7 }, () => [] as WeekBooking[]);

  // Unassigned lanes: a scheduled line with no driver (or no car) belongs to no
  // resource row, so without this it would be invisible on the board. Surface it
  // in a dedicated lane so dispatchers can see + assign pending work.
  const driverUnassigned = emptyGrid();
  const carUnassigned = emptyGrid();
  for (const l of lines) {
    if (!l.service_date) continue;
    const di = dayIndex.get(wibDateStr(l.service_date));
    if (di == null) continue;
    if (l.driver_id) {
      if (!driverGrid.has(l.driver_id)) driverGrid.set(l.driver_id, emptyGrid());
      driverGrid.get(l.driver_id)![di].push(bookingOf(l));
    } else {
      driverUnassigned[di].push(bookingOf(l));
    }
    if (l.car_id) {
      if (!carGrid.has(l.car_id)) carGrid.set(l.car_id, emptyGrid());
      carGrid.get(l.car_id)![di].push(bookingOf(l));
    } else {
      carUnassigned[di].push(bookingOf(l));
    }
  }

  const driverRows = drivers.map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    down: d.status === 'OFF',
    cells: (driverGrid.get(d.id) ?? emptyGrid()).map((bookings) => ({
      free: d.status !== 'OFF' && bookings.length === 0,
      bookings,
    })),
  }));
  const carRows = cars.map((c) => ({
    id: c.id,
    name: c.model,
    plate_number: c.plate_number,
    unit_code: c.unit_code,
    down: c.status === 'MAINTENANCE',
    cells: (carGrid.get(c.id) ?? emptyGrid()).map((bookings) => ({
      free: c.status !== 'MAINTENANCE' && bookings.length === 0,
      bookings,
    })),
  }));

  // Per-day capacity ribbon (both fleets), independent of the chosen resource.
  const capacity = days.map((_, di) => {
    const dDown = driverRows.filter((r) => r.down).length;
    const dUsed = driverRows.filter(
      (r) => !r.down && r.cells[di].bookings.length > 0,
    ).length;
    const cDown = carRows.filter((r) => r.down).length;
    const cUsed = carRows.filter(
      (r) => !r.down && r.cells[di].bookings.length > 0,
    ).length;
    const trips = lines.filter(
      (l) => l.service_date && wibDateStr(l.service_date) === days[di],
    ).length;
    return {
      date: days[di],
      trips,
      drivers: {
        total: drivers.length,
        down: dDown,
        used: dUsed,
        free: drivers.length - dDown - dUsed,
      },
      cars: {
        total: cars.length,
        down: cDown,
        used: cUsed,
        free: cars.length - cDown - cUsed,
      },
    };
  });

  const today = wibDateStr(new Date());
  // Lane of scheduled-but-unassigned trips for the chosen resource. Only emitted
  // when it actually has bookings, so the board stays clean when all is assigned.
  const unassignedCells = (
    query.resource === 'cars' ? carUnassigned : driverUnassigned
  ).map((bookings) => ({ free: false, bookings }));
  const unassigned = unassignedCells.some((c) => c.bookings.length > 0)
    ? { id: '__unassigned__', name: '', cells: unassignedCells }
    : null;
  return {
    week_start: days[0],
    week_end: days[6],
    today,
    resource: query.resource,
    days,
    capacity,
    unassigned,
    rows: query.resource === 'cars' ? carRows : driverRows,
  };
}

/**
 * Trip History: finished (DONE) service-day lines, newest first, with full
 * per-line detail for the dashboard History tab.
 *
 * A line goes DONE the moment the driver reports dropoff, but the parent ORDER
 * only reaches DONE once the admin finalizes (after entering ops cost / driver
 * fee / additionals). So a DONE line can still be financially pending. We
 * surface BOTH and tag each row:
 *   - finance_status = 'FINALIZED' when the parent order_status === 'DONE'
 *   - finance_status = 'AWAITING'  when the line is DONE but the order is not
 *     yet finalized (order.awaiting_finalization or still IN_PROGRESS).
 * The dashboard renders money fields as "Pending" for AWAITING rows.
 *
 * Included per line: order summary, driver/car (or external vendor/car), the
 * actual timestamps, ops_cost, margin_amount, the Payable (driver fee, with
 * extras), and the driver TripReports (chronological).
 */
export async function tripHistory(query: TripHistoryQuery) {
  const where: Prisma.OrderServiceItemWhereInput = {
    line_status: 'DONE',
  };

  if (query.date_from || query.date_to) {
    where.service_date = {};
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = dayBounds(
        query.date_from,
      ).start;
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = dayBounds(
        query.date_to,
      ).end;
  }
  if (query.driver_id) where.driver_id = query.driver_id;
  if (query.car_id) where.car_id = query.car_id;

  // finance filter via the parent order's finalization state.
  if (query.finance === 'finalized') {
    where.order = { order_status: 'DONE' };
  } else if (query.finance === 'awaiting') {
    where.order = { order_status: { not: 'DONE' } };
  }

  if (query.search) {
    where.OR = [
      { pickup_location: { contains: query.search, mode: 'insensitive' } },
      { dropoff_location: { contains: query.search, mode: 'insensitive' } },
      { driver_name_raw: { contains: query.search, mode: 'insensitive' } },
      {
        order: {
          customer_name: { contains: query.search, mode: 'insensitive' },
        },
      },
      {
        order: { order_code: { contains: query.search, mode: 'insensitive' } },
      },
    ];
  }

  const historyInclude = {
    order: {
      select: {
        id: true,
        order_code: true,
        customer_name: true,
        order_status: true,
        payment_status: true,
        awaiting_finalization: true,
      },
    },
    driver: { select: { id: true, name: true, phone: true } },
    car: { select: { id: true, model: true, plate_number: true } },
    external_vendor: { select: { id: true, name: true, phone: true } },
    external_car: { select: { id: true, model: true, plate_number: true } },
    payable: {
      include: {
        extras: {
          select: { id: true, label: true, amount: true },
          orderBy: { created_at: 'asc' as const },
        },
      },
    },
    reports: {
      select: {
        id: true,
        report_type: true,
        input_type: true,
        notes: true,
        file_url: true,
        file_mime: true,
        driver_phone: true,
        status: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' as const },
    },
  } satisfies Prisma.OrderServiceItemInclude;

  const skip = (query.page - 1) * query.page_size;
  const [rows, total] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where,
      relationLoadStrategy: 'join',
      include: historyInclude,
      // Newest finished first: prefer actual dropoff time, fall back to date.
      orderBy: [{ trip_finished_at: 'desc' }, { service_date: 'desc' }],
      skip,
      take: query.page_size,
    }),
    prisma.orderServiceItem.count({ where }),
  ]);

  const items = rows.map((it) => {
    const finalized = it.order?.order_status === 'DONE';
    return {
      ...it,
      finance_status: finalized ? 'FINALIZED' : 'AWAITING',
    };
  });

  return {
    items,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
    },
  };
}
