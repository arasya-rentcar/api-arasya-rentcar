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
  _count: { select: { reports: true } },
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
  };
}

const TERMINAL: ScheduleStatus[] = ["DONE", "CANCELLED"];

export async function acceptTrip(driverId: string, lineId: string) {
  const line = await ownLine(driverId, lineId);
  if (line.line_status === "CANCELLED") throw new AppError("Trip was cancelled", 409);
  if (!line.driver_accepted_at) {
    await prisma.orderServiceItem.update({
      where: { id: lineId },
      data: { driver_accepted_at: new Date() },
    });
  }
  return toTrip(await ownLine(driverId, lineId));
}

/** Depart the garage: IN_PROGRESS + journey timestamps, like the bot's #start. */
export async function startTrip(driverId: string, lineId: string) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  if (line.line_status !== "IN_PROGRESS") {
    const now = new Date();
    await transition(lineId, line.order_id, {
      line_status: "IN_PROGRESS",
      driver_accepted_at: line.driver_accepted_at ?? now,
      ...(line.trip_started_at ? {} : { trip_started_at: now }),
      ...(line.actual_start_at ? {} : { actual_start_at: now }),
    });
    await systemReport(line, driverId, "START", "Berangkat (aplikasi driver)");
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
export async function arriveTrip(driverId: string, lineId: string) {
  const line = await ownLine(driverId, lineId);
  if (TERMINAL.includes(line.line_status))
    throw new AppError(`Trip is already ${line.line_status === "DONE" ? "finished" : "cancelled"}`, 409);
  if (!line.actual_pickup_at) {
    const now = new Date();
    await prisma.orderServiceItem.update({
      where: { id: lineId },
      data: { actual_pickup_at: now, driver_accepted_at: line.driver_accepted_at ?? now },
    });
    await systemReport(line, driverId, "ARRIVE_CUSTOMER", "Tiba di lokasi jemput (aplikasi driver)");
  }
  return toTrip(await ownLine(driverId, lineId));
}

/** Drop-off / done, like the bot's #finish (order then awaits finalization). */
export async function finishTrip(driverId: string, lineId: string, notes?: string) {
  const line = await ownLine(driverId, lineId);
  if (line.line_status === "CANCELLED") throw new AppError("Trip was cancelled", 409);
  if (line.line_status !== "DONE") {
    const now = new Date();
    await transition(lineId, line.order_id, {
      line_status: "DONE",
      driver_accepted_at: line.driver_accepted_at ?? now,
      ...(line.trip_started_at ? {} : { trip_started_at: now }),
      trip_finished_at: now,
      finish_reported_at: now,
    });
    await systemReport(line, driverId, "FINISH", notes?.trim() || "Selesai (aplikasi driver)");
    await refreshOrderSummary(line.order_id);
    void pushToAdmins({
      title: `Trip selesai · ${line.order.order_code ?? ""}`.trim(),
      body: `${line.order.customer_name} · ${line.dropoff_location}`,
      data: { type: "trip_finished", line_id: lineId, order_id: line.order_id },
    });
  }
  return toTrip(await ownLine(driverId, lineId));
}

async function transition(
  lineId: string,
  orderId: string,
  data: Prisma.OrderServiceItemUncheckedUpdateInput,
) {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.orderServiceItem.update({
      where: { id: lineId },
      data,
      select: { driver_id: true, car_id: true },
    });
    await deriveAndSetOrderStatus(tx, orderId);
    if (updated.driver_id) await syncDriverStatus(tx, updated.driver_id);
    if (updated.car_id) await syncCarStatus(tx, updated.car_id);
  }, { maxWait: 15000, timeout: 30000 });
}

async function systemReport(line: LineWithTrip, driverId: string, type: string, notes: string) {
  await prisma.tripReport.create({
    data: {
      order_id: line.order_id,
      order_service_item_id: line.id,
      order_code: line.order.order_code,
      driver_id: driverId,
      report_type: type,
      input_type: "TEXT",
      notes,
      match_method: "driver app",
      source: "API",
      status: "MATCHED",
    },
  });
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
  const amount = costType && input.amount ? input.amount : null;

  const report = await prisma.$transaction(async (tx) => {
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
      },
    });
    if (costType && amount) {
      await tx.expense.create({
        data: {
          order_service_item_id: lineId,
          type: costType,
          amount,
          note: input.notes ?? null,
        },
      });
    }
    return r;
  });
  await refreshOrderSummary(line.order_id);
  return toReport(report);
}
