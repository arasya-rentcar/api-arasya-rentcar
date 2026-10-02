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
