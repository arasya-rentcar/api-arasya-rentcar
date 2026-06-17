/* Dry-run analyzer for the Jadwal_ARASYA workbook. Writes NOTHING. */
const XLSX = require('xlsx');
const path = require('path');

const FILE = process.env.SHEET_FILE ||
  '/root/.openclaw/media/inbound/Jadwal_ARASYA_2026---1488102f-ea66-44ee-9def-f3e1c831b36f.xlsx';
const MONTHS = (process.env.MONTHS || 'JUNI 2026').split('|');

const norm = (s) => (s || '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
const clean = (s) => (s || '').toString().trim();
const money = (s) => {
  const t = clean(s).replace(/[^0-9.-]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Internal drivers (from DB) + nickname map
const DRIVERS = [
  'Hary Priyatna ( Donal )', 'Mochamad Rizki Aulia Rohendi', 'Idwin Faendri',
  'Rori Afridal', 'Ruli Awan', 'Yosuef Novian Haditama', 'Muhammad ilyas Ruhyat',
  'Sutan Arief', 'Aldi Martin', 'Iwan',
];
const CARS = [
  { unit: 'FCB', model: 'Avanza', plate: 'F 1073 FCB' },
  { unit: 'ACB', model: 'Avanza', plate: 'F 1497 ACB' },
  { unit: 'VLZ1', model: 'Veloz', plate: 'F 1037 ACD' },
  { unit: 'VLZ2', model: 'Veloz', plate: 'F 1038 ACD' },
  { unit: 'ABJ', model: 'Innova Reborn', plate: 'F 1728 ABJ' },
  { unit: 'FBT', model: 'Innova Reborn', plate: 'F 1443 FBT' },
  { unit: 'FBY', model: 'Innova Zenix', plate: 'F 1793 FBY' },
  { unit: 'ARA', model: 'Innova Zenix Q', plate: 'F 1000 ARA' },
  { unit: 'FCF', model: 'Avanza', plate: 'F 1470 FCF' },
];

// Build driver nickname index (full, paren-inner, first token)
const driverIdx = {};
for (const full of DRIVERS) {
  const keys = new Set();
  keys.add(norm(full));
  const paren = full.match(/\(([^)]+)\)/);
  if (paren) keys.add(norm(paren[1]));
  const base = norm(full.replace(/\([^)]*\)/g, ''));
  keys.add(base);
  base.split(' ').forEach((t) => { if (t.length >= 3) keys.add(t); });
  for (const k of keys) {
    if (driverIdx[k] === undefined) driverIdx[k] = full;
    else if (driverIdx[k] !== full) driverIdx[k] = '__AMBIG__';
  }
}
const carByUnit = {}; const carByPlate = {};
for (const c of CARS) { carByUnit[norm(c.unit)] = c; carByPlate[norm(c.plate)] = c; }

// known spelling variants of internal drivers seen in the sheet
const DRIVER_ALIAS = {
  'FAENDRY': 'Idwin Faendri', 'FAENDRI': 'Idwin Faendri', 'IDWIN': 'Idwin Faendri',
  'MARTIN': 'Aldi Martin', 'ALDI': 'Aldi Martin',
  'DONAL': 'Hary Priyatna ( Donal )', 'HARY': 'Hary Priyatna ( Donal )',
  'RIZKI': 'Mochamad Rizki Aulia Rohendi', 'ILYAS': 'Muhammad ilyas Ruhyat',
  'YOSUEF': 'Yosuef Novian Haditama', 'YOSEP': 'Yosuef Novian Haditama',
  'SUTAN': 'Sutan Arief', 'RORI': 'Rori Afridal', 'RULI': 'Ruli Awan', 'IWAN': 'Iwan',
};
function resolveDriver(name) {
  let n = norm(name);
  if (!n) return null;
  // vendor-marked names like "Faiz (V)" are never internal
  const hasVendorMark = /\(\s*V\s*\)/.test(n) || /VENDOR/.test(n) || /^TEMEN /.test(n);
  // strip parenthetical qualifier for base matching
  const base = n.replace(/\([^)]*\)/g, '').trim();
  if (driverIdx[n] && driverIdx[n] !== '__AMBIG__') return driverIdx[n];
  if (!hasVendorMark && DRIVER_ALIAS[base]) return DRIVER_ALIAS[base];
  if (!hasVendorMark && driverIdx[base] && driverIdx[base] !== '__AMBIG__') return driverIdx[base];
  const first = base.split(' ')[0];
  if (!hasVendorMark && DRIVER_ALIAS[first]) return DRIVER_ALIAS[first];
  if (!hasVendorMark && driverIdx[first] && driverIdx[first] !== '__AMBIG__') return driverIdx[first];
  return null;
}
function resolveCar(nopol, mobil) {
  const np = norm(nopol);
  if (np && carByPlate[np]) return carByPlate[np];
  if (np && carByUnit[np]) return carByUnit[np];
  const mb = norm(mobil);
  if (mb && carByUnit[mb]) return carByUnit[mb];
  return null;
}

