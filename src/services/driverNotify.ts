import prisma from "../prisma/client";
import { logger } from "../config/logger";
import { startPayment } from "../modules/orders/assignment-guard";
import { pushToDriver } from "./push.service";

/**
 * Driver app notifications about money and payment (2026-10-03). Each one is
 * a push plus an inbox row (pushToDriver). Best-effort: never throws.
 */

const rupiah = (n: number) => `Rp ${Math.round(Math.abs(n)).toLocaleString("id-ID")}`;

function day(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function time(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
}

const METHOD: Record<string, string> = {
  CASH: "tunai",
  BANK_TRANSFER: "transfer",
  QRIS: "QRIS",
  OTHER: "lainnya",
};

/** Driver fee payables just marked PAID: one notification per driver. */
export async function notifyPayablesPaid(payableIds: string[]): Promise<void> {
  try {
    if (!payableIds.length) return;
    const rows = await prisma.payable.findMany({
      where: { id: { in: payableIds }, kind: "DRIVER", status: "PAID", driver_id: { not: null } },
      orderBy: { service_date: "asc" },
      include: { order: { select: { order_code: true } } },
    });
    const byDriver = new Map<string, typeof rows>();
    for (const p of rows) {
      const list = byDriver.get(p.driver_id!) ?? [];
      list.push(p);
      byDriver.set(p.driver_id!, list);
    }
    for (const [driverId, list] of byDriver) {
      const total = list.reduce((s, p) => s + Number(p.total_amount), 0);
      const first = list[0];
      const how = first.payment_method ? ` (${METHOD[first.payment_method] ?? first.payment_method})` : "";
      const body =
        list.length === 1
          ? total < 0
            ? `Sisa uang jalan ${rupiah(total)} untuk trip ${day(first.service_date)} · ${first.order.order_code ?? ""} sudah diperhitungkan.`
            : `${rupiah(total)}${how} untuk trip ${day(first.service_date)} · ${first.order.order_code ?? ""}.`
          : `Total ${rupiah(total)} untuk ${list.length} trip, ${day(first.service_date)} s.d. ${day(list[list.length - 1].service_date)}.`;
      await pushToDriver(driverId, {
        title: list.length === 1 ? "Fee sudah dibayar" : `${list.length} fee sudah dibayar`,
        body: body.replace(/ · \./, "."),
        data: {
          type: "payable_paid",
          payable_ids: list.map((p) => p.id),
          total,
          items: list.map((p) => ({
            payable_id: p.id,
            order_code: p.order.order_code,
            service_date: p.service_date,
            fee: Number(p.base_amount),
            reimburse: Number(p.reimburse_amount),
            advance: Number(p.advance_amount),
            extras: Number(p.extras_amount),
            total: Number(p.total_amount),
          })),
        },
      });
    }
  } catch (err) {
    logger.error({ err }, "notifyPayablesPaid failed");
  }
}

/**
 * The order just became paid in full: tell each internal driver whose day has
 * not started yet that they may depart (the app unlocks "Berangkat").
 */
export async function notifyOrderPaidInFull(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        order_code: true,
        paid_to_date: true,
        service_items: {
          orderBy: [{ service_date: "asc" }, { start_at: "asc" }],
          select: {
            id: true,
            total_price: true,
            line_status: true,
            is_external: true,
            driver_id: true,
            service_date: true,
            start_at: true,
            pickup_location: true,
            actual_start_at: true,
            trip_started_at: true,
          },
        },
      },
    });
    if (!order || !startPayment(order, order.service_items).ready) return;
    const waiting = order.service_items.filter(
      (l) =>
        !l.is_external &&
        l.driver_id &&
        (l.line_status === "SCHEDULED" || l.line_status === "ASSIGNED") &&
        !l.actual_start_at &&
        !l.trip_started_at,
    );
    const seen = new Set<string>();
    for (const l of waiting) {
      if (seen.has(l.driver_id!)) continue;
      seen.add(l.driver_id!);
      await pushToDriver(l.driver_id!, {
        title: `Order ${order.order_code ?? ""} sudah lunas`.replace("  ", " "),
        body: `Anda bisa berangkat sesuai jadwal: ${day(l.service_date ?? l.start_at)} ${time(l.start_at)} · ${l.pickup_location}`.trim(),
        data: { type: "order_paid", line_id: l.id, order_id: orderId },
      });
    }
  } catch (err) {
    logger.error({ err }, "notifyOrderPaidInFull failed");
  }
}

const COST_LABEL: Record<string, string> = {
  FUEL: "Bensin",
  TOLL: "Tol",
  PARKING: "Parkir",
  OTHER: "Biaya lain",
};

/** A cost the driver reported was rejected by the office (with the reason). */
export async function notifyExpenseRejected(expenseId: string): Promise<void> {
  try {
    const e = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: {
        order_service_item: {
          select: { id: true, driver_id: true, service_date: true, order: { select: { order_code: true } } },
        },
      },
    });
    const line = e?.order_service_item;
    if (!e || e.status !== "REJECTED" || e.created_by || !line?.driver_id) return;
    const why = e.review_note?.trim() ? `: ${e.review_note.trim()}` : ". Tanyakan ke admin.";
    await pushToDriver(line.driver_id, {
      title: "Biaya ditolak",
      body: `${COST_LABEL[e.type] ?? e.type} ${rupiah(Number(e.amount))} · trip ${day(line.service_date)}${why}`,
      data: { type: "expense_rejected", line_id: line.id, expense_id: e.id },
    });
  } catch (err) {
    logger.error({ err }, "notifyExpenseRejected failed");
  }
}
