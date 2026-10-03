/**
 * Driver ON_DUTY / car IN_USE depend on the date (a driver is on duty on the
 * WIB day of their trip, or while a trip is under way), so they change at
 * midnight without anything else happening. Every day edit and driver action
 * already updates the units it touches; this refresh catches the date turning
 * over (and any status left behind by a concurrent edit): once at startup,
 * then every 10 minutes. Idempotent: two conditional updates per table.
 *
 * Chosen over deriving the status on every read because driver.status and
 * car.status are read in many places (lists, forms, stock); a stored value
 * that is at most 10 minutes late after midnight keeps those reads unchanged.
 * Set RESOURCE_STATUS_REFRESH_ENABLED=false to turn it off.
 */
import prisma from '../../prisma/client';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { refreshCarStatuses, refreshDriverStatuses } from './order-derive.service';

const EVERY_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function refreshAllResourceStatuses(now: Date = new Date()) {
  const drivers = await refreshDriverStatuses(prisma, undefined, now);
  const cars = await refreshCarStatuses(prisma, undefined, now);
  return { drivers, cars };
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const r = await refreshAllResourceStatuses();
    if (r.drivers || r.cars)
      logger.info(r, `[resource-status] refreshed: ${r.drivers} driver(s), ${r.cars} car(s) changed`);
  } catch (e) {
    logger.error({ err: (e as Error).message }, '[resource-status] refresh failed');
  } finally {
    running = false;
  }
}

export function startResourceStatusRefresh(): void {
  if (!env.RESOURCE_STATUS_REFRESH_ENABLED) {
    logger.info('[resource-status] periodic refresh disabled (RESOURCE_STATUS_REFRESH_ENABLED=false)');
    return;
  }
  void runOnce();
  timer = setInterval(() => void runOnce(), EVERY_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopResourceStatusRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
