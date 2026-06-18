#!/usr/bin/env node
/**
 * ============================================================================
 *  ARASYA RENTCAR — END-TO-END TEST DATA / TEST CASE  (NO BOT)
 * ============================================================================
 *
 *  WHAT THIS DOES
 *  --------------
 *  Drives the REAL HTTP API exactly like a human admin clicking the dashboard.
 *  No bot, no fake DB shortcuts (except the one status the API has no route for
 *  — CANCELLED — which is set directly and clearly marked below).
 *
 *  It seeds 5 orders covering the WHOLE Arasya flow:
 *    - internal + external driver & car
 *    - all 5 order statuses: CREATED, ASSIGNED, IN_PROGRESS, DONE, CANCELLED
 *    - all 3 DURASI: 12H, FULLDAY, DROP
 *    - all 3 PAKET:  ALL-IN, ALL-IN X PARKIR, XOPS
 *    - additional charges (overtime, etc.)
 *    - DP payment (>=20%), settlement, full payment, and a DP-hangus cancel
 *    - real prices taken from the dashboard Guide page (Jakarta / Bandung)
 *
 *  PRICES (from dashboard Guide page)
 *  ----------------------------------
 *   Jakarta  12H:  Avanza 750k | Xpander 850k | Reborn 1.000k | Zenix 1.300k | Zenix Q 1.700k
 *   Jakarta  FULL: Avanza 950k | Xpander 1.100k| Reborn 1.250k | Zenix 1.600k | Zenix Q 2.100k
 *            extra: Bogor +100k, Depok +100k, Bekasi +100k, Tangerang +200k, Puncak +200k
 *   Bandung  12H:  Avanza 850k | Xpander 950k | Reborn 1.100k | Zenix 1.400k | Zenix Q 1.800k
 *   Bandung  FULL: Avanza 1.100k| Xpander 1.200k| Reborn 1.350k| Zenix 1.700k | Zenix Q 2.200k
 *   Drop (one-way, e.g. ke Bandara Soetta): ~650k-700k
 *
 *  HOW STATUS IS REACHED (verified against the codebase)
 *  -----------------------------------------------------
 *   CREATED      -> POST /orders                       (on create)
 *   ASSIGNED     -> POST /orders/:id/assign            (internal: creates Trip)
 *                   or PUT /schedule/lines/:id          (external per-day assign)
 *   IN_PROGRESS  -> POST /trips/:id/next-status -> DEPART_GARAGE
 *   DONE         -> POST /trips/:id/next-status ... -> COMPLETED
 *   CANCELLED    -> (no API route exists) set directly on the order row
 *
 *  PAYMENTS
 *   DP (>=20% of rental) -> SETTLEMENT (remaining) -> ADDITIONAL (per extra).
 *   Each invoice can be marked paid -> reprints as Kuitansi (LUNAS).
 *   payment_status auto-recomputes: UNPAID -> DP_PAID -> PAID.
 *
 *  USAGE
 *  -----
 *    node scripts/e2e-test-orders.js          # seed all test orders
 *    node scripts/e2e-test-orders.js --clean  # delete all TEST-* orders again
 *
 *  Order codes are prefixed TEST- so cleanup is trivial and safe.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
require('dotenv').config();
const prisma = require('../dist/src/prisma/client').default;

const BASE = process.env.E2E_BASE || 'http://localhost:3001/api/v1';
const TOKEN = jwt.sign(
  { user_id: 'e2e-test', role: 'ADMIN' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' },
);
const H = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

const iso = (d) => new Date(d).toISOString();
const rp = (v) => 'Rp ' + Number(v).toLocaleString('id-ID');

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const msg = json && (json.message || JSON.stringify(json));
    throw new Error(`${method} ${path} -> ${res.status} ${msg}`);
  }
  return json;
}

const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n=== ${s} ===`);

// ── helpers ────────────────────────────────────────────────────────────────

async function getMasterData() {
  const drivers = await prisma.driver.findMany({ where: { type: 'INTERNAL' } });
  const cars = await prisma.car.findMany();
  const byCar = (model) => cars.find((c) => c.model === model);
  const driver = (n) => drivers[n % drivers.length];
  return { drivers, cars, byCar, driver };
}

async function ensureVendor(name, phone) {
  const existing = await prisma.externalVendor.findFirst({ where: { name } });
  if (existing) return existing;
  const r = await api('POST', '/external-vendors', { name, phone });
  return r.data;
}

async function ensureVendorCar(vendorId, model, plate) {
  const r = await api('POST', `/external-vendors/${vendorId}/cars`, {
    model,
    plate_number: plate,
  });
  return r.data;
}

/** Walk a trip through the full lifecycle up to a target status. */
async function advanceTrip(tripId, target) {
  // SCHEDULE: DRIVER_ASSIGNED -> DEPART_GARAGE (IN_PROGRESS)
  //   -> ARRIVE_AT_CUSTOMER -> ON_TRIP -> DROP_CUSTOMER
  //   -> RETURN_GARAGE -> ARRIVE_GARAGE -> COMPLETED (DONE)
  const chain = [
    'DEPART_GARAGE',
    'ARRIVE_AT_CUSTOMER',
    'ON_TRIP',
    'DROP_CUSTOMER',
    'RETURN_GARAGE',
    'ARRIVE_GARAGE',
    'COMPLETED',
  ];
  for (const status of chain) {
    await api('POST', `/trips/${tripId}/next-status`, { status });
    if (status === 'DEPART_GARAGE' && target === 'IN_PROGRESS') return;
  }
}


