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

// Owner rule (3 Oct 2026): a trip starts only when the order is paid in full.
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
    "Order belum lunas. Trip baru bisa dimulai setelah pelunasan tercatat (invoice ditandai terbayar). Hubungi admin.",
    409,
  );
}

/** Prisma select for what startPayment needs from an order. */
export const startPaymentSelect = {
  paid_to_date: true,
  service_items: { select: { total_price: true, line_status: true } },
} as const;
