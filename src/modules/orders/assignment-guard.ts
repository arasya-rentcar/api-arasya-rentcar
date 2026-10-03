import { AppError } from "../../utils/AppError";

// Owner rule (Oct 2026): a trip goes to an internal driver only after the
// customer has paid at least the DP. payment_status advances only when an
// invoice is marked PAID (markInvoicePaid), so DP_PAID/PAID means money has
// actually been received. Unassigning a driver, editing other fields of a line
// that already has its driver, and partner (external) lines are not affected.
export function assertOrderPaidForDriverAssignment(order: {
  payment_status: string;
}): void {
  if (order.payment_status === "DP_PAID" || order.payment_status === "PAID")
    return;
  throw new AppError(
    "Order belum dibayar. Driver baru bisa ditugaskan setelah DP atau pelunasan tercatat (invoice ditandai terbayar).",
    409,
  );
}

// Owner rule (3 Oct 2026): the trip with the customer begins only when the
// order is paid in full. The driver may still leave the garage and record the
// arrival at the pickup; "Mulai perjalanan" (customer on board) is what waits.
// "In full" = the money received (paid_to_date, which only moves when an
// invoice is marked paid) covers the rental price of every day that is not
// cancelled. Extra charges (overtime, parking/fuel billed to the customer…)
// arise on the road and are billed afterwards (Invoice Tambahan), so they do
// not hold back the next day of a multi-day trip.
export interface StartPayment {
  rental_total: number;
  paid_to_date: number;
  ready: boolean;
}

export function startPayment(
  order: { paid_to_date: unknown },
  lines: { total_price: unknown; line_status: string }[],
): StartPayment {
  const rental_total = lines
    .filter((l) => l.line_status !== "CANCELLED")
    .reduce((s, l) => s + Number(l.total_price ?? 0), 0);
  const paid_to_date = Number(order.paid_to_date ?? 0);
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
  service_items: { select: { total_price: true, line_status: true } },
} as const;

/**
 * payment_status from the money received and the order total: PAID once the
 * total is covered, DP_PAID while some money is in, UNPAID otherwise. The one
 * rule for every place that changes either number (payments, the order total
 * after days or charges change, cancellation).
 */
/** Money the customer has paid and Arasya kept (a refund settled is given back). */
export function netPaid(order: {
  paid_to_date: unknown;
  is_refunded?: boolean | null;
  refund_amount?: unknown;
}): number {
  const refunded = order.is_refunded ? Number(order.refund_amount ?? 0) : 0;
  return Number(order.paid_to_date ?? 0) - refunded;
}

export function paymentStatusFor(
  paidToDate: unknown,
  orderTotal: unknown,
): "UNPAID" | "DP_PAID" | "PAID" {
  const paid = Number(paidToDate ?? 0);
  const total = Number(orderTotal ?? 0);
  if (total > 0 && paid >= total) return "PAID";
  if (paid > 0) return "DP_PAID";
  return "UNPAID";
}