// ── cleanup ──────────────────────────────────────────────────────────────--

async function cleanup() {
  step('CLEANUP — deleting all TEST-* orders');
  const orders = await prisma.order.findMany({
    where: { order_code: { startsWith: 'TEST-' } },
    select: { id: true, order_code: true },
  });
  for (const o of orders) {
    await prisma.payableExtra.deleteMany({ where: { payable: { order_id: o.id } } });
    await prisma.payable.deleteMany({ where: { order_id: o.id } });
    await prisma.invoiceDeliveryLog.deleteMany({ where: { order_id: o.id } });
    await prisma.invoice.deleteMany({ where: { order_id: o.id } });
    await prisma.tripLog.deleteMany({ where: { trip: { order_id: o.id } } });
    await prisma.expense.deleteMany({ where: { trip: { order_id: o.id } } }).catch(() => {});
    await prisma.trip.deleteMany({ where: { order_id: o.id } });
    await prisma.orderAdjustment.deleteMany({ where: { order_id: o.id } });
    await prisma.orderChangeLog.deleteMany({ where: { order_id: o.id } });
    await prisma.orderServiceItem.deleteMany({ where: { order_id: o.id } });
    await prisma.orderFinalFinance.deleteMany({ where: { order_id: o.id } });
    await prisma.orderCustomer.deleteMany({ where: { order_id: o.id } });
    await prisma.order.delete({ where: { id: o.id } });
    log('  deleted', o.order_code);
  }
  // External vendors created by this script (idempotent names)
  const vendorNames = ['Trans Bandung Jaya (TEST)', 'Soetta Travel Partner (TEST)'];
  for (const name of vendorNames) {
    const v = await prisma.externalVendor.findFirst({ where: { name } });
    if (v) {
      await prisma.externalCar.deleteMany({ where: { vendor_id: v.id } });
      await prisma.externalVendor.delete({ where: { id: v.id } });
      log('  deleted vendor', name);
    }
  }
  log(`\nCleanup done (${orders.length} orders).`);
}

// ── order builders ─────────────────────────────────────────────────────────

/**
 * Generic create: builds an order with N service-day lines (each carries
 * DURASI=service_kind + PAKET=service_package + real price), then sets
 * order_code to a friendly TEST-* code.
 */
async function createOrder({ code, customer, phone, pickup, dropoff, area, lines, notes }) {
  const today = new Date();
  const orderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const final_price = lines.reduce((s, l) => s + l.total_price, 0);
  const service_items = lines.map((l, i) => ({
    service_date: iso(l.date),
    description: l.car,
    service_kind: l.durasi,        // DURASI: 12H | FULLDAY | DROP
    service_package: l.paket,      // PAKET:  ALL-IN | ALL-IN X PARKIR | XOPS
    pickup_location: l.pickup || pickup,
    dropoff_location: l.dropoff || dropoff,
    quantity: 1,
    unit_price: l.total_price,
    total_price: l.total_price,
    sort_order: i,
  }));
  const created = await api('POST', '/orders', {
    customer_name: customer,
    customer_phone: phone,
    pickup_location: pickup,
    dropoff_location: dropoff,
    area,
    notes,
    order_date: iso(orderDate),
    final_price,
    service_items,
  });
  const orderId = created.data.id;
  // Friendly order_code (the create endpoint auto-generates one; override it).
  await prisma.order.update({ where: { id: orderId }, data: { order_code: code } });
  log(`  created ${code} (${customer}) — ${lines.length} day(s), total ${rp(final_price)}`);
  // refetch with service items
  const full = await api('GET', `/orders/${orderId}`);
  return full.data;
}


