import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { computeLineMargin, MARGIN_FORMULA_VERSION } from '../../utils/margin';
import { syncPayableForLine } from '../payables/payables.service';
import {
  ListScheduleQuery,
  AssignScheduleLineInput,
  DriverAvailabilityQuery,
} from './schedule.validation';
import type { Prisma } from '@prisma/client';

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

function dayBounds(dateStr?: string): { start: Date; end: Date } {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** List schedule day-lines with filters + pagination. */
export async function listSchedule(query: ListScheduleQuery) {
  const where: Prisma.OrderServiceItemWhereInput = {};

  if (query.date_from || query.date_to) {
    where.service_date = {};
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = new Date(
        query.date_from,
      );
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = new Date(
        query.date_to,
      );
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
  const [items, total, agg] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where,
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
  if (!isExternal) {
    if (input.driver_id) {
      const d = await prisma.driver.findUnique({ where: { id: input.driver_id } });
      if (!d) throw new AppError('Driver not found', 404);
    }
    if (input.car_id) {
      const c = await prisma.car.findUnique({ where: { id: input.car_id } });
      if (!c) throw new AppError('Car not found', 404);
    }
  } else {
    if (input.external_vendor_id) {
      const v = await prisma.externalVendor.findUnique({
        where: { id: input.external_vendor_id },
      });
      if (!v) throw new AppError('External vendor not found', 404);
    }
    if (input.external_car_id) {
      const ec = await prisma.externalCar.findUnique({
        where: { id: input.external_car_id },
      });
      if (!ec) throw new AppError('External car not found', 404);
    }
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
  if (input.line_status !== undefined) data.line_status = input.line_status;
  if (input.service_date !== undefined)
    data.service_date = input.service_date ? new Date(input.service_date) : null;
  if (input.start_at !== undefined)
    data.start_at = input.start_at ? new Date(input.start_at) : null;
  if (input.end_at !== undefined)
    data.end_at = input.end_at ? new Date(input.end_at) : null;
  if (input.notes !== undefined) data.notes = input.notes;

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.orderServiceItem.update({
      where: { id },
      data,
      include: lineInclude,
    });
    await syncPayableForLine(tx, id);
    await rollupOrderFinance(tx, line.order_id);
    return u;
  }, { timeout: 20000, maxWait: 10000 });
  return updated;
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
  let margin = 0;
  let anyExternal = false;
  for (const l of lines) {
    revenue += Number(l.total_price ?? 0);
    ops += Number(l.ops_cost ?? 0);
    margin += Number(l.margin_amount ?? 0);
    if (l.is_external) anyExternal = true;
  }
  await tx.order.update({
    where: { id: orderId },
    data: { final_price: revenue, is_external: anyExternal },
  });
  await tx.orderFinalFinance.upsert({
    where: { order_id: orderId },
    update: {
      total_user_amount: revenue,
      total_ops_cost: ops,
      margin_amount: margin,
      margin_formula_version: MARGIN_FORMULA_VERSION,
    },
    create: {
      order_id: orderId,
      total_user_amount: revenue,
      total_ops_cost: ops,
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
