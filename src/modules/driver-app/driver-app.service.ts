import { Prisma, ScheduleStatus } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  deriveAndSetOrderStatus,
  syncCarStatus,
  syncDriverStatus,
} from "../schedule/order-derive.service";
import { refreshOrderSummary } from "../bot/bot.service";
import { pushToAdmins } from "../../services/push.service";
import { env } from "../../config/env";
import {
  uploadFile,
  assertValidUpload,
  type UploadedFile,
} from "../../services/storage.service";
import type { ReportInput } from "./driver-app.validation";

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
const SYSTEM_REPORTS = ["START", "ARRIVE_CUSTOMER", "FINISH", "DROP"];

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
    trip_finished_at: l.trip_finished_at,
    report_count: l._count.reports,
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

export async function listTrips(driverId: string, scope: "active" | "history") {
  const lines = await prisma.orderServiceItem.findMany({
    where:
      scope === "active"
        ? { driver_id: driverId, is_external: false, line_status: { notIn: ["DONE", "CANCELLED"] } }
        : {
            driver_id: driverId,
            is_external: false,
            line_status: "DONE",
            trip_finished_at: { gte: new Date(Date.now() - 60 * 86400000) },
          },
    include: tripInclude,
    orderBy:
      scope === "active"
        ? [{ service_date: "asc" }, { start_at: "asc" }, { sort_order: "asc" }]
        : [{ trip_finished_at: "desc" }],
    take: scope === "active" ? 100 : 50,
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
  };
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
  await applyOnce(line, driverId, {
    guard: { driver_accepted_at: null, line_status: { not: "CANCELLED" } },
    data: { driver_accepted_at: eventTime(occurredAt) },
  });
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
    await refreshOrderSummary(line.order_id);
    void pushToAdmins({
      title: `Driver berangkat · ${line.order.order_code ?? ""}`.trim(),
      body: `${line.order.customer_name} · ${line.pickup_location}`,
      data: { type: "trip_started", line_id: lineId, order_id: line.order_id },
    });
  }
  return toTrip(await ownLine(driverId, lineId));
}

/** Arrived at the pickup point. */
export async function arriveTrip(driverId: string, lineId: string, opts: ActionOpts = {}) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  const now = eventTime(opts.occurredAt);
  await applyOnce(line, driverId, {
    guard: { actual_pickup_at: null, line_status: { notIn: TERMINAL } },
    data: { actual_pickup_at: now, driver_accepted_at: line.driver_accepted_at ?? now },
    report: {
      type: "ARRIVE_CUSTOMER",
      notes: "Tiba di lokasi jemput (aplikasi driver)",
      at: now,
      clientRef: opts.clientRef,
    },
  });
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
    report?: { type: string; notes: string; at: Date; clientRef?: string };
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
 * the line; they are kept separate from ops_cost (the driver payable base).
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

  let fileUrl: string | null = null;
  let fileMime: string | null = null;
  if (photo) {
    const file = assertValidUpload(photo);
    const up = await uploadFile(file, {
      bucket: TRIP_BUCKET,
      prefix: `trip-reports/${lineId}`,
      public: true,
    });
    fileUrl = up.publicUrl;
    fileMime = file.mimetype;
  }
  const costType = COST_TYPES[input.report_type];
  // amount = rupiah for cost receipts, or the km reading for odometer photos.
  const isOdometer = input.report_type.startsWith("ODOMETER");
  const amount = (costType || isOdometer) && input.amount ? input.amount : null;

  const at = eventTime(input.occurred_at);
  let report;
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
      },
    });
    if (costType && amount) {
      await tx.expense.create({
        data: {
          order_service_item_id: lineId,
          type: costType,
          amount,
          note: input.notes ?? null,
          created_at: at,
        },
      });
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
  await refreshOrderSummary(line.order_id);
  return toReport(report);
}
