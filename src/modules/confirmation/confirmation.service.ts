/**
 * #A1 / #A2 — Trip-team confirmation messaging service (2026-06-20).
 *
 * Sends WhatsApp messages for an assigned schedule line:
 *   - CUSTOMER "Data tim bertugas" (or UPDATE when reassigned after a send).
 *   - DRIVER  "Reminder Jadwal Perjalanan" (+ stand-down to the OLD driver).
 *
 * Delivery is plumbed through the wa-bot internal `/internal/messages/send`
 * endpoint (text only — no PDF). Double-send is prevented via per-line
 * confirmation_sent_at + confirmation_sent_snapshot (driver+car captured at
 * send time); a later reassignment is detected by comparing the snapshot.
 */
import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  buildTripTeamCustomerCaption,
  buildTripTeamUpdateCustomerCaption,
  buildDriverReminderCaption,
  buildDriverStandDownCaption,
} from '../../utils/waCaptions';

// ── wa-bot internal transport (mirrors invoices.service) ────────────────────
function botBaseUrl(): string {
  return (
    process.env.ARASYA_WA_BOT_INTERNAL_URL ||
    process.env.WA_BOT_INTERNAL_URL ||
    'http://127.0.0.1:3015'
  ).replace(/\/+$/, '');
}
function botToken(): string {
  return (
    process.env.ARASYA_WA_BOT_INTERNAL_TOKEN ||
    process.env.WA_BOT_INTERNAL_TOKEN ||
    process.env.BOT_INTERNAL_TOKEN ||
    ''
  );
}

