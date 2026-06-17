import prisma from "../../prisma/client";
import {
  DEFAULT_ARASYA_GID,
  DEFAULT_ARASYA_SHEET_ID,
  buildOrderAndFinance,
  fetchSheetCsvUrl,
  isMeaningfulOrderRow,
  rowHash,
  rowsFromCsv,
  cleanCell,
  type SheetRow,
} from "../../utils/sheetFinalOrderParser";
import { findOrCreateCustomer } from "../customers/customers.service";
import {
  findOrCreateVendor,
  findOrCreateVendorCar,
} from "../external-vendors/external-vendors.service";
import {
  computeLineMargin,
  MARGIN_FORMULA_VERSION,
} from "../../utils/margin";
import type { Prisma } from "@prisma/client";

function normKey(value = ""): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Map sheet DRIVER/VENDOR nicknames to internal driver ids. Keys: full name,
 * the part inside parentheses, and the bare first token. First-token keys that
 * would be ambiguous (collide across drivers) are dropped.
 */
async function loadInternalDriverMap(): Promise<Map<string, string>> {
  const drivers = await prisma.driver.findMany({
    where: { type: "INTERNAL" },
    select: { id: true, name: true },
  });
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (key: string, id: string) => {
    if (!key || ambiguous.has(key)) return;
    const existing = map.get(key);
    if (existing && existing !== id) {
      map.delete(key);
      ambiguous.add(key);
      return;
    }
    map.set(key, id);
  };
  for (const d of drivers) {
    const full = normKey(d.name);
    add(full, d.id);
    const m = d.name.match(/\(([^)]+)\)/);
    if (m) add(normKey(m[1]), d.id);
    const first = full.split(" ")[0];
    if (first) add(first, d.id);
  }
  return map;
}

function resolveInternalDriverId(
  driverVendorRaw: string | null | undefined,
  map: Map<string, string>,
): string | null {
  const raw = (driverVendorRaw || "").trim();
  if (!raw) return null;
  // try full, then the part inside parens, then first token
  const candidates = [normKey(raw)];
  const m = raw.match(/\(([^)]+)\)/);
  if (m) candidates.push(normKey(m[1]));
  const noParen = normKey(raw.replace(/\([^)]*\)/g, " "));
  if (noParen) {
    candidates.push(noParen);
    candidates.push(noParen.split(" ")[0]);
  }
  for (const c of candidates) {
    const id = map.get(c);
    if (id) return id;
  }
  return null;
}

/** Map internal cars by plate_number and unit_code (lowercased) to car id. */
async function loadInternalCarMap(): Promise<Map<string, string>> {
  const cars = await prisma.car.findMany({
    select: { id: true, plate_number: true, unit_code: true },
  });
  const map = new Map<string, string>();
  for (const c of cars) {
    if (c.plate_number) map.set(normKey(c.plate_number), c.id);
    if (c.unit_code) map.set(normKey(c.unit_code), c.id);
  }
  return map;
}

function resolveInternalCarId(
  plateRaw: string | null | undefined,
  map: Map<string, string>,
): string | null {
  const key = normKey(plateRaw || "");
  if (!key) return null;
  return map.get(key) || null;
}

type ImportOptions = {
  sheetId?: string;
  gid?: string;
  csvText?: string;
  url?: string;
};

