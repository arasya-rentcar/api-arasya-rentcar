/**
 * Margin computation for Arasya orders.
 *
 * Rules (confirmed by TEN 2026-06-17):
 *  - INTERNAL (own driver + car): margin = TOTAL USER  −  TOTAL OPS COST
 *  - EXTERNAL (vendor-supplied):  margin = (TOTAL USER | HARGA JUAL)  −  RTR
 *
 * Bump MARGIN_FORMULA_VERSION whenever this logic changes so historical rows
 * remain auditable.
 */
export const MARGIN_FORMULA_VERSION = 'v2-2026-06-17';

export interface MarginInputs {
  isExternal: boolean;
  total_user_amount?: number | null;
  total_ops_cost?: number | null;
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
  // Internal: total user minus total operational cost.
  return n(input.total_user_amount) - n(input.total_ops_cost);
}