async function sendText(targetPhone: string, messageText: string) {
  const token = botToken();
  if (!token) throw new Error('WA bot internal token is not configured');
  if (!targetPhone) throw new Error('Target phone is missing');
  const res = await fetch(`${botBaseUrl()}/internal/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target_phone: targetPhone, message_text: messageText }),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok)
    throw new Error(
      payload?.message || payload?.error || payload?.raw || `WA bot HTTP ${res.status}`,
    );
  return payload as { message_id?: string | null; to?: string };
}

// ── Line loading + status derivation ────────────────────────────────────────
const lineInclude = {
  driver: true,
  car: true,
  order: {
    select: {
      id: true,
      order_code: true,
      customer_name: true,
      customer_phone: true,
      service_type: true,
      passenger_count: true,
    },
  },
} as const;

type Snapshot = { driver_id: string | null; car_id: string | null } | null;

function snapshotOf(line: { driver_id: string | null; car_id: string | null }): {
  driver_id: string | null;
  car_id: string | null;
} {
  return { driver_id: line.driver_id ?? null, car_id: line.car_id ?? null };
}

function snapshotChanged(
  current: { driver_id: string | null; car_id: string | null },
  snap: Snapshot,
): boolean {
  if (!snap) return false;
  return current.driver_id !== snap.driver_id || current.car_id !== snap.car_id;
}

/** Derived confirmation state for the dashboard badge. */
export type ConfirmationState = 'NOT_SENT' | 'SENT' | 'CHANGED';

export function deriveState(line: {
  driver_id: string | null;
  car_id: string | null;
  confirmation_sent_at: Date | null;
  confirmation_sent_snapshot: unknown;
}): ConfirmationState {
  if (!line.confirmation_sent_at) return 'NOT_SENT';
  const snap = line.confirmation_sent_snapshot as Snapshot;
  if (snapshotChanged({ driver_id: line.driver_id, car_id: line.car_id }, snap))
    return 'CHANGED';
  return 'SENT';
}

async function loadLine(lineId: string) {
  const line = await prisma.orderServiceItem.findUnique({
    where: { id: lineId },
    include: lineInclude,
  });
  if (!line) throw new AppError('Schedule line not found', 404);
  return line;
}

function assertAssignedInternal(line: {
  is_external: boolean;
  driver_id: string | null;
  car_id: string | null;
  service_date: Date | null;
}) {
  if (line.is_external)
    throw new AppError(
      'Trip-team confirmation is only for internal (own fleet) lines',
      400,
    );
  if (!line.driver_id || !line.car_id)
    throw new AppError(
      'Assign a driver and a car before sending the confirmation',
      400,
    );
  if (!line.service_date)
    throw new AppError('Line has no service date', 400);
}

async function resolvePrevSnapshotNames(snap: Snapshot) {
  if (!snap) return {};
  const [prevDriver, prevCar] = await Promise.all([
    snap.driver_id
      ? prisma.driver.findUnique({
          where: { id: snap.driver_id },
          select: { name: true, phone: true },
        })
      : Promise.resolve(null),
    snap.car_id
      ? prisma.car.findUnique({
          where: { id: snap.car_id },
          select: { plate_number: true, model: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    prev_driver_name: prevDriver?.name ?? null,
    prev_driver_phone: prevDriver?.phone ?? null,
    prev_car_plate: prevCar?.plate_number ?? null,
    prev_car_model: prevCar?.model ?? null,
  };
}

// ── Public: send CUSTOMER confirmation (or update) for a line ───────────────
export interface SendResult {
  line_id: string;
  customer: { sent: boolean; to?: string; message_id?: string | null; kind: 'NEW' | 'UPDATE' };
  driver?: { sent: boolean; to?: string; message_id?: string | null };
  old_driver_standdown?: { sent: boolean; to?: string };
  state: ConfirmationState;
}

/**
 * Send (or re-send as UPDATE) the customer trip-team message for a line, plus
 * the driver reminder. When reassigned after a previous send, also notifies
 * the OLD driver with a polite stand-down.
 *
 * @param opts.includeDriver  also send the #A2 driver reminder (default true)
 * @param opts.force          send even if nothing changed (manual re-send)
 */
export async function sendLineConfirmation(
  lineId: string,
  opts: { includeDriver?: boolean; force?: boolean } = {},
): Promise<SendResult> {
  const includeDriver = opts.includeDriver !== false;
  const line = await loadLine(lineId);
  assertAssignedInternal(line);

  const prevState = deriveState(line);
  if (prevState === 'SENT' && !opts.force) {
    throw new AppError(
      'Confirmation already sent for this assignment (nothing changed). Use force to re-send.',
      409,
    );
  }

  const isUpdate = prevState === 'CHANGED';
  const oldSnap = line.confirmation_sent_snapshot as Snapshot;
  const prev = isUpdate ? await resolvePrevSnapshotNames(oldSnap) : {};

  const driver = line.driver!;
  const car = line.car!;
  const order = line.order!;

  // 1) CUSTOMER message
  const custText = isUpdate
    ? buildTripTeamUpdateCustomerCaption({
        service_date: line.service_date!,
        driver_name: driver.name,
        driver_phone: driver.phone,
        car_plate: car.plate_number,
        car_model: car.model,
        prev_driver_name: (prev as any).prev_driver_name,
        prev_car_plate: (prev as any).prev_car_plate,
        prev_car_model: (prev as any).prev_car_model,
      })
    : buildTripTeamCustomerCaption({
        service_date: line.service_date!,
        driver_name: driver.name,
        driver_phone: driver.phone,
        car_plate: car.plate_number,
        car_model: car.model,
      });

  const custRes = await sendText(order.customer_phone, custText);

  // 2) OLD driver stand-down (only on reassignment, and only if the previous
  //    driver actually differs and previously got a reminder snapshot).
  let standdown: { sent: boolean; to?: string } | undefined;
  if (isUpdate && oldSnap?.driver_id && oldSnap.driver_id !== driver.id) {
    const oldDriver = await prisma.driver.findUnique({
      where: { id: oldSnap.driver_id },
      select: { name: true, phone: true },
    });
    if (oldDriver?.phone) {
      const sdText = buildDriverStandDownCaption({
        service_date: line.service_date!,
        pickup_at: line.start_at,
        driver_name: oldDriver.name,
        pickup_location: line.pickup_location,
        dropoff_location: line.dropoff_location,
      });
      try {
        const r = await sendText(oldDriver.phone, sdText);
        standdown = { sent: true, to: r.to };
      } catch {
        standdown = { sent: false };
      }
    }
  }

  // 3) NEW driver reminder
  let driverRes: SendResult['driver'];
  if (includeDriver) {
    const drvText = buildDriverReminderCaption({
      service_date: line.service_date!,
      pickup_at: line.start_at,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      pickup_location: line.pickup_location,
      dropoff_location: line.dropoff_location,
      service_type: order.service_type,
      passenger_count: order.passenger_count,
      car_plate: car.plate_number,
      car_model: car.model,
      notes: line.notes,
      order_code: order.order_code,
    });
    try {
      const r = await sendText(driver.phone, drvText);
      driverRes = { sent: true, to: r.to, message_id: r.message_id };
    } catch (e) {
      driverRes = { sent: false };
    }
  }

  // 4) Persist sent markers + snapshot (only after the CUSTOMER message — the
  //    canonical "confirmation" — succeeded).
  const snap = snapshotOf(line);
  const now = new Date();
  await prisma.orderServiceItem.update({
    where: { id: lineId },
    data: {
      confirmation_sent_at: now,
      confirmation_sent_snapshot: snap,
      ...(driverRes?.sent
        ? { driver_reminder_sent_at: now, driver_reminder_snapshot: snap }
        : {}),
    },
  });

  return {
    line_id: lineId,
    customer: {
      sent: true,
      to: custRes.to,
      message_id: custRes.message_id,
      kind: isUpdate ? 'UPDATE' : 'NEW',
    },
    driver: driverRes,
    old_driver_standdown: standdown,
    state: 'SENT',
  };
}

/**
 * Auto-send hook for the assign flow: send immediately ONLY when the line's
 * service date is TODAY (WIB) and it's freshly assigned/changed. Never throws
 * into the assign transaction — failures are swallowed (manual button remains).
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
function isSameWibDay(a: Date, b: Date): boolean {
  const ja = new Date(a.getTime() + WIB_OFFSET_MS);
  const jb = new Date(b.getTime() + WIB_OFFSET_MS);
  return (
    ja.getUTCFullYear() === jb.getUTCFullYear() &&
    ja.getUTCMonth() === jb.getUTCMonth() &&
    ja.getUTCDate() === jb.getUTCDate()
  );
}

export async function maybeAutoSendOnAssign(lineId: string): Promise<void> {
  try {
    const line = await prisma.orderServiceItem.findUnique({
      where: { id: lineId },
      select: {
        is_external: true,
        driver_id: true,
        car_id: true,
        service_date: true,
        confirmation_sent_at: true,
        confirmation_sent_snapshot: true,
      },
    });
    if (!line || line.is_external || !line.driver_id || !line.car_id) return;
    if (!line.service_date) return;
    if (!isSameWibDay(line.service_date, new Date())) return; // same-day only
    const state = deriveState({
      driver_id: line.driver_id,
      car_id: line.car_id,
      confirmation_sent_at: line.confirmation_sent_at,
      confirmation_sent_snapshot: line.confirmation_sent_snapshot,
    });
    if (state === 'SENT') return; // already current
    await sendLineConfirmation(lineId, { includeDriver: true, force: state === 'CHANGED' });
  } catch (e) {
    // Best-effort: never break assignment. The manual button can retry.
    // eslint-disable-next-line no-console
    console.error('[confirmation] auto-send on assign failed:', (e as Error).message);
  }
}

/**
 * H-1 cron worker: send confirmations for all eligible INTERNAL lines whose
 * service_date is TOMORROW (WIB) and not yet sent (or changed). Returns a small
 * summary. Idempotent — skips lines already in SENT state.
 */
export async function runDailyConfirmationSweep(now: Date = new Date()): Promise<{
  date_wib: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  results: { line_id: string; ok: boolean; error?: string }[];
}> {
  // Tomorrow (WIB) day-bounds expressed in UTC.
  const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
  const y = wibNow.getUTCFullYear();
  const m = wibNow.getUTCMonth();
  const d = wibNow.getUTCDate() + 1; // tomorrow
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - WIB_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const lines = await prisma.orderServiceItem.findMany({
    where: {
      is_external: false,
      driver_id: { not: null },
      car_id: { not: null },
      line_status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      service_date: { gte: start, lte: end },
    },
    select: {
      id: true,
      driver_id: true,
      car_id: true,
      confirmation_sent_at: true,
      confirmation_sent_snapshot: true,
    },
  });

  const results: { line_id: string; ok: boolean; error?: string }[] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const l of lines) {
    const state = deriveState({
      driver_id: l.driver_id,
      car_id: l.car_id,
      confirmation_sent_at: l.confirmation_sent_at,
      confirmation_sent_snapshot: l.confirmation_sent_snapshot,
    });
    if (state === 'SENT') {
      skipped++;
      continue;
    }
    try {
      await sendLineConfirmation(l.id, {
        includeDriver: true,
        force: state === 'CHANGED',
      });
      sent++;
      results.push({ line_id: l.id, ok: true });
    } catch (e) {
      failed++;
      results.push({ line_id: l.id, ok: false, error: (e as Error).message });
    }
  }

  return {
    date_wib: new Date(start.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10),
    total: lines.length,
    sent,
    skipped,
    failed,
    results,
  };
}
