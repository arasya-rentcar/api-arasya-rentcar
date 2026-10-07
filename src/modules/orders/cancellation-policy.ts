// The cancellation rules as pure functions: no database, no env, so the e2e
// checks can load them from dist and test the boundaries. dayCancellation is
// the rule (DAY_V2, finance design §3.1, PR A3); computeCancellationPenalty is
// the old whole-order rule (ORDER_V1), kept only to explain legacy orders.

/**
 * The cancellation policy as customers read it (invoice PDF, WhatsApp
 * caption). ONE place: the owner's final wording is still pending, so change
 * it here only. Must say the same as dayCancellation below and the website.
 */
export const CANCELLATION_POLICY_TEXT =
  "Pembatalan dihitung per hari sewa dari harga hari tersebut: batal paling lambat sehari sebelumnya 20%; batal pada hari sewa sebelum pukul 10.00 WIB dan driver belum berangkat 50%; batal pada hari sewa mulai pukul 10.00 WIB atau setelah driver berangkat 100%. Biaya tambahan yang sudah terpakai dibayar penuh. Kelebihan bayar dipotongkan ke tagihan berikutnya atau dikembalikan bila diminta.";

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

/**
 * pct% of a rupiah price in whole rupiah, rounded half-up, computed in integer
 * sen (finance design §2). Never a float × 0.2.
 */
export function pctRupiah(price: number | string, pct: number): number {
  const priceSen = Math.round(Number(price ?? 0) * 100);
  return Math.floor((priceSen * pct + 5000) / 10000);
}

export type DayCancelTier = 1 | 2 | 3;
export const TIER_PCT: Record<DayCancelTier, 20 | 50 | 100> = { 1: 20, 2: 50, 3: 100 };

export interface DayCancellation {
  tier: DayCancelTier;
  pct: 20 | 50 | 100;
  /** Whole rupiah: pctRupiah(price, pct). */
  fee: number;
  label: string;
}

/**
 * The fee of cancelling ONE day (owner, 7 Oct 2026; finance design §3.1),
 * from that day's own WIB date and its own price:
 *
 *  - decided on a WIB day before the day's date           → tier 1, 20%
 *  - on the day's date, before 10:00:00.000 WIB, and the
 *    trip has not started (driver still at the garage)     → tier 2, 50%
 *  - otherwise (from 10:00:00.000, started, or after it)   → tier 3, 100%
 *
 * `dayDate`: the day's service_date (fallbacks start_at, then the order's
 * service_start_at, chosen by the caller); none → tier 1. `started`:
 * actual_start_at / trip_started_at set or line_status IN_PROGRESS / DONE
 * (dayStarted). `decidedAt`: the save time, or the customer's request time
 * when the admin gives one. Partner days use the same tiers.
 */
export function dayCancellation(args: {
  price: number | string;
  dayDate: Date | string | null | undefined;
  started: boolean;
  decidedAt: Date;
}): DayCancellation {
  const { price, dayDate, started, decidedAt } = args;
  const make = (tier: DayCancelTier, why: string): DayCancellation => ({
    tier,
    pct: TIER_PCT[tier],
    fee: pctRupiah(price, TIER_PCT[tier]),
    label: `Biaya pembatalan ${TIER_PCT[tier]}% (${why})`,
  });
  if (!dayDate) return make(1, "tanpa tanggal sewa");
  const decidedDay = jakartaDate(decidedAt);
  const day = jakartaDate(dayDate);
  if (decidedDay < day) return make(1, "dibatalkan sebelum hari sewa");
  if (decidedDay === day) {
    if (started) return make(3, "driver sudah berangkat");
    const msOfWibDay = (decidedAt.getTime() + JAKARTA_OFFSET_MS) % 86_400_000;
    if (msOfWibDay < 10 * 3_600_000) return make(2, "hari sewa, sebelum pukul 10.00 WIB");
    return make(3, "hari sewa, mulai pukul 10.00 WIB");
  }
  return make(3, "setelah hari sewa");
}

/** "Started" for the tiers: the driver left the garage (owner, 7 Oct 2026). */
export function dayStarted(day: {
  actual_start_at?: Date | null;
  trip_started_at?: Date | null;
  line_status: string;
}): boolean {
  return (
    !!day.actual_start_at ||
    !!day.trip_started_at ||
    day.line_status === "IN_PROGRESS" ||
    day.line_status === "DONE"
  );
}

/** The date a day's tier is decided from: service_date, start_at, then the order's start. */
export function dayDateOf(
  day: { service_date?: Date | null; start_at?: Date | null },
  orderStart?: Date | null,
): Date | null {
  return day.service_date ?? day.start_at ?? orderStart ?? null;
}

/** How far back "jam pelanggan membatalkan" may go (owner, 7 Oct 2026). */
export const REQUESTED_AT_MAX_AGE_MS = 3 * 24 * 3_600_000;

/**
 * The time a cancellation is decided at: the customer's request time when
 * given (≤ now and ≥ now − 3 days), else now. Returns an error message for an
 * out-of-range time instead of throwing, so the callers keep their own error type.
 */
export function cancelDecisionTime(
  requestedAt: string | Date | null | undefined,
  now: Date,
): { decidedAt: Date; requestedAt: Date | null; error?: string } {
  if (requestedAt == null || requestedAt === "") return { decidedAt: now, requestedAt: null };
  const t = new Date(requestedAt);
  if (Number.isNaN(t.getTime())) return { decidedAt: now, requestedAt: null, error: "Jam pelanggan membatalkan tidak valid." };
  if (t.getTime() > now.getTime())
    return { decidedAt: now, requestedAt: null, error: "Jam pelanggan membatalkan tidak boleh di masa depan." };
  if (t.getTime() < now.getTime() - REQUESTED_AT_MAX_AGE_MS)
    return { decidedAt: now, requestedAt: null, error: "Jam pelanggan membatalkan paling lama 3 hari yang lalu." };
  return { decidedAt: t, requestedAt: t };
}
