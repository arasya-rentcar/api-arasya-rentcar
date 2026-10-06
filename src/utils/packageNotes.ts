/**
 * What the price includes, printed under the invoice table (2026-10-06). The
 * wording follows the package of the order's days (PRICE.md §1): All-in
 * ("ALL-IN", and for now "ALL-IN X PARKIR" too, owner decision) includes fuel,
 * tolls and the driver's meals; X Ops ("XOPS") is the car and driver only.
 * Cancelled days are left out (all of them only when every day is cancelled).
 * An order with both packages gets one prefixed pair per package, in the
 * order the days list them. Unknown or empty = All-in.
 */
type PackageNotes = { label: string; lines: string[] };

const ALL_IN: PackageNotes = {
  label: "All-in",
  lines: [
    "Harga termasuk mobil supir bbm tol makan supir",
    "Parkir/tiket masuk kawasan dan tips supir seikhlasnya dari Tamu",
  ],
};

const XOPS: PackageNotes = {
  label: "X Ops",
  lines: [
    "Harga termasuk mobil dan supir",
    "Belum termasuk BBM, tol, parkir/tiket masuk kawasan, dan makan supir; tips supir seikhlasnya dari Tamu",
  ],
};

const notesFor = (servicePackage: string | null | undefined) =>
  (servicePackage ?? "").toUpperCase().trim() === "XOPS" ? XOPS : ALL_IN;

export function packageNoteLines(
  items: { service_package?: string | null; line_status?: string | null }[],
): string[] {
  const live = items.filter((i) => i.line_status !== "CANCELLED");
  const groups: PackageNotes[] = [];
  for (const i of live.length ? live : items) {
    const g = notesFor(i.service_package);
    if (!groups.includes(g)) groups.push(g);
  }
  if (groups.length === 0) return [...ALL_IN.lines];
  if (groups.length === 1) return [...groups[0].lines];
  return groups.flatMap((g) => g.lines.map((l) => `Paket ${g.label}: ${l}`));
}
