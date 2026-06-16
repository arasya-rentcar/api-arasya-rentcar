import prisma from "../../prisma/client";
import {
  DEFAULT_ARASYA_GID,
  DEFAULT_ARASYA_SHEET_ID,
  buildOrderAndFinance,
  fetchSheetCsvUrl,
  isMeaningfulOrderRow,
  rowHash,
  rowsFromCsv,
} from "../../utils/sheetFinalOrderParser";

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

export async function previewSheetImport(options: ImportOptions = {}) {
  const csv = await loadCsv(options);
  const { headers, rows } = rowsFromCsv(csv);
  const meaningful = rows.filter(({ row }) => isMeaningfulOrderRow(row));
  const parsed = meaningful.map(({ rowNumber, row }) => {
    const built = buildOrderAndFinance(row);
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

export async function importSheetRows(options: ImportOptions = {}) {
  const sheetId = options.sheetId || DEFAULT_ARASYA_SHEET_ID;
  const gid = options.gid || DEFAULT_ARASYA_GID;
  const csv = await loadCsv({ ...options, sheetId, gid });
  const { rows } = rowsFromCsv(csv);
  const meaningful = rows.filter(({ row }) => isMeaningfulOrderRow(row));

  let imported = 0;
  let updated = 0;
  const results: { row_number: number; order_id?: string; status: string; warnings: string[] }[] = [];

  for (const { rowNumber, row } of meaningful) {
    const built = buildOrderAndFinance(row);
    const hash = rowHash(row);
    const existingImport = await prisma.sheetImportRow.findUnique({
      where: { sheet_id_gid_row_number: { sheet_id: sheetId, gid, row_number: rowNumber } },
    });

    const orderData = built.order;
    const financeData = built.finance;

    const result = await prisma.$transaction(async (tx) => {
      let orderId = existingImport?.order_id || null;
      if (orderId) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            customer_name: orderData.customer_name,
            customer_phone: orderData.customer_phone,
            pickup_location: orderData.pickup_location,
            dropoff_location: orderData.dropoff_location,
            order_date: orderData.order_date,
            service_start_at: orderData.service_start_at,
            final_price: orderData.final_price,
            service_type: orderData.service_type,
            notes: orderData.notes,
            area: orderData.area,
            raw_order_text: orderData.raw_order_text,
            order_status: orderData.order_status,
            payment_status: orderData.payment_status,
          },
        });
        updated += 1;
      } else {
        const created = await tx.order.create({
          data: {
            ...orderData,
            order_code: orderData.order_code ? `${orderData.order_code}#sheet-${rowNumber}` : `sheet-${sheetId}-${gid}-${rowNumber}`,
            customers: { create: [{ name: orderData.customer_name, phone: null, is_primary: true }] },
            service_items: {
              create: [{
                service_date: orderData.service_start_at,
                start_at: orderData.service_start_at,
                description: financeData.vehicle_raw || null,
                service_kind: orderData.service_type,
                pickup_location: orderData.pickup_location,
                dropoff_location: orderData.dropoff_location,
                unit_price: orderData.final_price,
                total_price: orderData.final_price,
                notes: financeData.package_raw || null,
              }],
            },
          },
        });
        orderId = created.id;
        imported += 1;
      }

      await tx.orderFinalFinance.upsert({
        where: { order_id: orderId },
        update: financeData,
        create: { ...financeData, order_id: orderId },
      });

      await tx.sheetImportRow.upsert({
        where: { sheet_id_gid_row_number: { sheet_id: sheetId, gid, row_number: rowNumber } },
        update: {
          row_hash: hash,
          raw_json: row,
          order_id: orderId,
          status: "IMPORTED",
          warnings: built.warnings,
        },
        create: {
          sheet_id: sheetId,
          gid,
          row_number: rowNumber,
          row_hash: hash,
          raw_json: row,
          order_id: orderId,
          status: "IMPORTED",
          warnings: built.warnings,
        },
      });

      return { row_number: rowNumber, order_id: orderId, status: "IMPORTED", warnings: built.warnings };
    });

    results.push(result);
  }

  return {
    sheet_id: sheetId,
    gid,
    total_rows: rows.length,
    meaningful_rows: meaningful.length,
    imported,
    updated,
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
