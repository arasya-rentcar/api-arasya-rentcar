import type { Prisma, ScheduleStatus } from '@prisma/client';
import { AppError } from '../../utils/AppError';
import { wibShortDay, wibStartOfDay } from '../../utils/wib';

/**
 * Can a driver / car take these days? (owner, Oct 2026: one rule for per-day
 * assign, "Tetapkan untuk Semua" and "Ganti Semua").
 *
 * Availability is by date and time, never by Driver.status / Car.status:
 * ON_DUTY / IN_USE only say what the unit does today, so a driver booked for
 * next week is free tomorrow. A unit is taken when another open day
 * (SCHEDULED / ASSIGNED / IN_PROGRESS) of it overlaps one of the days. OFF and
 * MAINTENANCE are manual "not on the road" flags and still refuse.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN: ScheduleStatus[] = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'];

export interface DayTimes {
  id: string;
  service_date: Date | null;
  start_at: Date | null;
  end_at: Date | null;
}

/**
 * The time a day holds its driver and car: pickup to end when both are set,
 * otherwise its whole WIB calendar day. Null when the day has no date at all.
 */
export function dayWindow(d: Omit<DayTimes, 'id'>): [number, number] | null {
  if (d.start_at && d.end_at && d.end_at.getTime() > d.start_at.getTime())
    return [d.start_at.getTime(), d.end_at.getTime()];
  const anchor = d.service_date ?? d.start_at;
  if (!anchor) return null;
  const s = wibStartOfDay(anchor).getTime();
  return [s, s + DAY_MS];
}

const wibTime = (d: Date) =>
  d.toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "6 Okt 08.00–20.00" (or "6 Okt" without times), for messages. */
function when(d: Omit<DayTimes, 'id'>): string {
  const day = wibShortDay(d.service_date ?? d.start_at);
  return d.start_at && d.end_at
    ? `${day} ${wibTime(d.start_at)}–${wibTime(d.end_at)}`
    : day;
}

async function firstClash(
  db: Prisma.TransactionClient,
  unit: { driver_id: string } | { car_id: string },
  days: DayTimes[],
) {
  const wins = days
    .map((d) => dayWindow(d))
    .filter((w): w is [number, number] => !!w);
  if (wins.length === 0) return null;
  // Days are single calendar days (an overnight trip ends the next day), so
  // two days of margin around the range finds every candidate.
  const lo = new Date(Math.min(...wins.map((w) => w[0])) - 2 * DAY_MS);
  const hi = new Date(Math.max(...wins.map((w) => w[1])) + 2 * DAY_MS);
  const others = await db.orderServiceItem.findMany({
    where: {
      ...unit,
      is_external: false,
      line_status: { in: OPEN },
      id: { notIn: days.map((d) => d.id) },
      OR: [
        { service_date: { gte: lo, lte: hi } },
        { start_at: { gte: lo, lte: hi } },
      ],
    },
    select: {
      id: true,
      service_date: true,
      start_at: true,
      end_at: true,
      order: { select: { order_code: true } },
    },
    orderBy: [{ service_date: 'asc' }, { start_at: 'asc' }],
  });
  for (const o of others) {
    const ow = dayWindow(o);
    if (!ow) continue;
    if (wins.some((w) => w[0] < ow[1] && ow[0] < w[1])) return o;
  }
  return null;
}

/**
 * Refuse (409, Indonesian message) when the driver or car is flagged OFF /
 * MAINTENANCE or already has another open day overlapping `days`. Pass only
 * the units being newly given to these days (re-saving the same driver never
 * fails on an old double booking).
 */
export async function assertUnitsFree(
  db: Prisma.TransactionClient,
  units: {
    driver?: { id: string; name: string; status: string } | null;
    car?: { id: string; plate_number: string; status: string } | null;
  },
  days: DayTimes[],
): Promise<void> {
  const { driver, car } = units;
  if (driver?.status === 'OFF')
    throw new AppError(
      `Driver ${driver.name} berstatus OFF (tidak aktif). Ubah statusnya di menu Driver dulu bila ia bisa bertugas.`,
      409,
    );
  if (car?.status === 'MAINTENANCE')
    throw new AppError(
      `Mobil ${car.plate_number} sedang MAINTENANCE. Ubah statusnya di menu Mobil dulu bila sudah bisa dipakai.`,
      409,
    );
  if (driver) {
    const c = await firstClash(db, { driver_id: driver.id }, days);
    if (c)
      throw new AppError(
        `Driver ${driver.name} sudah ada tugas lain di waktu yang sama (${c.order?.order_code ?? 'order lain'}, ${when(c)}). Pilih driver lain atau ubah jadwalnya.`,
        409,
      );
  }
  if (car) {
    const c = await firstClash(db, { car_id: car.id }, days);
    if (c)
      throw new AppError(
        `Mobil ${car.plate_number} sudah dipakai di waktu yang sama (${c.order?.order_code ?? 'order lain'}, ${when(c)}). Pilih mobil lain atau ubah jadwalnya.`,
        409,
      );
  }
}
