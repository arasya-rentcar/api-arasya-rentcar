/*
 * Import the Jadwal_ARASYA workbook (multi-tab xlsx) into the DB.
 *
 *   node scripts/import-workbook.js --months "JUNI 2026"            # one month
 *   node scripts/import-workbook.js --all                           # all 6 months
 *   node scripts/import-workbook.js --months "JUNI 2026" --dry      # no writes
 *
 * Rules:
 *  - 1 invoice (+ same customer) = 1 order with N day-lines.
 *  - No-invoice rows stand alone (code NOINV-<MON>-<n>), invoice_missing=true.
 *  - CANCEL=TRUE -> order_status CANCELLED. REFUND -> is_refunded=true.
 *  - FINAL=TRUE -> is_final=true (no more charges, fully done).
 *  - Internal driver matched by nickname/alias; else external vendor.
 *  - Car matched by plate/unit, with obvious-typo auto-fix (unit-code suffix).
 *  - Per-day margin: internal=revenue-ops ; external=revenue-rtr.
 *  - Idempotent: re-running deletes+recreates an order's day-lines.
 */
const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const FILE = process.env.SHEET_FILE ||
  '/root/.openclaw/media/inbound/Jadwal_ARASYA_2026---1488102f-ea66-44ee-9def-f3e1c831b36f.xlsx';
const SHEET_ID = 'JADWAL_ARASYA_2026_XLSX';
const MARGIN_FORMULA_VERSION = 'v2-2026-06-17';
const ALL_MONTHS = ['JAN2026', 'FEB2026 ', 'MARET2026', 'APRIL2026', 'MEI 2026', 'JUNI 2026'];
const MONTH_CODE = { JAN2026: 'JAN', 'FEB2026 ': 'FEB', MARET2026: 'MAR', APRIL2026: 'APR', 'MEI 2026': 'MEI', 'JUNI 2026': 'JUN' };
const MONTH_NUM = { JAN2026: 0, 'FEB2026 ': 1, MARET2026: 2, APRIL2026: 3, 'MEI 2026': 4, 'JUNI 2026': 5 };

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
let MONTHS;
if (args.includes('--all')) MONTHS = ALL_MONTHS;
else {
  const mi = args.indexOf('--months');
  MONTHS = mi >= 0 && args[mi + 1] ? [args[mi + 1]] : ['JUNI 2026'];
}

// ---------- helpers ----------
const norm = (s) => (s || '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
const clean = (s) => (s || '').toString().trim();
const normKey = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const money = (s) => {
  const t = clean(s).replace(/[^0-9.-]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const slug = (s) => normKey(s).replace(/\s+/g, '-').slice(0, 24);

const ID_MONTHS = { JANUARY: 0, JANUARI: 0, FEBRUARY: 1, FEBRUARI: 1, MARCH: 2, MARET: 2,
  APRIL: 3, MAY: 4, MEI: 4, JUNE: 5, JUNI: 5, JULY: 6, JULI: 6, AUGUST: 7, AGUSTUS: 7,
  SEPTEMBER: 8, OCTOBER: 9, OKTOBER: 9, NOVEMBER: 10, DECEMBER: 11, DESEMBER: 11,
  JAN: 0, FEB: 1, MAR: 2, APR: 3, JUN: 5, JUL: 6, AGU: 7, SEP: 8, OKT: 9, NOV: 10, DES: 11 };

function parseDate(raw, monthNum, year = 2026) {
  const t = clean(raw);
  if (!t) return null;
  // "1 June 2026" / "1 Juni 2026"
  let m = t.match(/(\d{1,2})\s+([A-Za-z]+)\s*(\d{4})?/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = ID_MONTHS[m[2].toUpperCase()];
    const yr = m[3] ? parseInt(m[3], 10) : year;
    if (mon != null && day >= 1 && day <= 31) return new Date(Date.UTC(yr, mon, day));
  }
  // "1-Jan"
  m = t.match(/(\d{1,2})-([A-Za-z]+)/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = ID_MONTHS[m[2].toUpperCase()];
    if (mon != null) return new Date(Date.UTC(year, mon, day));
  }
  // bare day number -> use the tab's month
  m = t.match(/^(\d{1,2})$/);
  if (m && monthNum != null) return new Date(Date.UTC(year, monthNum, parseInt(m[1], 10)));
  return null;
}

// ---------- driver & car matching ----------
const DRIVER_ALIAS = {
  FAENDRY: 'Idwin Faendri', FAENDRI: 'Idwin Faendri', IDWIN: 'Idwin Faendri',
  MARTIN: 'Aldi Martin', ALDI: 'Aldi Martin',
  DONAL: 'Hary Priyatna ( Donal )', HARY: 'Hary Priyatna ( Donal )',
  RIZKI: 'Mochamad Rizki Aulia Rohendi', ILYAS: 'Muhammad ilyas Ruhyat',
  YOSUEF: 'Yosuef Novian Haditama', YOSEP: 'Yosuef Novian Haditama',
  SUTAN: 'Sutan Arief', RORI: 'Rori Afridal', RULI: 'Ruli Awan', IWAN: 'Iwan',
};

async function loadDrivers() {
  const drivers = await prisma.driver.findMany({ where: { type: 'INTERNAL' }, select: { id: true, name: true } });
  const idx = {};
  const ambig = new Set();
  const add = (k, id) => {
    if (!k || ambig.has(k)) return;
    if (idx[k] && idx[k] !== id) { delete idx[k]; ambig.add(k); return; }
    idx[k] = id;
  };
  const byName = {};
  for (const d of drivers) {
    byName[d.name] = d.id;
    const full = norm(d.name);
    add(full, d.id);
    const paren = d.name.match(/\(([^)]+)\)/);
    if (paren) add(norm(paren[1]), d.id);
    const base = norm(d.name.replace(/\([^)]*\)/g, ''));
    add(base, d.id);
    base.split(' ').forEach((tok) => { if (tok.length >= 3) add(tok, d.id); });
  }
  return { idx, byName };
}

function resolveDriverId(name, drv) {
  const n = norm(name);
  if (!n) return null;
  const hasVendorMark = /\(\s*V\s*\)/.test(n) || /VENDOR/.test(n) || /^TEMEN /.test(n);
  const base = n.replace(/\([^)]*\)/g, '').trim();
  if (drv.idx[n]) return drv.idx[n];
  if (hasVendorMark) return null;
  const alias = DRIVER_ALIAS[base] || DRIVER_ALIAS[base.split(' ')[0]];
  if (alias && drv.byName[alias]) return drv.byName[alias];
  if (drv.idx[base]) return drv.idx[base];
  const first = base.split(' ')[0];
  if (drv.idx[first]) return drv.idx[first];
  return null;
}

