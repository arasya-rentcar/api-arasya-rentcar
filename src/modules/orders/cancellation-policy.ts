// The whole-order cancellation rule (ORDER_V1) as a pure function: no
// database, no env, so the e2e checks can load it from dist and test the
// boundaries. The per-day rule (finance design §3.1, PR A3) will live here too.

// ── Jakarta timezone helpers ──────────────────────────────────────────────
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

function jakartaDate(d: Date | number | string): string {
  return new Date(
    new Date(d).getTime() + JAKARTA_OFFSET_MS,
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Compute the cancellation tier + penalty per Arasya policy. Penalty base is
 * ALWAYS final_price (confirmed with Ten): an order with no invoice yet still
 * incurs the policy %, and the invoice total should equal final_price anyway.
 *
 *  Tier 1 (cancel on any day before H)        → 20% of final_price (DP forfeit)
 *  Tier 2 (H-day, before 10:00, no driver yet) → 50% of final_price
 *  Tier 3 (H-day ≥10:00, driver arrived, or after H) → 100% of final_price
 *
 * "Before 10:00" is strictly before 10:00:00.000 WIB (B12, owner Q1, 7 Oct
 * 2026): 10:00:00.000 itself is already tier 3. Exported for the e2e
 * boundary checks.
 */
export function computeCancellationPenalty(args: {
  finalPrice: number;
  firstServiceDate: Date | null;
  anyLineStarted: boolean;
  now: Date;
}): { tier: 1 | 2 | 3; penalty: number; label: string } {
  const { finalPrice, firstServiceDate, anyLineStarted, now } = args;
  // Penalties are in whole rupiah (B12): the fee is billed to the customer.
  const todayJakarta = jakartaDate(now);
  // Milliseconds since WIB midnight (WIB has no daylight saving).
  const msOfWibDay = (now.getTime() + JAKARTA_OFFSET_MS) % 86_400_000;

  // No service date at all → treat as early cancel (Tier 1).
  if (!firstServiceDate) {
    return {
      tier: 1,
      penalty: Math.round(finalPrice * 0.2),
      label: "Tier 1 (tanpa tanggal layanan) — DP 20% hangus",
    };
  }

  const firstDayJakarta = jakartaDate(firstServiceDate);

  if (todayJakarta < firstDayJakarta) {
    // Cancel on any calendar day before the service date → forfeit DP (20%).
    return {
      tier: 1,
      penalty: Math.round(finalPrice * 0.2),
      label: "Tier 1 (sebelum hari H) — DP 20% hangus",
    };
  }

  if (todayJakarta === firstDayJakarta) {
    const before10 = msOfWibDay < 10 * 3_600_000;
    if (before10 && !anyLineStarted) {
      return {
        tier: 2,
        penalty: Math.round(finalPrice * 0.5),
        label: "Tier 2 (hari H sebelum pukul 10.00) — 50% dari total",
      };
    }
    return {
      tier: 3,
      penalty: Math.round(finalPrice),
      label:
        "Tier 3 (hari H setelah pukul 10.00 / driver tiba) — 100% dari total",
    };
  }

  // Cancel after the first service day has passed → 100%.
  return {
    tier: 3,
    penalty: Math.round(finalPrice),
    label: "Tier 3 (setelah hari H) — 100% dari total",
  };
}
