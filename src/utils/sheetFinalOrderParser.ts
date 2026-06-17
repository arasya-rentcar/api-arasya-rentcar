import crypto from "crypto";
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { computeMargin, MARGIN_FORMULA_VERSION } from "./margin";

/**
 * Decide if a sheet DRIVER/VENDOR cell is an external vendor.
 * Heuristic (TEN 2026-06-17): a parenthesis pattern like "Vendor(Driver)"
 * marks a sub-contracted vendor, and any name not in the internal-driver
 * allowlist is treated as external. Pass normalized internal nicknames.
 */
export function isExternalDriver(
  driverVendorRaw: string | null | undefined,
  internalNames: Set<string> = new Set(),
): boolean {
  const raw = (driverVendorRaw || "").trim();
  if (!raw) return false; // unknown -> treat as internal (no flat margin)
  if (raw.includes("(")) return true; // vendor(driver) sub-contract
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
  return !internalNames.has(key);
}

export const DEFAULT_ARASYA_SHEET_ID = "1atWWhrQwcCAi-ivqrc7RZtL45YRCEN-1efrJ9fODugs";
export const DEFAULT_ARASYA_GID = "0";

export const SHEET_HEADERS = [
  "FALSE",
  "CANCEL ",
  "REFUND/ CASHBACK",
  "LUNAS",
  "DP",
  "NO INVOICE ",
  "TANGGAL",
  "NAMA USER",
  "MOBIL",
  "RUTE",
  "DURASI",
  "PAKET",
  "DRIVER/VENDOR",
  "NOPOL",
  "HARGA JUAL",
  "RTR",
  "ADDITIONAL",
  "OT USER (RP)",
  "OT USER (JAM)",
  "PARKIR",
  "TOTAL USER",
  "TANGGAL PELUNASAN ",
  "BENSIN",
  "TOL",
  "FEE DRIVER",
  "OT DRIVER",
  "PARKIR CASH",
  "LAINNYA ",
  "KETERANGAN ",
  "TOTAL  DRIVER",
  "TANGGAL BAYAR",
  "TOTAL OPS COST",
  "HARGA SEWA UNIT",
  "MARGIN",
] as const;

export type SheetRow = Record<string, string>;

const CORE_FIELDS = [
  "NO INVOICE ",
  "TANGGAL",
  "NAMA USER",
  "MOBIL",
  "RUTE",
  "DURASI",
  "PAKET",
  "HARGA JUAL",
  "TOTAL USER",
];

export function cleanCell(value: unknown): string {
  return String(value ?? "").trim();
}

export function isTruthyCell(value: unknown): boolean {
  return ["true", "yes", "1", "checked"].includes(cleanCell(value).toLowerCase());
}

export function isMeaningfulOrderRow(row: SheetRow): boolean {
  return CORE_FIELDS.some((field) => cleanCell(row[field]));
}

