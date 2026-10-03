import { Prisma, ScheduleStatus } from "@prisma/client";
import { billedToCustomerByPackage } from "../../utils/driverFee";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  deriveAndSetOrderStatus,
  syncCarStatus,
  syncDriverStatus,
} from "../schedule/order-derive.service";
import { refreshOrderSummary } from "../bot/bot.service";
import { pushToAdmins } from "../../services/push.service";
import { notifyTripEvent, notifyTripReport } from "../../services/adminNotify";
import { env } from "../../config/env";
import {
  uploadFile,
  assertValidUpload,
  type UploadedFile,
} from "../../services/storage.service";
import type { ActionInput, ReportInput } from "./driver-app.validation";
import { staleTripCutoff } from "../../utils/wib";
import { stampPhoto } from "../../utils/photoStamp";
import { logger } from "../../config/logger";
import {
  assertOrderPaidForTripStart,
  startPayment,
  startPaymentSelect,
} from "../orders/assignment-guard";

/**
 * Driver app: everything a driver does on their own trips (service-day lines
 * assigned to them). Transitions mirror the WhatsApp bot so the dashboard
 * shows the same statuses and timestamps, but act on an explicit line id.
 */

// Same public bucket as invoice PDFs, so report photos open from the
// dashboard like the bot's report media.
const TRIP_BUCKET = env.SUPABASE_STORAGE_BUCKET;
const COST_TYPES: Record<string, "FUEL" | "TOLL" | "PARKING" | "OTHER"> = {
  FUEL: "FUEL",
  TOLL: "TOLL",
  PARKING: "PARKING",
  OTHER_COST: "OTHER",
};

export async function driverForUser(userId: string) {
  const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
  if (!driver) throw new AppError("Driver profile not found for this account", 403);
  return driver;
}

// Rows written by the trip actions themselves (app applyOnce or the bot), not
// sent by the driver; the app may hide them in the report list.
const SYSTEM_REPORTS = ["START", "ARRIVE_CUSTOMER", "ONBOARD", "FINISH", "DROP"];

const tripInclude = {
  car: { select: { plate_number: true, model: true } },
  order: {
    select: {
      id: true,
      order_code: true,
      customer_name: true,
      customer_phone: true,
      notes: true,
      passenger_count: true,
      customers: { select: { name: true, phone: true, is_primary: true } },
      // Paid in full? (the driver sees only yes/no, never amounts)
      ...startPaymentSelect,
    },
  },
  // Only what the driver sent (photos, receipts, notes), not the system rows.
  _count: { select: { reports: { where: { report_type: { notIn: SYSTEM_REPORTS } } } } },
} satisfies Prisma.OrderServiceItemInclude;

type LineWithTrip = Prisma.OrderServiceItemGetPayload<{ include: typeof tripInclude }>;

function toTrip(l: LineWithTrip) {
  const others = l.order.customers.filter((c) => !c.is_primary);
  return {
    id: l.id,
    order_id: l.order_id,
    order_code: l.order.order_code,
    status: l.line_status,
    accepted_at: l.driver_accepted_at,
    service_date: l.service_date,
    start_at: l.start_at,
    end_at: l.end_at,
    pickup_location: l.pickup_location,
    dropoff_location: l.dropoff_location,
    service_kind: l.service_kind,
    service_package: l.service_package,
    notes: l.notes,
    order_notes: l.order.notes,
    passenger_count: l.order.passenger_count,
    customer: { name: l.order.customer_name, phone: l.order.customer_phone || null },
    other_customers: others.map((c) => ({ name: c.name, phone: c.phone })),
    car: l.car,
    actual_start_at: l.actual_start_at,
    actual_pickup_at: l.actual_pickup_at,
    customer_onboard_at: l.customer_onboard_at,
    trip_finished_at: l.trip_finished_at,
    report_count: l._count.reports,
    // Owner rule: the trip with the customer ("Mulai perjalanan") may begin only
    // once the order is paid in full. Driving to the pickup is always allowed.
    payment_ready: startPayment(l.order, l.order.service_items).ready,
  };
}

/** The driver's own internal line, or 404 (also when reassigned away). */
async function ownLine(driverId: string, lineId: string) {
  const line = await prisma.orderServiceItem.findFirst({
    where: { id: lineId, driver_id: driverId, is_external: false },
    include: tripInclude,
  });
  if (!line) throw new AppError("Trip not found", 404);
  return line;
}