async function loadCars() {
  const cars = await prisma.car.findMany({ select: { id: true, plate_number: true, unit_code: true, model: true } });
  const byPlate = {}; const byUnit = {}; const bySuffix = {};
  for (const c of cars) {
    if (c.plate_number) byPlate[norm(c.plate_number).replace(/\s+/g, '')] = c.id;
    if (c.unit_code) {
      byUnit[norm(c.unit_code)] = c.id;
      // last token of plate is usually the unit code (F 1497 ACB -> ACB)
      bySuffix[norm(c.unit_code)] = c.id;
    }
  }
  return { byPlate, byUnit, bySuffix };
}

// Returns { id, fixed } where fixed=true means we matched via typo-tolerant suffix.
function resolveCarId(nopol, mobil, cars) {
  const np = norm(nopol).replace(/\s+/g, '');
  if (np && cars.byPlate[np]) return { id: cars.byPlate[np], fixed: false };
  const npSpaced = norm(nopol);
  if (npSpaced && cars.byUnit[npSpaced]) return { id: cars.byUnit[npSpaced], fixed: false };
  // typo-tolerant: take the trailing letter-group of NOPOL and match unit code
  const suffix = (norm(nopol).match(/([A-Z]{2,4})\s*$/) || [])[1];
  if (suffix && cars.bySuffix[suffix]) return { id: cars.bySuffix[suffix], fixed: true };
  const mb = norm(mobil);
  if (mb && cars.byUnit[mb]) return { id: cars.byUnit[mb], fixed: false };
  return { id: null, fixed: false };
}

function invoiceOf(v) {
  const t = clean(v);
  if (!t) return '';
  if (/^(no\s*invoice|-|n\/?a|none|tba|tbc)$/i.test(t)) return '';
  return t;
}

function computeLineMargin({ isExternal, revenue, ops_cost, rtr_amount }) {
  if (isExternal) return revenue - (rtr_amount || 0);
  return revenue - (ops_cost || 0);
}