function invoiceOf(v) {
  const t = clean(v);
  if (!t) return '';
  if (/^(no\s*invoice|-|n\/?a|none|tba|tbc)$/i.test(t)) return '';
  return t;
}

const wb = XLSX.readFile(FILE);
const groups = new Map(); // key -> {invoice, customer, rows:[]}
let stats = { rows: 0, cancelled: 0, refund: 0, noInvoice: 0, notFinal: 0,
  drvMatched: 0, drvUnmatched: 0, external: 0, carMatched: 0, carUnmatched: 0 };
const unmatchedDrivers = {};
const unmatchedCars = {};

for (const m of MONTHS) {
  const ws = wb.Sheets[m];
  if (!ws) { console.log('MISSING TAB:', m); continue; }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const hdr = rows[0].map(norm);
  const ix = (n) => hdr.indexOf(n);
  // FINAL col = index 0 here (header cell mislabeled), CANCEL=1, REFUND=2
  const iFinal = 0, iCancel = ix('CANCEL') >= 0 ? ix('CANCEL') : 1,
    iRefund = ix('REFUND/ CASHBACK') >= 0 ? ix('REFUND/ CASHBACK') : 2;
  const iInv = ix('NO INVOICE'), iDate = ix('TANGGAL') >= 0 ? ix('TANGGAL') : ix('TGL'),
    iName = ix('NAMA USER'), iHp = ix('NO HP'), iMobil = ix('MOBIL'), iRute = ix('RUTE'),
    iDur = ix('DURASI'), iPkt = ix('PAKET'),
    iDrv = ix('DRIVER/VENDOR') >= 0 ? ix('DRIVER/VENDOR') : ix('DRIVER'),
    iNopol = ix('NOPOL'), iJual = ix('HARGA JUAL'), iRtr = ix('RTR'),
    iAdd = ix('ADDITIONAL'), iPark = ix('PARKIR'), iTotU = ix('TOTAL USER'),
    iKet = ix('KETERANGAN'), iOps = ix('TOTAL OPS COST'), iDp = ix('DP'), iLunas = ix('LUNAS');

  let monthRows = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[iName]);
    if (!name) continue;
    monthRows++; stats.rows++;

    const cancelled = norm(r[iCancel]) === 'TRUE';
    const refund = clean(r[iRefund]) !== '';
    const isFinal = norm(r[iFinal]) === 'TRUE';
    const invoice = invoiceOf(r[iInv]);
    if (cancelled) stats.cancelled++;
    if (refund) stats.refund++;
    if (!invoice) stats.noInvoice++;
    if (!isFinal && !cancelled) stats.notFinal++;

    const drvName = clean(r[iDrv]);
    const matchedDrv = resolveDriver(drvName);
    const rtr = money(r[iRtr]);
    // external = any driver that is NOT one of our internal drivers
    const external = !matchedDrv && drvName !== '';
    if (matchedDrv) stats.drvMatched++;
    else { stats.drvUnmatched++; unmatchedDrivers[drvName] = (unmatchedDrivers[drvName] || 0) + 1; }
    if (external) stats.external++;

    const car = resolveCar(r[iNopol], r[iMobil]);
    if (!external) {
      if (car) stats.carMatched++;
      else { stats.carUnmatched++; const key = clean(r[iNopol]) || clean(r[iMobil]) || '(blank)'; unmatchedCars[key] = (unmatchedCars[key] || 0) + 1; }
    }

    // grouping key
    let key;
    if (invoice) key = `INV:${invoice}`;
    else key = `NOINV:${m}:${i}`; // each no-invoice row stands alone
    if (!groups.has(key)) groups.set(key, { invoice, customer: name, rows: [], anyCancel: false, anyExternal: false, allFinal: true });
    const g = groups.get(key);
    g.rows.push({ name, date: clean(r[iDate]), drvName, matchedDrv, external, car, rtr,
      jual: money(r[iJual]), totU: money(r[iTotU]), ops: money(r[iOps]),
      add: money(r[iAdd]), park: money(r[iPark]), dur: clean(r[iDur]), pkt: clean(r[iPkt]),
      ket: clean(r[iKet]), cancelled, refund, isFinal, rute: clean(r[iRute]) });
    if (cancelled) g.anyCancel = true;
    if (external) g.anyExternal = true;
    if (!isFinal) g.allFinal = false;
  }
  console.log(`TAB ${m}: ${monthRows} data rows`);
}

