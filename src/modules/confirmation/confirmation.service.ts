/**
 * #A1 / #A2 — Trip-team confirmation messaging service (2026-06-20).
 *
 * Sends WhatsApp messages for an assigned schedule line:
 *   - CUSTOMER "Data tim bertugas" (or UPDATE when reassigned after a send).
 *   - DRIVER  "Reminder Jadwal Perjalanan" (+ stand-down to the OLD driver).
 *
 * Manual mode (default) returns wa.me links for the admin to send (and pushes
 * the driver app); bot mode (WA_DELIVERY=bot) still goes through the wa-bot
 * internal `/internal/messages/send` endpoint (text only — no PDF). Double-send is prevented via per-line
 * confirmation_sent_at + confirmation_sent_snapshot (driver+car captured at
 * send time); a later reassignment is detected by comparing the snapshot.
 *
 * EXTERNAL (partner/rekanan) lines are supported too once the partner's
 * driver name (driver_name_raw) and a plate (plate_raw, or the chosen external
 * car's plate) are set: the customer gets the vendor driver + external car,
 * and the vendor driver gets the reminder by wa.me link / bot text only (no
 * push — vendor drivers do not use the driver app). Their snapshot is
 * { vendor_id, external_car_id, driver_name_raw, driver_phone_raw, plate_raw }.
 * The H-1 sweep and the same-day auto-send still skip external lines; the
 * admin sends those from the schedule with the manual button.
 */
import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  buildTripTeamCustomerCaption,
  buildTripTeamUpdateCustomerCaption,
  buildDriverReminderCaption,
  buildDriverStandDownCaption,
} from '../../utils/waCaptions';
import { waLink, waManual } from '../../utils/waManual';
import { pushToDriver } from '../../services/push.service';

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
    signal: AbortSignal.timeout(30000),
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
  external_vendor: true,
  external_car: true,
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

/**
 * Assignment captured at send time. Internal lines: { driver_id, car_id }
 * (unchanged shape, so existing snapshots stay valid). External lines:
 * { vendor_id, external_car_id, driver_name_raw, driver_phone_raw, plate_raw }.
 */
type SnapshotValue = Record<string, string | null>;
type Snapshot = SnapshotValue | null;

/** The line fields that decide its confirmation state. */
export interface ConfirmationLineFields {
  is_external?: boolean;
  driver_id: string | null;
  car_id: string | null;
  external_vendor_id?: string | null;
  external_car_id?: string | null;
  driver_name_raw?: string | null;
  driver_phone_raw?: string | null;
  plate_raw?: string | null;
}

function snapshotOf(line: ConfirmationLineFields): SnapshotValue {
  if (line.is_external) {
    return {
      vendor_id: line.external_vendor_id ?? null,
      external_car_id: line.external_car_id ?? null,
      driver_name_raw: line.driver_name_raw ?? null,
      driver_phone_raw: line.driver_phone_raw ?? null,
      plate_raw: line.plate_raw ?? null,
    };
  }
  return { driver_id: line.driver_id ?? null, car_id: line.car_id ?? null };
}

function snapshotChanged(current: SnapshotValue, snap: Snapshot): boolean {
  if (!snap) return false;
  // Compare across both shapes: an internal ↔ external switch is a change.
  const keys = new Set([...Object.keys(current), ...Object.keys(snap)]);
  for (const k of keys) {
    if ((current[k] ?? null) !== (snap[k] ?? null)) return true;
  }
  return false;
}

/** Derived confirmation state for the dashboard badge. */
export type ConfirmationState = 'NOT_SENT' | 'SENT' | 'CHANGED';

