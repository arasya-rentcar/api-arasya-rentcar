import prisma from "../prisma/client";
import { logger } from "../config/logger";
import { wibDayLabel } from "../utils/wib";

/**
 * Dashboard notification feed (2026-10-04): what drivers do in the app
 * (status changes, reports, trip costs, requests). Each row is written after
 * the driver's action committed, and only by the request that really changed
 * something, so a resend from the phone adds nothing. Best-effort: these
 * functions never throw, a driver action must not fail because of them.
 */

export type AdminNotificationType =
  | "TRIP_ACCEPTED"
  | "TRIP_STARTED"
  | "TRIP_ARRIVED"
  | "TRIP_BOARDED"
  | "TRIP_FINISHED"
  | "TRIP_REPORT"
  | "TRIP_COST"
  | "DRIVER_REQUEST"
  // A driver took or returned an office e-toll card.
  | "ETOLL_CARD";

export interface AdminNotice {
  type: AdminNotificationType;
  title: string;
  body: string;
  /** Dashboard path to open, e.g. "/dashboard/orders/<id>". */
  link: string;
  order_id?: string | null;
  order_code?: string | null;
  service_item_id?: string | null;
  driver_id?: string | null;
  driver_request_id?: string | null;
  expense_id?: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const join = (parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(" · ");

export const rupiah = (n: number) => `Rp ${Math.round(Math.abs(n)).toLocaleString("id-ID")}`;
export const orderLink = (orderId: string) => `/dashboard/orders/${orderId}`;
// Driver requests are handled ("Tandai sudah top-up") on the notifications page.
export const requestsLink = "/dashboard/notifications";

export async function notifyAdmins(n: AdminNotice): Promise<void> {
  try {
    await prisma.adminNotification.create({
      data: { ...n, title: clip(n.title, 200), body: clip(n.body || "-", 500) },
    });
  } catch (err) {
    logger.error({ err, type: n.type }, "admin notification failed");
  }
}

/** The trip (one service day) with what every message about it needs. */
async function tripContext(lineId: string) {
  return prisma.orderServiceItem.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      order_id: true,
      driver_id: true,
      service_date: true,
      start_at: true,
      pickup_location: true,
      dropoff_location: true,
      order: { select: { order_code: true } },
      driver: { select: { name: true } },
    },
  });
}
type TripContext = NonNullable<Awaited<ReturnType<typeof tripContext>>>;

function tripRefs(t: TripContext) {
  return {
    order_id: t.order_id,
    order_code: t.order.order_code,
    service_item_id: t.id,
    driver_id: t.driver_id,
    link: orderLink(t.order_id),
  };
}
const tripHead = (t: TripContext) => [t.order.order_code, wibDayLabel(t.service_date ?? t.start_at)];

export type TripEvent = Extract<
  AdminNotificationType,
  "TRIP_ACCEPTED" | "TRIP_STARTED" | "TRIP_ARRIVED" | "TRIP_BOARDED" | "TRIP_FINISHED"
>;

const TRIP_TITLE: Record<TripEvent, (driver: string) => string> = {
  TRIP_ACCEPTED: (d) => `${d} menerima tugas`,
  TRIP_STARTED: (d) => `${d} berangkat ke lokasi jemput`,
  TRIP_ARRIVED: (d) => `${d} sampai di lokasi jemput`,
  TRIP_BOARDED: (d) => `${d} mulai perjalanan dengan pelanggan`,
  TRIP_FINISHED: (d) => `${d} menyelesaikan perjalanan`,
};

/**
 * A driver changed a trip's status in the app. `place` is the location name
 * the phone sent (arrival); otherwise the pickup / drop-off address is shown.
 */
export async function notifyTripEvent(type: TripEvent, lineId: string, place?: string | null): Promise<void> {
  try {
    const t = await tripContext(lineId);
    if (!t) return;
    const where =
      place?.trim() || (type === "TRIP_FINISHED" ? t.dropoff_location : t.pickup_location);
    await notifyAdmins({
      type,
      title: TRIP_TITLE[type](t.driver?.name ?? "Driver"),
      body: join([...tripHead(t), where]),
      ...tripRefs(t),
    });
  } catch (err) {
    logger.error({ err, type, lineId }, "trip notification failed");
  }
}

