import type { Prisma, OrderStatus, ScheduleStatus } from '@prisma/client';

/** Line states that count as a started-but-not-finished trip. */
export type LineTimestampEffect = {
  trip_started_at?: Date | null;
  trip_finished_at?: Date | null;
};

/**
 * Option A active-line resolution (locked with TEN 2026-06-22).
 * Given an order and a driver, find the ONE day-line the driver's next
 * WhatsApp action (START / FINISH / report / expense) should apply to.
 *
 * Rule: the earliest non-terminal (not DONE/CANCELLED) internal line of that
 * order assigned to this driver. Prefer an already-IN_PROGRESS line (the day
 * they're actively running) over a not-yet-started ASSIGNED one; within a tier
 * order by service_date then sort_order. Returns null if none.
 *
 * For single-day orders this is just "the line". For multi-day it correctly
 * walks day-by-day: finish today's line -> tomorrow's becomes the active one.
 */
export async function resolveActiveLine(
  tx: Prisma.TransactionClient,
  orderId: string,
  driverId: string,
): Promise<{ id: string; line_status: ScheduleStatus } | null> {
  const candidates = await tx.orderServiceItem.findMany({
    where: {
      order_id: orderId,
      driver_id: driverId,
      is_external: false,
      line_status: { notIn: ['DONE', 'CANCELLED'] },
    },
    select: { id: true, line_status: true, service_date: true, sort_order: true },
    orderBy: [{ service_date: 'asc' }, { sort_order: 'asc' }],
  });
  if (candidates.length === 0) return null;
  // Prefer a line already in progress (the day actively being run).
  const inProgress = candidates.find((c) => c.line_status === 'IN_PROGRESS');
  const chosen = inProgress ?? candidates[0];
  return { id: chosen.id, line_status: chosen.line_status };
}

/**
 * Batch 2: derive the parent Order status from its day-lines, and keep
 * driver/car resource status in sync as lines move through their lifecycle.
 *
 * Design (locked with TEN 2026-06-22):
 *  - `line_status` (ScheduleStatus) is the COARSE roll-up source.
 *      SCHEDULED  -> order contribution CREATED  (unassigned)
 *      ASSIGNED   -> ASSIGNED
 *      IN_PROGRESS-> IN_PROGRESS
 *      DONE       -> DONE
 *      CANCELLED  -> terminal, ignored when other active lines exist
 *  - These helpers run INSIDE the same $transaction that mutates a line so the
 *    order status + resource status are always consistent with the lines.
 */

/**
 * Roll a set of line statuses up into a single order status.
 * Priority: IN_PROGRESS > ASSIGNED > DONE > CREATED, with CANCELLED treated as
 * terminal/ignored unless EVERY line is cancelled (then the order is CANCELLED).
 *
 * #1 decision: a line set that is all-terminal but contains at least one DONE
 * (e.g. DONE + CANCELLED) resolves to DONE, not CREATED.
 */