// Order-level rollup
let orders = 0, dayLines = 0, multiDay = 0, cancelledOrders = 0, missingInvOrders = 0;
const sampleMulti = [];
for (const [key, g] of groups) {
  orders++; dayLines += g.rows.length;
  if (g.rows.length > 1) multiDay++;
  if (g.anyCancel && g.rows.every(r => r.cancelled)) cancelledOrders++;
  if (!g.invoice) missingInvOrders++;
  if (g.rows.length > 3 && sampleMulti.length < 4) sampleMulti.push([key, g]);
}

console.log('\n===== DRY-RUN SUMMARY (' + MONTHS.join(',') + ') =====');
console.log('Data rows           :', stats.rows);
console.log('-> Orders            :', orders);
console.log('-> Day-lines         :', dayLines);
console.log('-> Multi-day orders  :', multiDay);
console.log('Cancelled rows      :', stats.cancelled, '| fully-cancelled orders:', cancelledOrders);
console.log('Refund rows         :', stats.refund);
console.log('No-invoice rows     :', stats.noInvoice, '| -> standalone orders:', missingInvOrders);
console.log('Not-yet-FINAL rows  :', stats.notFinal, '(LUNAS but may get additional charges)');
console.log('Driver matched      :', stats.drvMatched, '| unmatched:', stats.drvUnmatched, '| treated external:', stats.external);
console.log('Car matched (intl)  :', stats.carMatched, '| unmatched:', stats.carUnmatched);

console.log('\n--- Top UNMATCHED driver names (would be EXTERNAL/vendor) ---');
Object.entries(unmatchedDrivers).sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v])=>console.log(String(v).padStart(3), k));

console.log('\n--- UNMATCHED car refs (internal rows missing a car) ---');
Object.entries(unmatchedCars).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(String(v).padStart(3), k));

console.log('\n--- Sample multi-day orders ---');
for (const [key, g] of sampleMulti) {
  console.log(`\n${key}  customer="${g.customer}"  days=${g.rows.length}  external=${g.anyExternal}  allFinal=${g.allFinal}`);
  g.rows.slice(0, 6).forEach(r => console.log(`   ${r.date.padEnd(14)} drv=${(r.matchedDrv||r.drvName||'-').padEnd(20)} ${r.external?'[EXT]':'[int]'} car=${r.car?r.car.unit:'-'} jual=${r.jual} rtr=${r.rtr} totU=${r.totU}`));
}