/**
 * "Tugas" (active): trips from yesterday (WIB) onward that are not finished,
 * plus any trip already IN_PROGRESS whatever its date (the driver must be able
 * to finish it). Older open trips are left for the admin to close from the
 * dashboard ("Belum ditutup"): listing them first made drivers press buttons on
 * a months-old trip. Order: the trip under way first, then the nearest.
 */
export async function listTrips(driverId: string, scope: "active" | "history") {
  if (scope === "active") {
    const cutoff = staleTripCutoff();
    const lines = await prisma.orderServiceItem.findMany({
      where: {
        driver_id: driverId,
        is_external: false,
        OR: [
          { line_status: "IN_PROGRESS" },
          {
            line_status: { in: ["SCHEDULED", "ASSIGNED"] },
            OR: [
              { service_date: { gte: cutoff } },
              { service_date: null, start_at: { gte: cutoff } },
            ],
          },
        ],
      },
      include: tripInclude,
      orderBy: [{ service_date: "asc" }, { start_at: "asc" }, { sort_order: "asc" }],
      take: 100,
    });
    const underway = lines.filter((l) => l.line_status === "IN_PROGRESS");
    const upcoming = lines.filter((l) => l.line_status !== "IN_PROGRESS");
    return [...underway, ...upcoming].map(toTrip);
  }
  const lines = await prisma.orderServiceItem.findMany({
    where: {
      driver_id: driverId,
      is_external: false,
      line_status: "DONE",
      trip_finished_at: { gte: new Date(Date.now() - 60 * 86400000) },
    },
    include: tripInclude,
    orderBy: [{ trip_finished_at: "desc" }],
    take: 50,
  });
  return lines.map(toTrip);
}

export async function getTrip(driverId: string, lineId: string) {
  const line = await ownLine(driverId, lineId);
  const [reports, expenses] = await Promise.all([
    prisma.tripReport.findMany({
      where: { order_service_item_id: lineId },
      orderBy: { created_at: "asc" },
    }),
    prisma.expense.findMany({
      where: { order_service_item_id: lineId },
      orderBy: { created_at: "asc" },
    }),
  ]);
  return {
    ...toTrip(line),
    reports: reports.map(toReport),
    expenses: expenses.map((e) => ({
      id: e.id,
      type: e.type,
      amount: Number(e.amount),
      note: e.note,
      // PENDING until the office checks the receipt; review_note says why a
      // cost was rejected.
      status: e.status,
      review_note: e.review_note,
      created_at: e.created_at,
    })),
  };
}

function toReport(r: Prisma.TripReportGetPayload<object>) {
  return {
    id: r.id,
    report_type: r.report_type,
    notes: r.notes,
    file_url: r.file_url,
    amount: r.amount == null ? null : Number(r.amount),
    created_at: r.created_at,
    is_system: SYSTEM_REPORTS.includes(r.report_type),
    latitude: r.latitude,
    longitude: r.longitude,
    location_accuracy_m: r.location_accuracy_m,
    location_name: r.location_name,
  };
}

type LocationInput = Pick<
  ActionInput,
  "latitude" | "longitude" | "location_accuracy_m" | "location_at" | "location_mocked" | "location_name"
>;

/** GPS fix fields for a trip_reports row (all null when the phone sent none). */
function locationData(loc: LocationInput = {}) {
  const name = loc.location_name ? { location_name: loc.location_name } : {};
  if (loc.latitude == null || loc.longitude == null) return name;
  return {
    ...name,
    latitude: loc.latitude,
    longitude: loc.longitude,
    location_accuracy_m: loc.location_accuracy_m ?? null,
    location_at: loc.location_at ? eventTime(loc.location_at) : null,
    location_mocked: loc.location_mocked ?? null,
  };
}

/** Paid-in-full rule for beginning the trip with the customer (see boardTrip). */
async function assertPaidToBoard(line: LineWithTrip, clientRef?: string) {
  if (line.customer_onboard_at || (await alreadyApplied(clientRef))) return;
  assertOrderPaidForTripStart(startPayment(line.order, line.order.service_items));
}

const TERMINAL: ScheduleStatus[] = ["DONE", "CANCELLED"];