export function rollupOrderStatus(statuses: ScheduleStatus[]): OrderStatus {
  if (statuses.length === 0) return 'CREATED';

  // Every line cancelled -> order cancelled.
  if (statuses.every((s) => s === 'CANCELLED')) return 'CANCELLED';

  // Ignore cancelled lines when judging the rest of the order.
  const active = statuses.filter((s) => s !== 'CANCELLED');

  if (active.some((s) => s === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (active.some((s) => s === 'ASSIGNED')) return 'ASSIGNED';
  // ADMIN-FINALIZE MODEL (2026-06-23): "all active lines DONE" no longer
  // auto-DONEs the order. Finalization is an admin financial act (ops cost /
  // additional / driver fee must be entered first), so we CAP at IN_PROGRESS
  // here and surface the real state via Order.awaiting_finalization. The order
  // only reaches DONE through the admin finalize endpoint.
  if (active.length > 0 && active.every((s) => s === 'DONE')) return 'IN_PROGRESS';
  // Otherwise still being prepared (some SCHEDULED, none assigned yet).
  return 'CREATED';
}

/**
 * True when there is at least one active (non-cancelled) line and ALL active
 * lines are DONE. This is the "all trips finished" signal that drives
 * Order.awaiting_finalization (since rollupOrderStatus now caps such an order
 * at IN_PROGRESS rather than DONE).
 */
export function allActiveLinesDone(statuses: ScheduleStatus[]): boolean {
  const active = statuses.filter((s) => s !== 'CANCELLED');
  return active.length > 0 && active.every((s) => s === 'DONE');
}

/**
 * Derive and persist the order status from its current day-lines.
 * Skips the write when the status is already correct. Returns the resolved
 * status. MUST be called inside a transaction that has (or will have) committed
 * the line changes it is deriving from.
 */
export async function deriveAndSetOrderStatus(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderStatus> {
  const lines = await tx.orderServiceItem.findMany({
    where: { order_id: orderId },
    select: { line_status: true },
  });

  const statuses = lines.map((l) => l.line_status);
  const next = rollupOrderStatus(statuses);
  const finished = allActiveLinesDone(statuses);

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { order_status: true, awaiting_finalization: true },
  });
  if (!order) return next;

  // TERMINAL GUARD: once an order is admin-finalised (DONE) or CANCELLED, never
  // resurrect it from a later line edit. rollupOrderStatus now caps all-done at
  // IN_PROGRESS, so without this guard a finalised order would be dragged back
  // to IN_PROGRESS. Leave order_status + awaiting_finalization untouched.
  if (order.order_status === 'DONE' || order.order_status === 'CANCELLED') {
    return order.order_status;
  }

  // awaiting_finalization: TRUE exactly when all active lines are DONE but the
  // admin has not finalised yet. Cleared automatically if a line reopens.
  const data: Prisma.OrderUncheckedUpdateInput = {};
  if (order.order_status !== next) data.order_status = next;
  if (order.awaiting_finalization !== finished)
    data.awaiting_finalization = finished;
  if (Object.keys(data).length > 0) {
    await tx.order.update({ where: { id: orderId }, data });
  }
  return next;
}

/** A line counts as "occupying" its driver/car while it is active. */
const ACTIVE_LINE: ScheduleStatus[] = ['ASSIGNED', 'IN_PROGRESS'];

/**
 * Sync a driver's status from their lines.
 *  - ON_DUTY   while they have any ASSIGNED/IN_PROGRESS line.
 *  - AVAILABLE once all their lines are terminal (DONE/CANCELLED) or gone.
 * Never touches a driver flagged OFF (manual hard-down wins).
 */
export async function syncDriverStatus(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<void> {
  const driver = await tx.driver.findUnique({
    where: { id: driverId },
    select: { status: true },
  });
  if (!driver || driver.status === 'OFF') return;

  const activeCount = await tx.orderServiceItem.count({
    where: {
      driver_id: driverId,
      is_external: false,
      line_status: { in: ACTIVE_LINE },
    },
  });
  const next = activeCount > 0 ? 'ON_DUTY' : 'AVAILABLE';
  if (driver.status !== next) {
    await tx.driver.update({ where: { id: driverId }, data: { status: next } });
  }
}

/**
 * Sync a car's status from its lines.
 *  - IN_USE    while it has any ASSIGNED/IN_PROGRESS line.
 *  - AVAILABLE once all its lines are terminal or gone.
 * Never touches a car flagged MAINTENANCE (manual hard-down wins).
 */
export async function syncCarStatus(
  tx: Prisma.TransactionClient,
  carId: string,
): Promise<void> {
  const car = await tx.car.findUnique({
    where: { id: carId },
    select: { status: true },
  });
  if (!car || car.status === 'MAINTENANCE') return;

  const activeCount = await tx.orderServiceItem.count({
    where: {
      car_id: carId,
      is_external: false,
      line_status: { in: ACTIVE_LINE },
    },
  });
  const next = activeCount > 0 ? 'IN_USE' : 'AVAILABLE';
  if (car.status !== next) {
    await tx.car.update({ where: { id: carId }, data: { status: next } });
  }
}

/**
 * Derive the per-line journey timestamps from a line_status transition.
 * The line IS the trip, so:
 *  - IN_PROGRESS stamps trip_started_at (once, if not already set).
 *  - DONE stamps trip_finished_at.
 *  - SCHEDULED/back-to-unstarted clears both (a reset).
 * Returns only the fields that should change ({} = leave timestamps as-is).
 */
export function tripTimestampsForLine(
  next: ScheduleStatus,
  current: { trip_started_at: Date | null; trip_finished_at: Date | null },
  now: Date = new Date(),
): LineTimestampEffect {
  switch (next) {
    case 'IN_PROGRESS':
      return current.trip_started_at == null
        ? { trip_started_at: now }
        : {};
    case 'DONE':
      return {
        // backfill a start time if the line jumped straight to DONE
        ...(current.trip_started_at == null ? { trip_started_at: now } : {}),
        trip_finished_at: now,
      };
    case 'SCHEDULED':
      return { trip_started_at: null, trip_finished_at: null };
    default:
      // ASSIGNED / CANCELLED: leave existing timestamps untouched.
      return {};
  }
}