const COST_LABEL: Record<string, string> = {
  FUEL: "Bensin",
  TOLL: "Tol",
  PARKING: "Parkir",
  OTHER: "Biaya lain",
};

const REPORT_WHAT: Record<string, string> = {
  PHOTO: "mengirim foto",
  NOTE: "mengirim catatan",
  ODOMETER_START: "mengirim foto odometer awal",
  ODOMETER_END: "mengirim foto odometer akhir",
  ARRIVAL_PHOTO: "mengirim foto sampai lokasi jemput",
  FUEL: "mengirim struk bensin",
  TOLL: "mengirim struk tol",
  PARKING: "mengirim struk parkir",
  OTHER_COST: "mengirim struk biaya lain",
};

/**
 * A report from the app: a cost that became an Expense (TRIP_COST, waits for
 * review) or anything else (TRIP_REPORT: photo, note, odometer, receipt
 * without amount).
 */
export async function notifyTripReport(
  lineId: string,
  report: { report_type: string; notes: string | null; amount: number | null; location_name?: string | null },
  expense?: { id: string; type: string; amount: number; bill_to_customer: boolean } | null,
): Promise<void> {
  try {
    const t = await tripContext(lineId);
    if (!t) return;
    const driver = t.driver?.name ?? "Driver";
    const note = report.notes ? clip(report.notes, 120) : null;
    if (expense) {
      await notifyAdmins({
        type: "TRIP_COST",
        title: `Biaya perjalanan baru: ${COST_LABEL[expense.type] ?? expense.type} ${rupiah(expense.amount)} — perlu ditinjau`,
        body: join([
          driver,
          ...tripHead(t),
          expense.bill_to_customer ? "ditagihkan ke pelanggan" : null,
          note,
        ]),
        expense_id: expense.id,
        ...tripRefs(t),
      });
      return;
    }
    const isOdometer = report.report_type.startsWith("ODOMETER");
    const detail =
      isOdometer && report.amount != null
        ? `${report.amount.toLocaleString("id-ID")} km`
        : note ?? report.location_name ?? null;
    await notifyAdmins({
      type: "TRIP_REPORT",
      title: `${driver} ${REPORT_WHAT[report.report_type] ?? "mengirim laporan"}`,
      body: join([...tripHead(t), detail]),
      ...tripRefs(t),
    });
  } catch (err) {
    logger.error({ err, lineId }, "report notification failed");
  }
}

const REQUEST_TITLE: Record<string, string> = {
  ETOLL_TOPUP: "minta top-up e-toll",
};

/** A new request from a driver (e.g. e-toll top-up). */
export async function notifyDriverRequest(r: {
  id: string;
  driver_id: string;
  type: string;
  card_id?: string | null;
  card_label: string | null;
  balance: number | null;
  note: string | null;
}): Promise<void> {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: r.driver_id }, select: { name: true } });
    // An office card's label ("BCA Flazz · Kartu 3 ••••5678") reads as it is.
    const card = r.card_label
      ? r.card_id || /^kartu\b/i.test(r.card_label)
        ? r.card_label
        : `Kartu ${r.card_label}`
      : null;
    await notifyAdmins({
      type: "DRIVER_REQUEST",
      title: `${driver?.name ?? "Driver"} ${REQUEST_TITLE[r.type] ?? "mengirim permintaan"}`,
      body:
        join([card, r.balance != null ? `saldo ${rupiah(r.balance)}` : null, r.note ? clip(r.note, 120) : null]) ||
        "Tanpa keterangan",
      driver_id: r.driver_id,
      driver_request_id: r.id,
      link: requestsLink,
    });
  } catch (err) {
    logger.error({ err, requestId: r.id }, "driver request notification failed");
  }
}