/**
 * The time to record for an action: the phone's own timestamp (actions made
 * offline arrive later), bounded to the last 7 days and never in the future,
 * so a wrong phone clock cannot push records far off.
 */
export function eventTime(occurredAt?: string): Date {
  const now = Date.now();
  const t = occurredAt ? Date.parse(occurredAt) : NaN;
  if (!Number.isFinite(t)) return new Date(now);
  return new Date(Math.min(now, Math.max(t, now - 7 * 86400000)));
}

export async function acceptTrip(driverId: string, lineId: string, occurredAt?: string) {
  const line = await ownLine(driverId, lineId);
  if (line.line_status === "CANCELLED") throw new AppError("Trip was cancelled", 409);
  const applied = await applyOnce(line, driverId, {
    guard: { driver_accepted_at: null, line_status: { not: "CANCELLED" } },
    data: { driver_accepted_at: eventTime(occurredAt) },
  });
  if (applied) await notifyTripEvent("TRIP_ACCEPTED", lineId);
  return toTrip(await ownLine(driverId, lineId));
}

/** Depart the garage: IN_PROGRESS + journey timestamps, like the bot's #start. */
export async function startTrip(driverId: string, lineId: string, opts: ActionOpts = {}) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  const now = eventTime(opts.occurredAt);
  const applied = await applyOnce(line, driverId, {
    guard: { line_status: { in: ["SCHEDULED", "ASSIGNED"] } },
    data: {
      line_status: "IN_PROGRESS",
      driver_accepted_at: line.driver_accepted_at ?? now,
      ...(line.trip_started_at ? {} : { trip_started_at: now }),
      ...(line.actual_start_at ? {} : { actual_start_at: now }),
    },
    derive: true,
    report: { type: "START", notes: "Berangkat (aplikasi driver)", at: now, clientRef: opts.clientRef },
  });
  if (applied) {
    await notifyTripEvent("TRIP_STARTED", lineId);
    await refreshOrderSummary(line.order_id);
    void pushToAdmins({
      title: `Driver berangkat · ${line.order.order_code ?? ""}`.trim(),
      body: `${line.order.customer_name} · ${line.pickup_location}`,
      data: { type: "trip_started", line_id: lineId, order_id: line.order_id },
    });
  }
  return toTrip(await ownLine(driverId, lineId));
}

/**
 * Arrived at the pickup point. The app sends the phone's GPS fix with it (and
 * an ARRIVAL_PHOTO report), kept on the ARRIVE_CUSTOMER row for the office.
 */
export async function arriveTrip(
  driverId: string,
  lineId: string,
  opts: ActionOpts & { location?: LocationInput } = {},
) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  const now = eventTime(opts.occurredAt);
  const applied = await applyOnce(line, driverId, {
    guard: { actual_pickup_at: null, line_status: { notIn: TERMINAL } },
    data: { actual_pickup_at: now, driver_accepted_at: line.driver_accepted_at ?? now },
    report: {
      type: "ARRIVE_CUSTOMER",
      notes: "Tiba di lokasi jemput (aplikasi driver)",
      at: now,
      clientRef: opts.clientRef,
      location: opts.location,
    },
  });
  if (applied) await notifyTripEvent("TRIP_ARRIVED", lineId, opts.location?.location_name);
  return toTrip(await ownLine(driverId, lineId));
}

/**
 * The customer got in: the trip with them begins ("Mulai perjalanan"). Owner
 * rule (3 Oct 2026): only when the order is paid in full; the driver may drive
 * to the pickup and record the arrival before that. A driver who skipped
 * "Berangkat" is marked departed now as well.
 */
export async function boardTrip(driverId: string, lineId: string, opts: ActionOpts = {}) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  await assertPaidToBoard(line, opts.clientRef);
  const now = eventTime(opts.occurredAt);
  const applied = await applyOnce(line, driverId, {
    guard: { customer_onboard_at: null, line_status: { notIn: TERMINAL } },
    data: {
      customer_onboard_at: now,
      line_status: "IN_PROGRESS",
      driver_accepted_at: line.driver_accepted_at ?? now,
      ...(line.trip_started_at ? {} : { trip_started_at: now }),
      ...(line.actual_start_at ? {} : { actual_start_at: now }),
    },
    derive: line.line_status !== "IN_PROGRESS",
    report: {
      type: "ONBOARD",
      notes: "Pelanggan naik, perjalanan dimulai (aplikasi driver)",
      at: now,
      clientRef: opts.clientRef,
    },
  });
  if (applied) await notifyTripEvent("TRIP_BOARDED", lineId);
  return toTrip(await ownLine(driverId, lineId));
}

