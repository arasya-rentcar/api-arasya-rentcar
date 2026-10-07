import type { Prisma, ScheduleStatus } from "@prisma/client";
import { AppError } from "../../utils/AppError";
import { rupiah } from "../../services/adminNotify";

// Owner rule (Oct 2026): a trip goes to an internal driver only after the
// customer has paid at least the DP. Decided from the money actually received
// (orderPaymentStatus, the same rule as the stored payment_status): DP_PAID
// needs at least 20% of the rental price of the days that are not cancelled
// (owner, 6 Oct 2026), so an invoice marked paid with less is not enough.
// Unassigning a driver, editing other fields of a line that already has its
// driver, and partner (external) lines are not affected.
export function assertOrderPaidForDriverAssignment(
  order: PaymentOrder & { service_items: RentalLine[] },
): void {
  const status = orderPaymentStatus(order, order.service_items);
  if (status === "DP_PAID" || status === "PAID") return;
  const paid = netPaid(order);
  if (paid > 0) {
    throw new AppError(
      `Uang yang sudah diterima ${rupiah(paid)}, belum mencapai DP minimal 20% dari harga sewa (${rupiah(minDpFor(dpBaseOf(order, order.service_items)))}). Driver baru bisa ditugaskan setelah DP minimal tercatat.`,
      409,
    );
  }
  throw new AppError(
    "Order belum dibayar. Driver baru bisa ditugaskan setelah DP atau pelunasan tercatat (invoice ditandai terbayar).",
    409,
  );
}

// Owner rule (T5, Oct 2026): the days of a finished (finalized, DONE) or
// cancelled order are closed: no driver/car, status, time or money change
// through Edit Hari, "Ganti Semua" or any other day edit. What stays allowed
// after the end lives elsewhere: trip-cost review (Biaya), driver/partner pay
// (Utang: extras, mark paid/unpaid), invoices, payments and refunds.
export function assertOrderOpenForDayChanges(order: {
  order_status: string;
}): void {
  if (order.order_status === "DONE")
    throw new AppError(
      "Order ini sudah selesai (difinalisasi), jadi harinya tidak bisa diubah lagi. Biaya perjalanan dan pembayaran fee driver tetap bisa diurus di menu Biaya dan Utang.",
      409,
    );
  if (order.order_status === "CANCELLED")
    throw new AppError(
      "Order ini sudah dibatalkan, jadi harinya tidak bisa diubah lagi. Biaya perjalanan dan pembayaran fee driver tetap bisa diurus di menu Biaya dan Utang.",
      409,
    );
}

// B1.1 (owner, 6 Oct 2026): Edit Hari and Edit Order never end an order. The
// last day still to run is not cancelled or removed there while other days
// are done: that would end the order without the cancellation fee. Ending it
// goes through "Batalkan Pesanan" (cancelOrder).
/** Day statuses still to run: an order with none of these has ended. */
export const OPEN_DAY_STATUSES: ScheduleStatus[] = ["SCHEDULED", "ASSIGNED", "IN_PROGRESS"];
export const isOpenDay = (status: string) => (OPEN_DAY_STATUSES as string[]).includes(status);
export const LAST_OPEN_DAY_MESSAGE =
  "Ini hari terakhir yang masih aktif di order ini. Untuk mengakhiri order, pakai tombol Batalkan Pesanan supaya biaya pembatalan dihitung.";

/**
 * Inside the transaction, under the order lock, after the change: refused
 * when no day of the order (other than `exceptId`, the day being cancelled)
 * is still to run.
 */