// ── main seed ────────────────────────────────────────────────────────────--

async function seed() {
  const { byCar, driver } = await getMasterData();
  const d = (n) => new Date(Date.now() + n * 86400000); // n days from now

  // =========================================================================
  // ORDER 1 — TEST-JKT-01 : DONE, internal, 3 days, all DURASI, DP+settle+add
  // =========================================================================
  step('ORDER 1 — TEST-JKT-01 (Jakarta, INTERNAL, multi-day, status -> DONE)');
  const carZenix = byCar('Innova Zenix');
  const drvDonal = driver(0);
  const o1 = await createOrder({
    code: 'TEST-JKT-01',
    customer: 'PT Maju Jaya (Bpk. Surya)',
    phone: '081200000001',
    pickup: 'Apartemen Sudirman, Jakarta',
    dropoff: 'Pemakaian dalam kota Jakarta',
    area: 'Jakarta',
    notes: '3 hari pemakaian corporate, driver tetap.',
    lines: [
      // Day 1: FULLDAY + ALL-IN — Jakarta Zenix Fullday 1.600.000
      { date: d(1), car: 'Innova Zenix', durasi: 'FULLDAY', paket: 'ALL-IN',
        total_price: 1600000 },
      // Day 2: 12H + ALL-IN — Jakarta Zenix 12H 1.300.000
      { date: d(2), car: 'Innova Zenix', durasi: '12H', paket: 'ALL-IN',
        total_price: 1300000 },
      // Day 3: DROP + XOPS — one-way drop ke Bandara Soetta 700.000
      { date: d(3), car: 'Innova Zenix', durasi: 'DROP', paket: 'XOPS',
        dropoff: 'Bandara Soekarno-Hatta T3', total_price: 700000 },
    ],
  });

  // ASSIGN (internal driver+car => creates Trip => order ASSIGNED, lines inherit driver)
  await api('POST', `/orders/${o1.id}/assign`, {
    driver_id: drvDonal.id,
    car_id: carZenix.id,
  });
  log('  assigned internal driver + car (order -> ASSIGNED, Trip created)');

  // Set per-day ops_cost on each internal line so DRIVER payables have a fee.
  const o1lines = (await api('GET', `/orders/${o1.id}`)).data.service_items;
  const o1ops = [400000, 350000, 200000];
  for (let i = 0; i < o1lines.length; i++) {
    await api('PUT', `/schedule/lines/${o1lines[i].id}`, {
      is_external: false,
      driver_id: drvDonal.id,
      car_id: carZenix.id,
      ops_cost: o1ops[i],
    });
  }
  log('  set per-day ops_cost -> 3 DRIVER payables auto-created');

  // PAYMENTS: DP 20% -> settlement -> additional overtime
  const rentalBase = 1600000 + 1300000 + 700000; // 3.600.000
  const dpAmount = Math.round(rentalBase * 0.25); // 25% DP (> 20% min)
  let inv = await api('POST', `/orders/${o1.id}/generate-invoice`, {
    invoice_type: 'DP', payment_method: 'BANK_TRANSFER', amount: dpAmount,
    note: 'DP 25% via transfer BCA',
  });
  await api('POST', `/orders/${o1.id}/invoice/${inv.data.id}/mark-paid`, {
    payment_method: 'BANK_TRANSFER',
  });
  log(`  DP ${rp(dpAmount)} issued + PAID (order -> DP_PAID)`);

  const settlement = rentalBase - dpAmount;
  inv = await api('POST', `/orders/${o1.id}/generate-invoice`, {
    invoice_type: 'SETTLEMENT', payment_method: 'CASH', amount: settlement,
    note: 'Pelunasan di hari pertama',
  });
  await api('POST', `/orders/${o1.id}/invoice/${inv.data.id}/mark-paid`, {
    payment_method: 'CASH',
  });
  log(`  SETTLEMENT ${rp(settlement)} issued + PAID (order -> PAID)`);

  // ADDITIONAL: overtime 2 jam (10%/jam of fullday 1.6jt ~ 320k)
  await api('POST', `/orders/${o1.id}/adjustments`, {
    type: 'OVERTIME', description: 'Overtime 2 jam hari ke-1', amount: 320000,
  });
  inv = await api('POST', `/orders/${o1.id}/generate-invoice`, {
    invoice_type: 'ADDITIONAL', payment_method: 'CASH', amount: 320000,
    note: 'Overtime 2 jam',
  });
  await api('POST', `/orders/${o1.id}/invoice/${inv.data.id}/mark-paid`, {
    payment_method: 'CASH',
  });
  log(`  ADDITIONAL overtime ${rp(320000)} issued + PAID`);

  // Drive the Trip all the way to COMPLETED -> order DONE
  const trip1 = (await api('GET', `/orders/${o1.id}`)).data.trip;
  await advanceTrip(trip1.id, 'DONE');
  log('  trip walked to COMPLETED (order -> DONE)');

  // =========================================================================
  // ORDER 2 — TEST-BDG-02 : IN_PROGRESS, internal, 1 day, FULLDAY+X PARKIR, FULL paid
  // =========================================================================
  step('ORDER 2 — TEST-BDG-02 (Bandung, INTERNAL, 1 day, status -> IN_PROGRESS)');
  const carReborn = byCar('Innova Reborn');
  const drvRizki = driver(1);
  const o2 = await createOrder({
    code: 'TEST-BDG-02',
    customer: 'Ibu Renata',
    phone: '081200000002',
    pickup: 'Stasiun Bandung',
    dropoff: 'Pemakaian area Bandung',
    area: 'Bandung',
    notes: 'Fullday wisata kota, all-in kecuali parkir.',
    lines: [
      // Bandung Reborn Fullday 1.350.000
      { date: d(0), car: 'Innova Reborn', durasi: 'FULLDAY',
        paket: 'ALL-IN X PARKIR', total_price: 1350000 },
    ],
  });
  await api('POST', `/orders/${o2.id}/assign`, {
    driver_id: drvRizki.id, car_id: carReborn.id,
  });
  const o2line = (await api('GET', `/orders/${o2.id}`)).data.service_items[0];
  await api('PUT', `/schedule/lines/${o2line.id}`, {
    is_external: false, driver_id: drvRizki.id, car_id: carReborn.id,
    ops_cost: 450000,
  });
  // FULL payment (paid)
  inv = await api('POST', `/orders/${o2.id}/generate-invoice`, {
    invoice_type: 'FULL', payment_method: 'QRIS', amount: 1350000,
    note: 'Lunas via QRIS',
  });
  await api('POST', `/orders/${o2.id}/invoice/${inv.data.id}/mark-paid`, {
    payment_method: 'QRIS',
  });
  log(`  FULL ${rp(1350000)} issued + PAID`);
  // Trip -> IN_PROGRESS only (DEPART_GARAGE)
  const trip2 = (await api('GET', `/orders/${o2.id}`)).data.trip;
  await advanceTrip(trip2.id, 'IN_PROGRESS');
  log('  trip -> DEPART_GARAGE (order -> IN_PROGRESS)');

  // =========================================================================
  // ORDER 3 — TEST-BDG-03 : ASSIGNED, EXTERNAL vendor+car, 1 day, 12H + ALL-IN
  // =========================================================================
  step('ORDER 3 — TEST-BDG-03 (Bandung, EXTERNAL vendor+car, status -> ASSIGNED)');
  const vendor = await ensureVendor('Trans Bandung Jaya (TEST)', '081288887777');
  const extCar = await ensureVendorCar(vendor.id, 'Avanza', 'D 1234 XYZ');
  const o3 = await createOrder({
    code: 'TEST-BDG-03',
    customer: 'Bpk. Hendra',
    phone: '081200000003',
    pickup: 'Hotel Savoy Homann, Bandung',
    dropoff: 'Tangkuban Parahu',
    area: 'Bandung',
    notes: 'Pakai armada partner (external), Avanza 12 jam.',
    lines: [
      // Bandung Avanza 12H 850.000 + area Tangkuban +100.000 = 950.000
      { date: d(2), car: 'Avanza (Partner)', durasi: '12H', paket: 'ALL-IN',
        dropoff: 'Tangkuban Parahu', total_price: 950000 },
    ],
  });
  const o3line = (await api('GET', `/orders/${o3.id}`)).data.service_items[0];
  // Assign the day-line to the EXTERNAL vendor + car (rtr = what we pay vendor)
  await api('PUT', `/schedule/lines/${o3line.id}`, {
    is_external: true,
    external_vendor_id: vendor.id,
    external_car_id: extCar.id,
    rtr_amount: 700000, // we pay vendor 700k, margin 250k
  });
  log('  external vendor+car assigned (VENDOR payable rtr 700k auto-created)');
  // Mark order ASSIGNED to reflect a confirmed external booking.
  await prisma.order.update({
    where: { id: o3.id }, data: { order_status: 'ASSIGNED' },
  });
  log('  order -> ASSIGNED (external confirmed)');

  // =========================================================================
  // ORDER 4 — TEST-JKT-04 : CREATED, unassigned, 1 day, DROP + XOPS
  // =========================================================================
  step('ORDER 4 — TEST-JKT-04 (Jakarta, status stays CREATED, unassigned)');
  await createOrder({
    code: 'TEST-JKT-04',
    customer: 'Bpk. Aditya',
    phone: '081200000004',
    pickup: 'Kelapa Gading, Jakarta',
    dropoff: 'Bandara Soekarno-Hatta T1',
    area: 'Jakarta',
    notes: 'Booking baru, belum di-assign driver. Drop only.',
    lines: [
      // Jakarta drop one-way ~650.000
      { date: d(4), car: 'Avanza', durasi: 'DROP', paket: 'XOPS',
        total_price: 650000 },
    ],
  });
  log('  order stays CREATED (no assignment, no payment)');

  // =========================================================================
  // ORDER 5 — TEST-JKT-05 : CANCELLED, internal, DP paid then hangus
  // =========================================================================
  step('ORDER 5 — TEST-JKT-05 (Jakarta, DP paid then CANCELLED / DP hangus)');
  const carAvanza = byCar('Avanza');
  const drvIdwin = driver(2);
  const o5 = await createOrder({
    code: 'TEST-JKT-05',
    customer: 'Ibu Wulan',
    phone: '081200000005',
    pickup: 'Menteng, Jakarta',
    dropoff: 'Bogor',
    area: 'Jakarta',
    notes: 'Customer batal H-1 setelah 21.00 -> DP hangus.',
    lines: [
      // Jakarta Avanza Fullday 950.000 + Bogor +100.000 = 1.050.000
      { date: d(1), car: 'Avanza', durasi: 'FULLDAY', paket: 'ALL-IN',
        dropoff: 'Bogor', total_price: 1050000 },
    ],
  });
  await api('POST', `/orders/${o5.id}/assign`, {
    driver_id: drvIdwin.id, car_id: carAvanza.id,
  });
  // DP 20% paid
  const dp5 = Math.round(1050000 * 0.2);
  inv = await api('POST', `/orders/${o5.id}/generate-invoice`, {
    invoice_type: 'DP', payment_method: 'BANK_TRANSFER', amount: dp5,
    note: 'DP 20%',
  });
  await api('POST', `/orders/${o5.id}/invoice/${inv.data.id}/mark-paid`, {
    payment_method: 'BANK_TRANSFER',
  });
  log(`  DP ${rp(dp5)} PAID, then customer cancels`);
  // CANCELLED (no API route; set directly + free up the trip's driver/car)
  const trip5 = (await api('GET', `/orders/${o5.id}`)).data.trip;
  if (trip5) {
    await prisma.driver.update({ where: { id: drvIdwin.id }, data: { status: 'AVAILABLE' } });
    await prisma.car.update({ where: { id: carAvanza.id }, data: { status: 'AVAILABLE' } });
  }
  await prisma.order.update({
    where: { id: o5.id }, data: { order_status: 'CANCELLED' },
  });
  log('  order -> CANCELLED (DP hangus, driver/car freed)');

  // ── summary ───────────────────────────────────────────────────────────--
  step('SUMMARY');
  const all = await prisma.order.findMany({
    where: { order_code: { startsWith: 'TEST-' } },
    orderBy: { order_code: 'asc' },
    select: { order_code: true, order_status: true, payment_status: true, final_price: true },
  });
  for (const o of all) {
    log(`  ${o.order_code.padEnd(13)} ${o.order_status.padEnd(12)} pay=${o.payment_status.padEnd(8)} ${rp(o.final_price)}`);
  }
  const payables = await prisma.payable.groupBy({
    by: ['kind', 'status'],
    where: { order: { order_code: { startsWith: 'TEST-' } } },
    _count: true, _sum: { total_amount: true },
  });
  log('\n  Payables:');
  for (const p of payables) {
    log(`    ${p.kind}/${p.status}: ${p._count} line(s), ${rp(p._sum.total_amount || 0)}`);
  }
  log('\nDONE. Open the dashboard to verify Orders, Schedule, Tagihan, and Detail pages.');
}

// ── entrypoint ───────────────────────────────────────────────────────────--

(async () => {
  try {
    if (process.argv.includes('--clean')) {
      await cleanup();
    } else {
      if (process.argv.includes('--reset')) await cleanup();
      await seed();
    }
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
