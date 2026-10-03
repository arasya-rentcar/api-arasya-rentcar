const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7, no DST.
const DAY_MS = 24 * 60 * 60 * 1000;

/** WIB midnight of the WIB calendar day that `now` falls on, as an instant. */
export function wibStartOfDay(now = new Date()): Date {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  return new Date(
    Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()) - WIB_OFFSET_MS,
  );
}

/**
 * Start of yesterday (WIB). An open trip dated before this is "old": the driver
 * app no longer lists it unless it is IN_PROGRESS, and the dashboard lists it
 * under "Belum ditutup" so an admin can finish or cancel it.
 */
export function staleTripCutoff(now = new Date()): Date {
  return new Date(wibStartOfDay(now).getTime() - DAY_MS);
}

/** Short WIB calendar day for messages and labels, e.g. "3 Okt" ("" when unset). */
export function wibShortDay(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short" });
}