export async function assertNotLastOpenDay(
  tx: Prisma.TransactionClient,
  orderId: string,
  exceptId?: string,
): Promise<void> {
  const stillOpen = await tx.orderServiceItem.count({
    where: {
      order_id: orderId,
      line_status: { in: OPEN_DAY_STATUSES },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (stillOpen === 0) throw new AppError(LAST_OPEN_DAY_MESSAGE, 409);
}

// Owner rule (3 Oct 2026): the trip with the customer begins only when the
// order is paid in full. The driver may still leave the garage and record the
// arrival at the pickup; "Mulai perjalanan" (customer on board) is what waits.
// "In full" = the money kept (net of refunds, finance design §2 / Q10: money
// received − refunded) covers the rental price of every day that is not
// cancelled. Extra charges (overtime, parking/fuel billed to the customer…)
// arise on the road and are billed afterwards (Invoice Tambahan), so they do
// not hold back the next day of a multi-day trip.
export interface StartPayment {
  rental_total: number;
  /** Net money kept (received − refunded); the name is kept for older clients. */
  paid_to_date: number;
  ready: boolean;
}

export function startPayment(
  order: { paid_to_date: unknown; refunded_total?: unknown },
  lines: { total_price: unknown; line_status: string }[],
): StartPayment {
  const rental_total = rentalBaseOf(lines);
  const paid_to_date = netPaid(order);
  return { rental_total, paid_to_date, ready: paid_to_date >= rental_total };
}

export function assertOrderPaidForTripStart(state: StartPayment): void {
  if (state.ready) return;
  throw new AppError(
    "Order belum lunas. Perjalanan dengan pelanggan baru bisa dimulai setelah pelunasan tercatat (invoice ditandai terbayar). Hubungi admin.",
    409,
  );
}

/** Prisma select for what startPayment needs from an order. */
export const startPaymentSelect = {
  paid_to_date: true,
  refunded_total: true,
  service_items: { select: { total_price: true, line_status: true } },
} as const;

/** A day as far as the rental price is concerned. */
export interface RentalLine {
  total_price: unknown;
  line_status: string;
}

/**
 * Rental price of the days that are not cancelled: the DP base (20%), what
 * "lunas" for "Mulai perjalanan" covers, and the base of the DP rule in
 * payment_status. Extra charges are billed separately and are not in it.
 */
export function rentalBaseOf(lines: RentalLine[]): number {
  return lines
    .filter((l) => l.line_status !== "CANCELLED")
    .reduce((s, l) => s + Number(l.total_price ?? 0), 0);
}

/**
 * The base of the 20% DP rule in payment_status: the rental price of the days
 * that are not cancelled, or, once the order is cancelled (cancellation_fee
 * set), the fee. After a cancellation the fee is what the customer owes (it
 * is also the order's new total), so the rental price of days that will
 * never run must not decide it, and the cancelled days' rental base (often 0)
 * would make any money count as DP.
 */
export function dpBaseOf(
  order: { cancellation_fee?: unknown },
  lines: RentalLine[],
): number {
  return order.cancellation_fee != null
    ? Number(order.cancellation_fee)
    : rentalBaseOf(lines);
}

/** Minimum DP: 20% of the rental base, in whole rupiah. */
export function minDpFor(rentalBase: number): number {
  return Math.round(rentalBase * 0.2);
}

/**
 * Money the customer has paid and Arasya kept: received − refunded (finance
 * design §2, "Net"). refunded_total is the sum of every refund (A1 ledger);
 * callers that did not select it fall back to the old single-refund columns,
 * which the refund paths keep equal to it (cumulative).
 */
export function netPaid(order: {
  paid_to_date: unknown;
  refunded_total?: unknown;
  is_refunded?: boolean | null;
  refund_amount?: unknown;
}): number {
  const refunded =
    order.refunded_total !== undefined && order.refunded_total !== null
      ? Number(order.refunded_total)
      : order.is_refunded
        ? Number(order.refund_amount ?? 0)
        : 0;
  return Number(order.paid_to_date ?? 0) - refunded;
}

/**
 * payment_status from the money received: PAID once the order total is
 * covered, DP_PAID once at least the minimum DP (20% of the base, dpBaseOf)
 * is in, UNPAID otherwise (also when some money is in but less than the DP).
 * With no base (no days) any money counts as DP. The one rule for every place
 * that changes the money or the total (payments, days or charges changing,
 * cancellation); pass dpBaseOf as the base.
 */
export function paymentStatusFor(
  paidToDate: unknown,
  orderTotal: unknown,
  rentalBase: number,
): "UNPAID" | "DP_PAID" | "PAID" {
  const paid = Number(paidToDate ?? 0);
  const total = Number(orderTotal ?? 0);
  if (total > 0 && paid >= total) return "PAID";
  if (paid > 0 && paid >= minDpFor(rentalBase)) return "DP_PAID";
  return "UNPAID";
}

/** What orderPaymentStatus needs from an order. */
export interface PaymentOrder {
  final_price: unknown;
  paid_to_date: unknown;
  payment_status: string;
  refunded_total?: unknown;
  is_refunded?: boolean | null;
  refund_amount?: unknown;
  cancellation_fee?: unknown;
}

/** Prisma select for orderPaymentStatus / assertOrderPaidForDriverAssignment. */
export const paymentOrderSelect = {
  final_price: true,
  paid_to_date: true,
  payment_status: true,
  refunded_total: true,
  is_refunded: true,
  refund_amount: true,
  cancellation_fee: true,
  service_items: { select: { total_price: true, line_status: true } },
} as const;

/**
 * An order's payment_status from its money and days (paymentStatusFor).
 * Orders whose payment was recorded without paid_to_date (sheet imports,
 * TEST-PLAN N2) keep the status they were imported with.
 */
export function orderPaymentStatus(
  order: PaymentOrder,
  lines: RentalLine[],
): "UNPAID" | "DP_PAID" | "PAID" {
  const legacyPaid =
    Number(order.paid_to_date ?? 0) === 0 && order.payment_status !== "UNPAID";
  if (legacyPaid) return order.payment_status as "DP_PAID" | "PAID";
  return paymentStatusFor(netPaid(order), order.final_price, dpBaseOf(order, lines));
}