/** Drop-off / done, like the bot's #finish (order then awaits finalization). */
export async function finishTrip(
  driverId: string,
  lineId: string,
  opts: ActionOpts & { notes?: string } = {},
) {
  const line = await ownLine(driverId, lineId);
  if (line.line_status === "CANCELLED") throw new AppError("Trip was cancelled", 409);
  // Finishing a trip the customer never "boarded" in the app (older app
  // versions have no such step) needs the same full payment. A finish on a
  // day already closed stays a no-op.
  if (line.line_status !== "DONE") await assertPaidToBoard(line, opts.clientRef);
  const now = eventTime(opts.occurredAt);
  const applied = await applyOnce(line, driverId, {
    guard: { line_status: { in: ["SCHEDULED", "ASSIGNED", "IN_PROGRESS"] } },
    data: {
      line_status: "DONE",
      driver_accepted_at: line.driver_accepted_at ?? now,
      ...(line.trip_started_at ? {} : { trip_started_at: now }),
      trip_finished_at: now,
      // When the finish reached the server (may be later than the drop-off).
      finish_reported_at: new Date(),
    },
    derive: true,
    report: {
      type: "FINISH",
      notes: opts.notes?.trim() || "Selesai (aplikasi driver)",
      at: now,
      clientRef: opts.clientRef,
    },
  });
  if (applied) {
    await notifyTripEvent("TRIP_FINISHED", lineId);
    await refreshOrderSummary(line.order_id);
    void pushToAdmins({
      title: `Trip selesai · ${line.order.order_code ?? ""}`.trim(),
      body: `${line.order.customer_name} · ${line.dropoff_location}`,
      data: { type: "trip_finished", line_id: lineId, order_id: line.order_id },
    });
  }
  return toTrip(await ownLine(driverId, lineId));
}

export interface ActionOpts {
  occurredAt?: string;
  /** Idempotency key from the phone (the queued item's id). */
  clientRef?: string;
}

/** A resend of an action the server already recorded (answered as a no-op). */
async function alreadyApplied(clientRef?: string) {
  return !!clientRef && !!(await prisma.tripReport.findUnique({ where: { client_ref: clientRef } }));
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Apply a trip action exactly once, even when the phone resends it (lost
 * response, background + foreground sync) or two copies arrive at the same
 * moment:
 *  - an action whose client_ref is already stored is a no-op;
 *  - the line update is conditional (`guard`), so a concurrent duplicate
 *    matches no row once the first one commits;
 *  - the action's report row carries the client_ref (unique), and is written
 *    in the same transaction, so it cannot be recorded twice either.
 * Returns true only for the request that actually applied the change.
 */
async function applyOnce(
  line: LineWithTrip,
  driverId: string,
  step: {
    guard: Prisma.OrderServiceItemWhereInput;
    data: Prisma.OrderServiceItemUncheckedUpdateManyInput;
    derive?: boolean;
    report?: {
      type: string;
      notes: string;
      at: Date;
      clientRef?: string;
      location?: LocationInput;
    };
  },
): Promise<boolean> {
  const clientRef = step.report?.clientRef;
  if (clientRef && (await prisma.tripReport.findUnique({ where: { client_ref: clientRef } }))) {
    return false;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.orderServiceItem.updateMany({
        where: { id: line.id, driver_id: driverId, ...step.guard },
        data: step.data,
      });
      if (count === 0) return false;
      if (step.report) {
        await tx.tripReport.create({
          data: {
            order_id: line.order_id,
            order_service_item_id: line.id,
            order_code: line.order.order_code,
            driver_id: driverId,
            report_type: step.report.type,
            input_type: "TEXT",
            notes: step.report.notes,
            match_method: "driver app",
            source: "API",
            status: "MATCHED",
            created_at: step.report.at,
            client_ref: clientRef ?? null,
            ...locationData(step.report.location),
          },
        });
      }
      if (step.derive) {
        await deriveAndSetOrderStatus(tx, line.order_id);
        if (line.driver_id) await syncDriverStatus(tx, line.driver_id);
        if (line.car_id) await syncCarStatus(tx, line.car_id);
      }
      return true;
    }, { maxWait: 15000, timeout: 30000 });
  } catch (err) {
    if (isUniqueViolation(err)) return false; // the same action won a race
    throw err;
  }
}