// ---------- read rows from a tab ----------
function readTab(wb, tab) {
  const ws = wb.Sheets[tab];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const hdr = rows[0].map(norm);
  const ix = (n) => hdr.indexOf(n);
  // FINAL col: header cell is sometimes literally "FALSE"/"FINAL"/"FIINAL" -> always index 0 in Apr-Jun layout;
  // Jan-Mar layout has no FINAL/CANCEL columns at all.
  const has3 = ix('CANCEL') >= 0 || hdr[0] === 'FALSE' || hdr[0] === 'FINAL' || hdr[0] === 'FIINAL';
  const iFinal = has3 ? 0 : -1;
  const iCancel = ix('CANCEL');
  const iRefund = ix('REFUND/ CASHBACK') >= 0 ? ix('REFUND/ CASHBACK') : ix('REFUND/CASHBACK');
  const iInv = ix('NO INVOICE'), iDate = ix('TANGGAL') >= 0 ? ix('TANGGAL') : ix('TGL'),
    iName = ix('NAMA USER'), iHp = ix('NO HP'), iMobil = ix('MOBIL'), iRute = ix('RUTE'),
    iDur = ix('DURASI'), iPkt = ix('PAKET'),
    iDrv = ix('DRIVER/VENDOR') >= 0 ? ix('DRIVER/VENDOR') : ix('DRIVER'),
    iNopol = ix('NOPOL'), iJual = ix('HARGA JUAL'), iRtr = ix('RTR'),
    iAdd = ix('ADDITIONAL'), iPark = ix('PARKIR'), iTotU = ix('TOTAL USER'),
    iKet = ix('KETERANGAN'), iOps = ix('TOTAL OPS COST'), iDp = ix('DP'), iLunas = ix('LUNAS');
  const monthNum = MONTH_NUM[tab];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[iName]);
    if (!name) continue;
    out.push({
      tab, rowNumber: i, name,
      hp: clean(r[iHp]),
      isFinal: iFinal >= 0 ? norm(r[iFinal]) === 'TRUE' : false,
      cancelled: iCancel >= 0 ? norm(r[iCancel]) === 'TRUE' : false,
      refund: iRefund >= 0 ? clean(r[iRefund]) !== '' : false,
      dp: money(r[iDp]),
      lunas: norm(r[iLunas]) === 'TRUE',
      invoice: invoiceOf(r[iInv]),
      date: parseDate(r[iDate], monthNum),
      dateRaw: clean(r[iDate]),
      mobil: clean(r[iMobil]), rute: clean(r[iRute]),
      dur: clean(r[iDur]), pkt: clean(r[iPkt]),
      drv: clean(r[iDrv]), nopol: clean(r[iNopol]),
      jual: money(r[iJual]), rtr: money(r[iRtr]),
      add: money(r[iAdd]), park: money(r[iPark]), totU: money(r[iTotU]),
      ket: clean(r[iKet]), ops: money(r[iOps]),
      raw: r,
    });
  }
  return out;
}

// ---------- customer / vendor find-or-create (within tx) ----------
async function findOrCreateCustomer(tx, name) {
  const nm = clean(name) || 'Unknown customer';
  const existing = await tx.customer.findFirst({
    where: { phone: null, name: { equals: nm, mode: 'insensitive' } },
  });
  if (existing) return existing;
  return tx.customer.create({ data: { name: nm, phone: null } });
}
async function findOrCreateVendor(tx, name, phone) {
  const nm = clean(name);
  if (!nm) return null;
  const existing = await tx.externalVendor.findFirst({ where: { name: { equals: nm, mode: 'insensitive' } } });
  if (existing) {
    if (phone && !existing.phone) return tx.externalVendor.update({ where: { id: existing.id }, data: { phone } });
    return existing;
  }
  return tx.externalVendor.create({ data: { name: nm, phone: phone || null } });
}
async function findOrCreateVendorCar(tx, vendorId, model, plate) {
  const m = clean(model), p = clean(plate);
  if (!m && !p) return null;
  const existing = await tx.externalCar.findFirst({
    where: { vendor_id: vendorId, ...(p ? { plate_number: { equals: p, mode: 'insensitive' } } : { model: { equals: m || '-', mode: 'insensitive' } }) },
  });
  if (existing) return existing;
  return tx.externalCar.create({ data: { vendor_id: vendorId, model: m || 'Unknown', plate_number: p || null } });
}