export function parseMoney(value: unknown): number | null {
  let raw = cleanCell(value);
  if (!raw) return null;
  let negative = false;
  if (/^\(.+\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  raw = raw.replace(/rp/gi, "").replace(/\s+/g, "").replace(/,/g, "");
  if (!raw) return null;
  if (raw.startsWith("-")) negative = true;
  raw = raw.replace(/[^0-9.]/g, "");
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  februari: 1,
  february: 1,
  feb: 1,
  maret: 2,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  mei: 4,
  may: 4,
  juni: 5,
  june: 5,
  jun: 5,
  juli: 6,
  july: 6,
  jul: 6,
  agustus: 7,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  oktober: 9,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  desember: 11,
  december: 11,
  dec: 11,
};

export function parseSheetDate(value: unknown, defaultYear = 2026): Date | null {
  const raw = cleanCell(value).replace(/\s+/g, " ");
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)(?:\s+(\d{4}))?$/i);
  if (!match) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = match[3] ? Number(match[3]) : defaultYear;
  if (month === undefined) return null;
  const d = new Date(Date.UTC(year, month, day, 0, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

export function rowHash(row: SheetRow): string {
  return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function rowsFromCsv(text: string): { headers: string[]; rows: { rowNumber: number; row: SheetRow }[] } {
  const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
  const headers = parsed[0] || [];
  const rows = parsed.slice(1).map((cells, index) => {
    const row: SheetRow = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? "";
    });
    return { rowNumber: index + 2, row };
  });
  return { headers, rows };
}

export function fetchSheetCsvUrl(sheetId: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

export function buildOrderAndFinance(
  row: SheetRow,
  internalNames: Set<string> = new Set(),
) {
  const serviceDate = parseSheetDate(row["TANGGAL"]);
  const totalUser = parseMoney(row["TOTAL USER"]);
  const sellPrice = parseMoney(row["HARGA JUAL"]);
  const paid = isTruthyCell(row["LUNAS"]);
  const hasDp = parseMoney(row["DP"]) !== null;
  const cancelled = isTruthyCell(row["CANCEL "]);
  const customerName = cleanCell(row["NAMA USER"]) || "Imported customer";
  const route = cleanCell(row["RUTE"]);
  const vehicle = cleanCell(row["MOBIL"]);
  const duration = cleanCell(row["DURASI"]);
  const packageRaw = cleanCell(row["PAKET"]);
  const note = cleanCell(row["KETERANGAN "]);

  const externalForOrder = isExternalDriver(
    cleanCell(row["DRIVER/VENDOR"]) || null,
    internalNames,
  );
  const order = {
    order_code: cleanCell(row["NO INVOICE "]) || null,
    source: "IMPORT" as const,
    is_external: externalForOrder,
    customer_name: customerName,
    customer_phone: "-",
    pickup_location: route || "-",
    dropoff_location: route || "-",
    order_date: serviceDate || new Date(),
    service_start_at: serviceDate,
    final_price: totalUser ?? sellPrice ?? 0,
    service_type: duration || null,
    notes: note || null,
    area: route || null,
    raw_order_text: JSON.stringify(row),
    order_status: cancelled ? OrderStatus.CANCELLED : OrderStatus.CREATED,
    payment_status: paid ? PaymentStatus.PAID : hasDp ? PaymentStatus.DP_PAID : PaymentStatus.UNPAID,
  };

  const finance = {
    sheet_checked_raw: cleanCell(row["FALSE"]) || null,
    refund_cashback_raw: cleanCell(row["REFUND/ CASHBACK"]) || null,
    refund_cashback_amount: parseMoney(row["REFUND/ CASHBACK"]),
    invoice_no_raw: cleanCell(row["NO INVOICE "]) || null,
    service_date_raw: cleanCell(row["TANGGAL"]) || null,
    service_date: serviceDate,
    vehicle_raw: vehicle || null,
    route_raw: route || null,
    duration_raw: duration || null,
    package_raw: packageRaw || null,
    driver_vendor_raw: cleanCell(row["DRIVER/VENDOR"]) || null,
    plate_no_raw: cleanCell(row["NOPOL"]) || null,
    sell_price: sellPrice,
    rtr_amount: parseMoney(row["RTR"]),
    dp_amount: parseMoney(row["DP"]),
    additional_amount: parseMoney(row["ADDITIONAL"]),
    user_overtime_amount: parseMoney(row["OT USER (RP)"]),
    user_overtime_hours_raw: cleanCell(row["OT USER (JAM)"]) || null,
    parking_user_amount: parseMoney(row["PARKIR"]),
    total_user_amount: totalUser,
    paid_off_date_raw: cleanCell(row["TANGGAL PELUNASAN "]) || null,
    paid_off_date: parseSheetDate(row["TANGGAL PELUNASAN "]),
    fuel_amount: parseMoney(row["BENSIN"]),
    toll_amount: parseMoney(row["TOL"]),
    driver_fee_amount: parseMoney(row["FEE DRIVER"]),
    driver_overtime_amount: parseMoney(row["OT DRIVER"]),
    parking_cash_amount: parseMoney(row["PARKIR CASH"]),
    other_amount: parseMoney(row["LAINNYA "]),
    finance_note: note || null,
    total_driver_amount: parseMoney(row["TOTAL  DRIVER"]),
    driver_paid_date_raw: cleanCell(row["TANGGAL BAYAR"]) || null,
    driver_paid_date: parseSheetDate(row["TANGGAL BAYAR"]),
    total_ops_cost: parseMoney(row["TOTAL OPS COST"]),
    unit_rental_price: parseMoney(row["HARGA SEWA UNIT"]),
    margin_amount: parseMoney(row["MARGIN"]),
    margin_formula_version: null as string | null,
    raw_row_json: row,
  };

  // Compute margin when the sheet did not already provide one.
  const isExternal = isExternalDriver(finance.driver_vendor_raw, internalNames);
  if (finance.margin_amount == null) {
    finance.margin_amount = computeMargin({
      isExternal,
      total_user_amount: finance.total_user_amount,
      total_ops_cost: finance.total_ops_cost,
      sell_price: finance.sell_price,
      rtr_amount: finance.rtr_amount,
    });
    finance.margin_formula_version = MARGIN_FORMULA_VERSION;
  }

  const warnings: string[] = [];
  if (cleanCell(row["TANGGAL"]) && !serviceDate) warnings.push(`Could not parse service date: ${row["TANGGAL"]}`);
  if (cleanCell(row["TANGGAL PELUNASAN "]) && !finance.paid_off_date) warnings.push(`Could not parse paid-off date: ${row["TANGGAL PELUNASAN "]}`);
  if (cleanCell(row["TANGGAL BAYAR"]) && !finance.driver_paid_date) warnings.push(`Could not parse driver-paid date: ${row["TANGGAL BAYAR"]}`);

  return { order, finance, warnings };
}