/**
 * Photo / receipt / note from the app. Idempotent on client_ref (the phone
 * retries uploads after a lost connection). Costs also become Expense rows on
 * the line, waiting for admin review; approved ones feed the day's costs, the
 * driver's reimbursement and (per package) the customer's extra charges.
 */
export async function addReport(
  driverId: string,
  lineId: string,
  input: ReportInput,
  photo?: UploadedFile,
) {
  const existing = await prisma.tripReport.findUnique({ where: { client_ref: input.client_ref } });
  if (existing) {
    if (existing.order_service_item_id !== lineId) throw new AppError("client_ref already used", 409);
    return toReport(existing);
  }
  const line = await ownLine(driverId, lineId);
  if (line.line_status === "CANCELLED") throw new AppError("Trip was cancelled", 409);

  const costType = COST_TYPES[input.report_type];
  // amount = rupiah for cost receipts, or the km reading for odometer photos.
  const isOdometer = input.report_type.startsWith("ODOMETER");
  const amount = (costType || isOdometer) && input.amount ? input.amount : null;
  if (isOdometer) await assertOdometerOrder(lineId, input.report_type, amount, !!photo);
  const isArrival = input.report_type === "ARRIVAL_PHOTO";
  if (isArrival && (!photo || input.latitude == null)) {
    throw new AppError("Foto sampai lokasi perlu foto dan lokasi GPS.", 400);
  }

  let fileUrl: string | null = null;
  let fileMime: string | null = null;
  if (photo) {
    let file = assertValidUpload(photo);
    // Older apps send a plain photo: the server adds the stamp. The GPS camera
    // in newer apps stamps on the phone (stamped=true), so it is not doubled.
    if (isArrival && !input.stamped) file = await stampArrival(file, line, driverId, input);
    const up = await uploadFile(file, {
      bucket: TRIP_BUCKET,
      prefix: `trip-reports/${lineId}`,
      public: true,
    });
    fileUrl = up.publicUrl;
    fileMime = file.mimetype;
  }

  const at = eventTime(input.occurred_at);
  let report;
  let expense: { id: string; type: string; amount: number; bill_to_customer: boolean } | null = null;
  try {
    report = await prisma.$transaction(async (tx) => {
    const r = await tx.tripReport.create({
      data: {
        order_id: line.order_id,
        order_service_item_id: lineId,
        order_code: line.order.order_code,
        driver_id: driverId,
        report_type: input.report_type,
        input_type: photo ? (input.notes ? "MIXED" : "IMAGE") : "TEXT",
        notes: input.notes ?? null,
        file_url: fileUrl,
        file_mime: fileMime,
        amount,
        client_ref: input.client_ref,
        match_method: "driver app",
        source: "API",
        status: "MATCHED",
        created_at: at,
        ...locationData(input),
      },
    });
    if (costType && amount) {
      // Waits for the admin to check the receipt (PENDING). The driver paid it
      // (own money or uang jalan); X Parkir / X Ops costs go to the customer.
      const e = await tx.expense.create({
        data: {
          order_service_item_id: lineId,
          type: costType,
          amount,
          note: input.notes ?? null,
          created_at: at,
          status: "PENDING",
          paid_by: "DRIVER",
          bill_to_customer: billedToCustomerByPackage(line.service_package, costType),
          trip_report_id: r.id,
        },
      });
      expense = { id: e.id, type: e.type, amount: Number(e.amount), bill_to_customer: e.bill_to_customer };
    }
    return r;
    });
  } catch (err) {
    // Two copies of the same upload at once: the other one was stored.
    if (!isUniqueViolation(err)) throw err;
    const stored = await prisma.tripReport.findUnique({ where: { client_ref: input.client_ref } });
    if (!stored) throw err;
    return toReport(stored);
  }
  // Only the request that stored the report gets here (resends returned above).
  await notifyTripReport(
    lineId,
    {
      report_type: report.report_type,
      notes: report.notes,
      amount: report.amount == null ? null : Number(report.amount),
      location_name: report.location_name,
    },
    expense,
  );
  await refreshOrderSummary(line.order_id);
  return toReport(report);
}