// ---------- main ----------
async function main() {
  const wb = XLSX.readFile(FILE);
  const drv = await loadDrivers();
  const cars = await loadCars();

  // 1) read all rows from selected tabs
  let allRows = [];
  for (const tab of MONTHS) {
    const rows = readTab(wb, tab);
    console.log(`TAB ${tab}: ${rows.length} data rows`);
    allRows = allRows.concat(rows);
  }

  // 2) group: invoice -> one order; no-invoice -> standalone
  const groups = new Map();
  const noinvCounter = {};
  for (const row of allRows) {
    let key;
    if (row.invoice) key = `inv:${row.invoice.toLowerCase()}|${normKey(row.name)}`;
    else {
      const mc = MONTH_CODE[row.tab] || 'X';
      noinvCounter[mc] = (noinvCounter[mc] || 0) + 1;
      key = `noinv:${mc}:${row.rowNumber}`;
      row._noinvCode = `NOINV-${mc}-${String(noinvCounter[mc]).padStart(3, '0')}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // invoices shared across >1 customer group -> disambiguate order_code
  const invCustomers = {};
  for (const [key, rows] of groups) {
    const inv = rows[0].invoice.toLowerCase();
    if (inv) (invCustomers[inv] = invCustomers[inv] || new Set()).add(normKey(rows[0].name));
  }

  const stats = { orders: 0, created: 0, updated: 0, lines: 0, cancelled: 0,
    missingInv: 0, refunded: 0, notFinal: 0, external: 0, carFixed: 0, carUnmatched: 0 };
  const unmatchedCars = {};

  for (const [key, rows] of groups) {
    rows.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
    const first = rows[0];
    const anyCancel = rows.some((r) => r.cancelled);
    const allCancel = rows.every((r) => r.cancelled);
    const anyRefund = rows.some((r) => r.refund);
    const allFinal = rows.every((r) => r.isFinal);
    const missingInv = !first.invoice;
    if (missingInv) stats.missingInv++;
    if (allCancel) stats.cancelled++;
    if (anyRefund) stats.refunded++;
    if (!allFinal && !allCancel) stats.notFinal++;

    // build day-lines
    const lines = [];
    let orderRevenue = 0, orderOps = 0, orderMargin = 0, anyExternal = false;
    let groupVendorId = null, groupVendorCarId = null;
    const lineSpecs = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const driverId = resolveDriverId(r.drv, drv);
      const external = !driverId && r.drv !== '';
      if (external) { anyExternal = true; stats.external++; }
      const revenue = r.totU ?? r.jual ?? 0;
      const ops = r.ops ?? 0;
      const rtr = external ? (r.rtr ?? 0) : null;
      const lineMargin = computeLineMargin({ isExternal: external, revenue, ops_cost: ops, rtr_amount: rtr });
      orderRevenue += revenue; orderOps += ops; orderMargin += lineMargin;
      let carId = null, carInfo = { id: null, fixed: false };
      if (!external) {
        carInfo = resolveCarId(r.nopol, r.mobil, cars);
        carId = carInfo.id;
        if (carInfo.fixed) stats.carFixed++;
        if (!carId && (r.nopol || r.mobil)) { stats.carUnmatched++; const k = r.nopol || r.mobil; unmatchedCars[k] = (unmatchedCars[k] || 0) + 1; }
      }
      lineSpecs.push({ r, i, driverId, external, revenue, ops, rtr, lineMargin, carId });
    }

    if (DRY) { stats.orders++; stats.lines += rows.length; continue; }

    await prisma.$transaction(async (tx) => {
      const existing = await tx.sheetImportRow.findFirst({
        where: { sheet_id: SHEET_ID, gid: first.tab, row_number: { in: rows.map((r) => r.rowNumber) }, order_id: { not: null } },
        select: { order_id: true },
      });
      let orderId = existing?.order_id || null;
      const customer = await findOrCreateCustomer(tx, first.name);

      const lineCreates = [];
      for (const ls of lineSpecs) {
        const r = ls.r;
        let lineVendorId = null, lineVendorCarId = null;
        if (ls.external) {
          const vendorName = r.drv.replace(/\s*\([^)]*\)\s*$/, '').trim();
          const vendor = await findOrCreateVendor(tx, vendorName, r.hp);
          if (vendor) {
            lineVendorId = vendor.id; groupVendorId = groupVendorId || vendor.id;
            const vc = await findOrCreateVendorCar(tx, vendor.id, r.mobil, r.nopol);
            lineVendorCarId = vc?.id ?? null; groupVendorCarId = groupVendorCarId || lineVendorCarId;
          }
        }
        const pickup = (r.rute.split(/[-\u2013>]/)[0] || r.rute || '-').trim() || '-';
        const dropoff = (r.rute.split(/[-\u2013>]/).slice(-1)[0] || r.rute || '-').trim() || '-';
        lineCreates.push({
          service_date: r.date, start_at: r.date,
          description: r.mobil || null, service_kind: r.dur || null,
          pickup_location: pickup, dropoff_location: dropoff,
          unit_price: ls.revenue, total_price: ls.revenue,
          notes: r.pkt || null, sort_order: ls.i,
          is_external: ls.external,
          line_status: r.cancelled ? 'CANCELLED' : 'DONE',
          driver_id: ls.driverId, car_id: ls.carId,
          external_vendor_id: lineVendorId, external_car_id: lineVendorCarId,
          driver_name_raw: r.drv || null, plate_raw: r.nopol || null,
          rtr_amount: ls.rtr, ops_cost: ls.ops,
          margin_amount: ls.lineMargin, margin_formula_version: MARGIN_FORMULA_VERSION,
        });
      }
      stats.lines += lineCreates.length;

      const orderStatus = allCancel ? 'CANCELLED' : 'DONE';
      const paymentStatus = first.lunas ? 'PAID' : (first.dp ? 'DP_PAID' : 'UNPAID');
      const orderFields = {
        source: 'IMPORT',
        customer_name: first.name, customer_phone: first.hp || '-', customer_id: customer.id,
        is_external: anyExternal, external_vendor_id: anyExternal ? groupVendorId : null,
        external_car_id: anyExternal ? groupVendorCarId : null,
        pickup_location: lineCreates[0].pickup_location, dropoff_location: lineCreates[lineCreates.length - 1].dropoff_location,
        order_date: first.date || new Date(Date.UTC(2026, MONTH_NUM[first.tab] ?? 0, 1)),
        service_start_at: first.date, service_end_at: rows[rows.length - 1].date,
        final_price: orderRevenue,
        service_type: first.dur || null, notes: first.ket || null, area: null,
        raw_order_text: null,
        order_status: orderStatus, payment_status: paymentStatus,
        is_final: allFinal, invoice_missing: missingInv, is_refunded: anyRefund,
      };

      if (orderId) {
        await tx.order.update({ where: { id: orderId }, data: orderFields });
        await tx.orderServiceItem.deleteMany({ where: { order_id: orderId } });
        for (const line of lineCreates) await tx.orderServiceItem.create({ data: { ...line, order_id: orderId } });
        stats.updated++;
      } else {
        let orderCode;
        if (first.invoice) {
          const shared = (invCustomers[first.invoice.toLowerCase()]?.size || 0) > 1;
          orderCode = shared ? `${first.invoice}-${slug(first.name)}` : first.invoice;
        } else orderCode = first._noinvCode;
        const created = await tx.order.create({
          data: { ...orderFields, order_code: orderCode,
            customers: { create: [{ name: first.name, phone: null, is_primary: true }] },
            service_items: { create: lineCreates } },
        });
        orderId = created.id;
        stats.created++;
      }
      stats.orders++;

      await tx.orderFinalFinance.upsert({
        where: { order_id: orderId },
        update: { total_user_amount: orderRevenue, total_ops_cost: orderOps, margin_amount: orderMargin, margin_formula_version: MARGIN_FORMULA_VERSION, invoice_no_raw: first.invoice || null },
        create: { order_id: orderId, total_user_amount: orderRevenue, total_ops_cost: orderOps, margin_amount: orderMargin, margin_formula_version: MARGIN_FORMULA_VERSION, invoice_no_raw: first.invoice || null },
      });

      for (const r of rows) {
        await tx.sheetImportRow.upsert({
          where: { sheet_id_gid_row_number: { sheet_id: SHEET_ID, gid: r.tab, row_number: r.rowNumber } },
          update: { raw_json: {}, order_id: orderId, status: 'IMPORTED', warnings: [] },
          create: { sheet_id: SHEET_ID, gid: r.tab, row_number: r.rowNumber, row_hash: `${r.tab}:${r.rowNumber}`, raw_json: {}, order_id: orderId, status: 'IMPORTED', warnings: [] },
        });
      }
    }, { timeout: 60000 });
  }

  console.log('\n===== IMPORT' + (DRY ? ' (DRY-RUN)' : '') + ' SUMMARY [' + MONTHS.join(',') + '] =====');
  console.log('Orders            :', stats.orders, `(created ${stats.created}, updated ${stats.updated})`);
  console.log('Day-lines         :', stats.lines);
  console.log('Cancelled orders  :', stats.cancelled);
  console.log('Missing-invoice   :', stats.missingInv);
  console.log('Refunded          :', stats.refunded);
  console.log('Not-yet-final     :', stats.notFinal);
  console.log('External day-lines:', stats.external);
  console.log('Car typo-fixed    :', stats.carFixed, '| still unmatched:', stats.carUnmatched);
  if (Object.keys(unmatchedCars).length) {
    console.log('  unmatched car refs:', Object.entries(unmatchedCars).sort((a,b)=>b[1]-a[1]).slice(0,12).map(x=>x[0]+'='+x[1]).join(', '));
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('IMPORT FAILED:', e); await prisma.$disconnect(); process.exit(1); });

module.exports = { parseDate, norm, clean, money };
