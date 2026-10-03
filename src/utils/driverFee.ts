/**
 * Driver pay rules (owner, 3 Oct 2026). Single source for the fee table the
 * dashboard shows as quick buttons in "Edit Hari" and for the default fee a
 * line gets when an internal driver is first assigned. All fees include meals.
 */

export interface DriverFeePreset {
  key: string;
  label: string;
  amount: number;
}

/** Day fee for the whole day (choose one). */
export const DRIVER_FEE_BASE: DriverFeePreset[] = [
  { key: "DROP", label: "Drop (Jabodetabek)", amount: 100_000 },
  { key: "12H", label: "12 jam (Jabodetabek)", amount: 200_000 },
  { key: "FULLDAY", label: "Full day (Jabodetabek)", amount: 250_000 },
  { key: "OUT_NEAR", label: "Luar kota: Bandung/Cilegon/Cirebon", amount: 250_000 },
  { key: "OUT_FAR", label: "Luar kota lebih jauh", amount: 300_000 },
  { key: "SEMARANG_PP", label: "Semarang pulang-pergi (1 hari)", amount: 400_000 },
];

/** Add-ons on top of the day fee (per night / per hour). */
export const DRIVER_FEE_ADDONS = {
  overnight: { label: "Menginap", unit: "malam", amount: 150_000 },
  overtime: { label: "Overtime", unit: "jam", amount: 30_000 },
} as const;

/** Default day fee from the line's duration (service_kind). */
export function defaultDriverFee(serviceKind: string | null | undefined): {
  amount: number;
  note: string;
} {
  const kind = (serviceKind ?? "").toUpperCase();
  const preset =
    DRIVER_FEE_BASE.find((p) => p.key === kind) ??
    DRIVER_FEE_BASE.find((p) => p.key === "12H")!;
  return { amount: preset.amount, note: preset.label };
}

/**
 * Whether a trip cost of this type is paid by the customer under the line's
 * package: "ALL-IN X PARKIR" excludes parking, "XOPS" excludes fuel, tolls and
 * parking. Those costs are billed to the customer (Invoice Tambahan).
 */
export function billedToCustomerByPackage(
  servicePackage: string | null | undefined,
  type: "FUEL" | "TOLL" | "PARKING" | "OTHER",
): boolean {
  const pkg = (servicePackage ?? "").toUpperCase().trim();
  if (pkg === "XOPS") return type === "FUEL" || type === "TOLL" || type === "PARKING";
  if (pkg === "ALL-IN X PARKIR") return type === "PARKING";
  return false;
}