/**
 * Odometer photos come in order: one start reading, then one end reading that
 * is not lower. The app enforces the same; this keeps resends from another
 * phone or an old app version honest.
 */
async function assertOdometerOrder(
  lineId: string,
  type: string,
  km: number | null,
  hasPhoto: boolean,
) {
  if (!hasPhoto || km == null) {
    throw new AppError("Foto odometer perlu foto dan angka kilometer.", 400);
  }
  const sent = await prisma.tripReport.findMany({
    where: { order_service_item_id: lineId, report_type: { in: ["ODOMETER_START", "ODOMETER_END"] } },
    select: { report_type: true, amount: true },
  });
  const start = sent.find((r) => r.report_type === "ODOMETER_START");
  if (type === "ODOMETER_START") {
    if (start) throw new AppError("Foto odometer awal sudah terkirim untuk tugas ini.", 409);
    return;
  }
  if (!start) throw new AppError("Kirim foto odometer awal dulu, baru odometer akhir.", 409);
  if (sent.some((r) => r.report_type === "ODOMETER_END")) {
    throw new AppError("Foto odometer akhir sudah terkirim untuk tugas ini.", 409);
  }
  if (start.amount != null && km < Number(start.amount)) {
    throw new AppError(
      `Angka odometer akhir (${km} km) lebih kecil dari odometer awal (${Number(start.amount)} km).`,
      409,
    );
  }
}

const WIB_STAMP: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Jakarta",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/**
 * Burns driver, order, WIB time and GPS fix into the arrival photo. If the
 * photo cannot be decoded it is stored as sent (the GPS fix is on the row
 * anyway), so a driver is never blocked by it.
 */
async function stampArrival(
  file: UploadedFile,
  line: LineWithTrip,
  driverId: string,
  input: ReportInput,
): Promise<UploadedFile> {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { name: true } });
    const at = eventTime(input.location_at ?? input.occurred_at);
    const acc = input.location_accuracy_m != null ? ` (akurasi ${input.location_accuracy_m} m)` : "";
    const buffer = await stampPhoto(file.buffer, [
      `SAMPAI DI LOKASI JEMPUT | ${line.order.order_code ?? ""}`,
      `Driver: ${driver?.name ?? "-"}`,
      `${at.toLocaleString("id-ID", WIB_STAMP)} WIB`,
      ...(input.location_name ? [`Lokasi: ${input.location_name}`] : []),
      `GPS ${input.latitude!.toFixed(6)}, ${input.longitude!.toFixed(6)}${acc}`,
      `Jemput: ${line.pickup_location}`,
    ]);
    return { ...file, buffer, size: buffer.length, mimetype: "image/jpeg" };
  } catch (err) {
    logger.warn({ err, lineId: line.id }, "arrival photo stamp failed; stored unstamped");
    return file;
  }
}

/** The driver's inbox, newest first (page with `before` = last created_at). */
export async function listNotifications(
  driverId: string,
  q: { before?: string; limit: number },
) {
  const [items, unread] = await Promise.all([
    prisma.driverNotification.findMany({
      where: { driver_id: driverId, ...(q.before ? { created_at: { lt: new Date(q.before) } } : {}) },
      orderBy: { created_at: "desc" },
      take: q.limit,
    }),
    prisma.driverNotification.count({ where: { driver_id: driverId, read_at: null } }),
  ]);
  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data,
      read: !!n.read_at,
      created_at: n.created_at,
    })),
  };
}

/** Mark some (ids) or all of the driver's notifications as read. */
export async function markNotificationsRead(
  driverId: string,
  input: { ids?: string[]; all?: boolean },
) {
  const { count } = await prisma.driverNotification.updateMany({
    where: {
      driver_id: driverId,
      read_at: null,
      ...(input.all ? {} : { id: { in: input.ids ?? [] } }),
    },
    data: { read_at: new Date() },
  });
  const unread = await prisma.driverNotification.count({ where: { driver_id: driverId, read_at: null } });
  return { updated: count, unread };
}