async function loadCsv(options: ImportOptions) {
  if (options.csvText) return options.csvText;
  const sheetId = options.sheetId || DEFAULT_ARASYA_SHEET_ID;
  const gid = options.gid || DEFAULT_ARASYA_GID;
  const url = options.url || fetchSheetCsvUrl(sheetId, gid);
  const res = await fetch(url, { headers: { "user-agent": "ArasyaSheetImporter/1.0" } });
  if (!res.ok) throw new Error(`Failed to fetch sheet CSV: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Build a set of internal-driver nicknames (lowercased, including the part
 * inside parentheses) so the importer can flag external vendors correctly.
 */
async function loadInternalDriverNames(): Promise<Set<string>> {
  const drivers = await prisma.driver.findMany({
    where: { type: "INTERNAL" },
    select: { name: true },
  });
  const set = new Set<string>();
  for (const d of drivers) {
    const full = d.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (full) set.add(full);
    // also index the name inside parentheses, e.g. "Hary Priyatna ( Donal )"
    const m = d.name.match(/\(([^)]+)\)/);
    if (m) {
      const inner = m[1].toLowerCase().replace(/\s+/g, " ").trim();
      if (inner) set.add(inner);
    }
    // and the bare first token, e.g. "Rori Afridal" -> "rori"
    const first = full.split(" ")[0];
    if (first) set.add(first);
  }
  return set;
}

export async function previewSheetImport(options: ImportOptions = {}) {
  const csv = await loadCsv(options);
  const { headers, rows } = rowsFromCsv(csv);
  const internalNames = await loadInternalDriverNames();
  const meaningful = rows.filter(({ row }) => isMeaningfulOrderRow(row));
  const parsed = meaningful.map(({ rowNumber, row }) => {
    const built = buildOrderAndFinance(row, internalNames);
    return {
      row_number: rowNumber,
      row_hash: rowHash(row),
      order: built.order,
      finance: built.finance,
      warnings: built.warnings,
    };
  });

  return {
    sheet_id: options.sheetId || DEFAULT_ARASYA_SHEET_ID,
    gid: options.gid || DEFAULT_ARASYA_GID,
    headers,
    total_rows: rows.length,
    meaningful_rows: meaningful.length,
    skipped_rows: rows.length - meaningful.length,
    warning_count: parsed.reduce((sum, r) => sum + r.warnings.length, 0),
    samples: parsed.slice(0, 10),
  };
}

/**
 * Each sheet row = one day of work. We group rows into orders so that
 *   1 invoice (+ same customer) = 1 order with N day-lines.
 * Rows with NO invoice each become their own single-day order (decision A:
 * never guess-merge — manual merge can happen later in the dashboard).
 */
function invoiceOf(row: SheetRow): string {
  const raw = cleanCell(row["NO INVOICE "]);
  // Treat placeholder text as "no invoice".
  if (!raw || /^(no invoice|-|n\/a|none)$/i.test(raw)) return "";
  return raw;
}

function groupKeyFor(row: SheetRow, rowNumber: number): string {
  const invoice = invoiceOf(row);
  const customer = normKey(cleanCell(row["NAMA USER"]));
  if (invoice) return `inv:${invoice.toLowerCase()}|${customer}`;
  // No invoice -> unique per row so it stands alone.
  return `row:${rowNumber}`;
}

function slug(value = ""): string {
  return normKey(value).replace(/\s+/g, "-").slice(0, 24);
}

export async function importSheetRows(options: ImportOptions = {}) {
  const sheetId = options.sheetId || DEFAULT_ARASYA_SHEET_ID;
  const gid = options.gid || DEFAULT_ARASYA_GID;
  const csv = await loadCsv({ ...options, sheetId, gid });
  const { rows } = rowsFromCsv(csv);
  const internalNames = await loadInternalDriverNames();
  const internalDriverMap = await loadInternalDriverMap();
  const internalCarMap = await loadInternalCarMap();
  const meaningful = rows.filter(({ row }) => isMeaningfulOrderRow(row));

  // 1) Group rows by invoice(+customer); no-invoice rows stand alone.
  const groups = new Map<
    string,
    { key: string; rows: { rowNumber: number; row: SheetRow }[] }
  >();
  for (const entry of meaningful) {
    const key = groupKeyFor(entry.row, entry.rowNumber);
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key)!.rows.push(entry);
  }

  // Detect invoice numbers shared by >1 customer group, so we can keep their
  // order_code unique (append a customer slug only when actually needed).
  const invoiceGroupCount = new Map<string, number>();
  for (const g of groups.values()) {
    const inv = invoiceOf(g.rows[0].row).toLowerCase();
    if (inv) invoiceGroupCount.set(inv, (invoiceGroupCount.get(inv) || 0) + 1);
  }

  let imported = 0;
  let updated = 0;
  let lineCount = 0;
  const results: {
    group: string;
    order_id?: string;
    lines: number;
    status: string;
    warnings: string[];
  }[] = [];

  for (const group of groups.values()) {
    // Sort day-lines chronologically.
    const sorted = [...group.rows].sort((a, b) => {
      const da = buildOrderAndFinance(a.row, internalNames).finance.service_date;
      const db = buildOrderAndFinance(b.row, internalNames).finance.service_date;
      return (da?.getTime() ?? 0) - (db?.getTime() ?? 0);
    });
    const first = buildOrderAndFinance(sorted[0].row, internalNames);
    const warnings = sorted.flatMap(
      (r) => buildOrderAndFinance(r.row, internalNames).warnings,
    );

    const result = await prisma.$transaction(async (tx) => {
      // Has any row of this group already been imported? Reuse its order.
      const existing = await tx.sheetImportRow.findFirst({
        where: {
          sheet_id: sheetId,
          gid,
          row_number: { in: sorted.map((r) => r.rowNumber) },
          order_id: { not: null },
        },
        select: { order_id: true },
      });
      let orderId = existing?.order_id || null;

      const { customer } = await findOrCreateCustomer(tx, {
        name: first.order.customer_name,
        phone: null,
      });

      // Build the per-day schedule lines (with assignment + margin).
      const lineCreates: Prisma.OrderServiceItemUncheckedCreateWithoutOrderInput[] = [];
      let orderRevenue = 0;
      let orderOps = 0;
      let orderMargin = 0;
      let anyExternal = false;
      let groupVendorId: string | null = null;
      let groupVendorCarId: string | null = null;

      for (let i = 0; i < sorted.length; i++) {
        const b = buildOrderAndFinance(sorted[i].row, internalNames);
        const f = b.finance;
        const dayExternal = b.order.is_external;
        if (dayExternal) anyExternal = true;

        const revenue = Number(f.total_user_amount ?? f.sell_price ?? 0);
        const ops = Number(f.total_ops_cost ?? 0);
        const rtr = f.rtr_amount != null ? Number(f.rtr_amount) : null;
        const lineMargin = computeLineMargin({
          isExternal: dayExternal,
          revenue,
          ops_cost: ops,
          rtr_amount: rtr,
        });
        orderRevenue += revenue;
        orderOps += ops;
        orderMargin += lineMargin;

        // Resolve assignment for this day.
        let driverId: string | null = null;
        let carId: string | null = null;
        let lineVendorId: string | null = null;
        let lineVendorCarId: string | null = null;
        if (dayExternal) {
          const vendorName = (f.driver_vendor_raw || "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim();
          if (vendorName) {
            const vendor = await findOrCreateVendor(tx, { name: vendorName });
            if (vendor) {
              lineVendorId = vendor.id;
              groupVendorId = groupVendorId || vendor.id;
              const car = await findOrCreateVendorCar(tx, vendor.id, {
                model: f.vehicle_raw,
                plate_number: f.plate_no_raw,
              });
              lineVendorCarId = car?.id ?? null;
              groupVendorCarId = groupVendorCarId || lineVendorCarId;
            }
          }
        } else {
          driverId = resolveInternalDriverId(f.driver_vendor_raw, internalDriverMap);
          carId = resolveInternalCarId(f.plate_no_raw, internalCarMap);
        }

        lineCreates.push({
          service_date: f.service_date,
          start_at: f.service_date,
          description: f.vehicle_raw || null,
          service_kind: f.duration_raw || null,
          pickup_location: b.order.pickup_location,
          dropoff_location: b.order.dropoff_location,
          unit_price: revenue,
          total_price: revenue,
          notes: f.package_raw || null,
          sort_order: i,
          is_external: dayExternal,
          line_status:
            b.order.order_status === "CANCELLED" ? "CANCELLED" : "DONE",
          driver_id: driverId,
          car_id: carId,
          external_vendor_id: lineVendorId,
          external_car_id: lineVendorCarId,
          driver_name_raw: f.driver_vendor_raw || null,
          plate_raw: f.plate_no_raw || null,
          rtr_amount: rtr,
          ops_cost: ops,
          margin_amount: lineMargin,
          margin_formula_version: MARGIN_FORMULA_VERSION,
        });
      }
      lineCount += lineCreates.length;

      const lastDate =
        buildOrderAndFinance(sorted[sorted.length - 1].row, internalNames)
          .finance.service_date;

      const orderFields = {
        source: "IMPORT" as const,
        customer_name: first.order.customer_name,
        customer_phone: first.order.customer_phone,
        customer_id: customer.id,
        is_external: anyExternal,
        external_vendor_id: anyExternal ? groupVendorId : null,
        external_car_id: anyExternal ? groupVendorCarId : null,
        pickup_location: first.order.pickup_location,
        dropoff_location: first.order.dropoff_location,
        order_date: first.order.order_date,
        service_start_at: first.finance.service_date,
        service_end_at: lastDate,
        final_price: orderRevenue,
        service_type: first.order.service_type,
        notes: first.order.notes,
        area: first.order.area,
        raw_order_text: first.order.raw_order_text,
        order_status: first.order.order_status,
        payment_status: first.order.payment_status,
      };

      if (orderId) {
        await tx.order.update({ where: { id: orderId }, data: orderFields });
        // Replace day-lines so re-import stays idempotent.
        await tx.orderServiceItem.deleteMany({ where: { order_id: orderId } });
        for (const line of lineCreates) {
          await tx.orderServiceItem.create({
            data: { ...line, order_id: orderId },
          });
        }
        updated += 1;
      } else {
        const invoice = invoiceOf(sorted[0].row);
        let orderCode: string;
        if (invoice) {
          const shared =
            (invoiceGroupCount.get(invoice.toLowerCase()) || 0) > 1;
          orderCode = shared
            ? `${invoice}-${slug(first.order.customer_name)}`
            : invoice;
        } else {
          orderCode = `sheet-${sheetId}-${gid}-${sorted[0].rowNumber}`;
        }
        const created = await tx.order.create({
          data: {
            ...orderFields,
            order_code: orderCode,
            customers: {
              create: [
                { name: first.order.customer_name, phone: null, is_primary: true },
              ],
            },
            service_items: { create: lineCreates },
          },
        });
        orderId = created.id;
        imported += 1;
      }

      // Order-level finance summary: keep the first row's raw finance for
      // reference, but stamp the ROLLED-UP totals + margin from the day-lines.
      const financeData = {
        ...first.finance,
        total_user_amount: orderRevenue,
        total_ops_cost: orderOps,
        margin_amount: orderMargin,
        margin_formula_version: MARGIN_FORMULA_VERSION,
      };
      await tx.orderFinalFinance.upsert({
        where: { order_id: orderId },
        update: financeData,
        create: { ...financeData, order_id: orderId },
      });

      // Record every row of this group as imported -> this order.
      for (const { rowNumber, row } of sorted) {
        await tx.sheetImportRow.upsert({
          where: {
            sheet_id_gid_row_number: { sheet_id: sheetId, gid, row_number: rowNumber },
          },
          update: {
            row_hash: rowHash(row),
            raw_json: row,
            order_id: orderId,
            status: "IMPORTED",
            warnings,
          },
          create: {
            sheet_id: sheetId,
            gid,
            row_number: rowNumber,
            row_hash: rowHash(row),
            raw_json: row,
            order_id: orderId,
            status: "IMPORTED",
            warnings,
          },
        });
      }

      return {
        group: group.key,
        order_id: orderId,
        lines: lineCreates.length,
        status: "IMPORTED",
        warnings,
      };
    }, { timeout: 30000 });

    results.push(result);
  }

  return {
    sheet_id: sheetId,
    gid,
    total_rows: rows.length,
    meaningful_rows: meaningful.length,
    orders_created: imported,
    orders_updated: updated,
    day_lines: lineCount,
    warning_count: results.reduce((sum, r) => sum + r.warnings.length, 0),
    results: results.slice(0, 50),
  };
}

export async function latestSheetImportRows() {
  return prisma.sheetImportRow.findMany({
    orderBy: [{ updated_at: "desc" }],
    take: 100,
    include: { order: { select: { id: true, customer_name: true, order_code: true } } },
  });
}