export function deriveState(
  line: ConfirmationLineFields & {
    confirmation_sent_at: Date | null;
    confirmation_sent_snapshot: unknown;
  },
): ConfirmationState {
  if (!line.confirmation_sent_at) return 'NOT_SENT';
  const snap = line.confirmation_sent_snapshot as Snapshot;
  if (snapshotChanged(snapshotOf(line), snap)) return 'CHANGED';
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

type LoadedLine = Awaited<ReturnType<typeof loadLine>>;

/** Who and what is serving the line, for internal and partner lines alike. */
interface TripTeam {
  external: boolean;
  /** Internal driver id (push / stand-down); null for partner drivers. */
  driver_id: string | null;
  driver_name: string;
  /** Shown to the customer and used as the reminder target. */
  driver_phone: string | null;
  car_plate: string;
  car_model: string;
}

/**
 * Ensure the line has a complete team (internal: driver + car; external:
 * vendor + partner driver name + a plate) and return it.
 */
function assertTeamAssigned(line: LoadedLine): TripTeam {
  if (!line.service_date)
    throw new AppError(
      'Tanggal layanan belum diisi (line has no service date)',
      400,
    );
  if (!line.is_external) {
    if (!line.driver || !line.car)
      throw new AppError(
        'Pilih driver dan mobil sebelum mengirim konfirmasi (assign a driver and a car before sending the confirmation)',
        400,
      );
    return {
      external: false,
      driver_id: line.driver.id,
      driver_name: line.driver.name,
      driver_phone: line.driver.phone,
      car_plate: line.car.plate_number,
      car_model: line.car.model,
    };
  }
  if (!line.external_vendor)
    throw new AppError(
      'Pilih rekanan (vendor) untuk trip ini dulu (choose the partner vendor first)',
      400,
    );
  const driverName = line.driver_name_raw?.trim();
  if (!driverName)
    throw new AppError(
      'Isi nama driver rekanan sebelum mengirim konfirmasi (enter the partner driver name before sending the confirmation)',
      400,
    );
  const plate = line.plate_raw?.trim() || line.external_car?.plate_number?.trim();
  if (!plate)
    throw new AppError(
      'Isi nopol unit rekanan atau pilih mobil rekanan yang punya nopol (enter the partner car plate, or choose a partner car that has one)',
      400,
    );
  return {
    external: true,
    driver_id: null,
    driver_name: driverName,
    driver_phone:
      line.driver_phone_raw?.trim() || line.external_vendor.phone?.trim() || null,
    car_plate: plate,
    car_model: line.external_car?.model ?? '-',
  };
}

async function resolvePrevSnapshotNames(snap: Snapshot) {
  if (!snap) return {};
  if ('vendor_id' in snap) {
    // Partner snapshot: names are stored raw; the plate may come from the car.
    const prevCar = snap.external_car_id
      ? await prisma.externalCar.findUnique({
          where: { id: snap.external_car_id },
          select: { plate_number: true, model: true },
        })
      : null;
    return {
      prev_driver_name: snap.driver_name_raw ?? null,
      prev_driver_phone: snap.driver_phone_raw ?? null,
      prev_car_plate: snap.plate_raw ?? prevCar?.plate_number ?? null,
      prev_car_model: prevCar?.model ?? null,
    };
  }
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
  customer: {
    sent: boolean;
    to?: string;
    message_id?: string | null;
    kind: 'NEW' | 'UPDATE';
    /** Manual mode: open this link to send the message from WhatsApp. */
    wa_url?: string;
  };
  /** Manual mode: wa_url messages drivers who don't have the app yet. */
  driver?: { sent: boolean; to?: string; message_id?: string | null; wa_url?: string };
  old_driver_standdown?: { sent: boolean; to?: string; wa_url?: string };
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
  const team = assertTeamAssigned(line);

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

  const order = line.order!;
  const teamCtx = {
    service_date: line.service_date!,
    driver_name: team.driver_name,
    driver_phone: team.driver_phone ?? '-',
    car_plate: team.car_plate,
    car_model: team.car_model,
  };

  // 1) CUSTOMER message
  const custText = isUpdate
    ? buildTripTeamUpdateCustomerCaption({
        ...teamCtx,
        prev_driver_name: (prev as any).prev_driver_name,
        prev_car_plate: (prev as any).prev_car_plate,
        prev_car_model: (prev as any).prev_car_model,
      })
    : buildTripTeamCustomerCaption(teamCtx);

  const manual = waManual();
  const custRes = manual
    ? { to: order.customer_phone, message_id: null }
    : await sendText(order.customer_phone, custText);

  // 2) OLD driver stand-down (only on reassignment, and only if the previous
  //    driver actually differs and previously got a reminder snapshot).
  let standdown: SendResult['old_driver_standdown'];
  if (isUpdate && oldSnap?.driver_id && oldSnap.driver_id !== team.driver_id) {
    const oldDriver = await prisma.driver.findUnique({
      where: { id: oldSnap.driver_id },
      select: { name: true, phone: true },
    });
    const sdText = buildDriverStandDownCaption({
      service_date: line.service_date!,
      pickup_at: line.start_at,
      driver_name: oldDriver?.name ?? '',
      pickup_location: line.pickup_location,
      dropoff_location: line.dropoff_location,
    });
    if (manual) {
      void pushToDriver(oldSnap.driver_id, {
        title: 'Tugas dialihkan',
        body: `Trip ${fmtDay(line.service_date!)} · ${line.pickup_location} tidak lagi untuk Anda.`,
        data: { type: 'trip_updated', line_id: lineId },
      });
      standdown = {
        sent: true,
        ...(oldDriver?.phone
          ? { to: oldDriver.phone, wa_url: waLink(oldDriver.phone, sdText) }
          : {}),
      };
    } else if (oldDriver?.phone) {
      try {
        const r = await sendText(oldDriver.phone, sdText);
        standdown = { sent: true, to: r.to };
      } catch {
        standdown = { sent: false };
      }
    }
  }

  // 2b) Previous PARTNER driver replaced (different phone): stand-down text
  //     only — vendor drivers have no app, so no push.
  const prevPartnerPhone = isUpdate ? oldSnap?.driver_phone_raw : null;
  if (
    !standdown &&
    prevPartnerPhone &&
    (!team.external || prevPartnerPhone !== team.driver_phone)
  ) {
    const sdText = buildDriverStandDownCaption({
      service_date: line.service_date!,
      pickup_at: line.start_at,
      driver_name: oldSnap?.driver_name_raw ?? '',
      pickup_location: line.pickup_location,
      dropoff_location: line.dropoff_location,
    });
    if (manual) {
      standdown = {
        sent: true,
        to: prevPartnerPhone,
        wa_url: waLink(prevPartnerPhone, sdText),
      };
    } else {
      try {
        const r = await sendText(prevPartnerPhone, sdText);
        standdown = { sent: true, to: r.to };
      } catch {
        standdown = { sent: false };
      }
    }
  }

  // 3) NEW driver reminder (push + wa.me link in manual mode; partner
  //    drivers get the link / bot text only)
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
      car_plate: team.car_plate,
      car_model: team.car_model,
      notes: line.notes,
      order_code: order.order_code,
    });
    const target = team.driver_phone;
    if (manual) {
      if (team.driver_id) {
        await pushToDriver(team.driver_id, {
          title: `Pengingat trip ${fmtDay(line.service_date!)}`,
          body: `${order.customer_name} · ${line.pickup_location} → ${line.dropoff_location}`,
          data: { type: 'trip_reminder', line_id: lineId },
        });
      }
      driverRes = target
        ? { sent: true, to: target, wa_url: waLink(target, drvText) }
        : // Partner without any phone (driver or vendor): nothing to open.
          { sent: false };
    } else if (target) {
      try {
        const r = await sendText(target, drvText);
        driverRes = { sent: true, to: r.to, message_id: r.message_id };
      } catch (e) {
        driverRes = { sent: false };
      }
    } else {
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
      ...(manual ? { wa_url: waLink(order.customer_phone, custText) } : {}),
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
    if (waManual()) {
      await remindDriverOnly(lineId);
      return;
    }
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
      line_status: { in: ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'] },
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
      if (waManual()) {
        // Customer confirmations wait for the admin; drivers get a push now.
        if (await remindDriverOnly(l.id)) {
          sent++;
          results.push({ line_id: l.id, ok: true });
        } else skipped++;
        continue;
      }
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

function fmtDay(d: Date): string {
  return new Date(d).toLocaleDateString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Manual mode: push the H-1 / same-day reminder to the assigned driver's app
 * (once per driver+car assignment). Returns true when a reminder was sent.
 */
export async function remindDriverOnly(lineId: string): Promise<boolean> {
  const line = await loadLine(lineId);
  if (!line.driver || !line.car || !line.order || !line.service_date) return false;
  const snap = snapshotOf(line);
  const prev = line.driver_reminder_snapshot as Snapshot;
  if (line.driver_reminder_sent_at && prev && !snapshotChanged(snap, prev)) return false;
  await pushToDriver(line.driver.id, {
    title: `Pengingat trip ${fmtDay(line.service_date)}`,
    body: `${line.order.customer_name} · ${line.pickup_location} → ${line.dropoff_location}`,
    data: { type: 'trip_reminder', line_id: lineId },
  });
  await prisma.orderServiceItem.update({
    where: { id: lineId },
    data: { driver_reminder_sent_at: new Date(), driver_reminder_snapshot: snap },
  });
  return true;
}
