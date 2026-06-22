/**
 * Margin computation for Arasya orders.
 *
 * Rules:
 *  - INTERNAL (own driver + car): margin = TOTAL USER − (TOTAL OPS COST + DRIVER FEE)
 *      (confirmed by TEN 2026-06-22: the driver fee was being collected but never
 *       subtracted; total_user is the ALL-IN customer total — rental + billable
 *       additionals already raise final_price → total_user — so additionals are
 *       counted in revenue and must NOT be added again.)
 *  - EXTERNAL (vendor-supplied):  margin = (TOTAL USER | HARGA JUAL) − RTR
 *      (driver fee is an internal concept; vendor cost is captured by RTR.)
 *
 * Bump MARGIN_FORMULA_VERSION whenever this logic changes so historical rows
 * remain auditable.
 */
export const MARGIN_FORMULA_VERSION = 'v3-2026-06-22';

export interface MarginInputs {
  isExternal: boolean;
  total_user_amount?: number | null;
  total_ops_cost?: number | null;
  driver_fee_amount?: number | null;
  sell_price?: number | null;
  rtr_amount?: number | null;
}

const n = (v?: number | null) => (v == null ? 0 : Number(v));

export function computeMargin(input: MarginInputs): number {
  if (input.isExternal) {
    // External: revenue (total user, fallback to sell price) minus RTR.
    const revenue =
      input.total_user_amount != null
        ? n(input.total_user_amount)
        : n(input.sell_price);
    return revenue - n(input.rtr_amount);
  }
  // Internal: all-in customer total minus (ops cost + driver fee).
  return (
    n(input.total_user_amount) -
    (n(input.total_ops_cost) + n(input.driver_fee_amount))
  );
}

/**
 * Per-day (schedule line) margin. Same rule as the order-level formula, just
 * applied to one day's revenue + cost so multi-day orders with mixed
 * internal/external days roll up correctly (order margin = sum of line margins).
 */
export interface LineMarginInputs {
  isExternal: boolean;
  revenue?: number | null; // that day's user/sell price (total_price)
  ops_cost?: number | null; // that day's ops (bensin/tol/fee/parkir/etc.)
  rtr_amount?: number | null; // vendor RTR for external days
}

export function computeLineMargin(input: LineMarginInputs): number {
  if (input.isExternal) {
    return n(input.revenue) - n(input.rtr_amount);
  }
  return n(input.revenue) - n(input.ops_cost);
}
