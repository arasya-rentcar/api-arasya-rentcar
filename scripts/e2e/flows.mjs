// End-to-end checks of the API: what the dashboard and the driver app do,
// against the real API and a throwaway database. Run through run-local.sh.
// Case ids in the output match dashboard-arasya-rentcar/docs/TEST-PLAN.md.
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { call, check, section, summary, ensureAdmin, prisma, jpeg, wibIso, uuid, sleep, pushes, BASE, MOCK } from './lib.mjs';

const admin = await ensureAdmin();
const tag = Date.now().toString(36).slice(-5);
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');

// ── Helpers that mirror dashboard / app actions ────────────────────────────
async function makeDriver(n, extra = {}) {
  const phone = `0813${rnd()}`;
  const u = await call('POST', '/users', { token: admin, body: { email: `drv${n}-${tag}@e2e.local`, password: 'secret123', role: 'DRIVER' } });
  const d = await call('POST', '/drivers', { token: admin, body: { user_id: u.data.id, name: `Driver ${n} ${tag}`, phone, ...extra } });
  await call('PUT', `/drivers/${d.data.id}/app-password`, { token: admin, body: { password: 'test1234' } });
  const login = await call('POST', '/auth/login', { body: { identifier: phone, password: 'test1234' } });
  await call('POST', '/devices', { token: login.data.token, body: { token: `ExponentPushToken[drv${n}-${tag}]`, platform: 'android' } });
  return { id: d.data.id, token: login.data.token, phone, push: `drv${n}-${tag}` };
}
const makeCar = async (model) =>
  (await call('POST', '/cars', { token: admin, body: { plate_number: `B ${rnd().slice(0, 4)} ${tag}${model.slice(0, 2).toUpperCase()}`, model } })).data;

async function makeOrder(name, { days = 1, price = 1_000_000, startDay = 1, pkg = 'ALL-IN', extra = {} } = {}) {
  const items = [];
  for (let i = 0; i < days; i++)
    items.push({
      service_date: wibIso(startDay + i, '00:00'), start_at: wibIso(startDay + i, '08:00'), end_at: wibIso(startDay + i, '20:00'),
      pickup_location: 'Bogor Botani Square', dropoff_location: 'Bandara Soetta', service_kind: '12H', service_package: pkg, unit_price: price,
    });
  const r = await call('POST', '/orders', {
    token: admin,
    body: {
      customer_name: `TEST ${name} ${tag}`, customer_phone: `0857${rnd()}`,
      pickup_location: 'Bogor Botani Square', dropoff_location: 'Bandara Soetta',
      order_date: new Date().toISOString(), final_price: price * days, service_items: items, ...extra,
    },
  });
  if (r.status >= 300) throw new Error(`order ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return order(r.data.id);
}
const order = async (id) => (await call('GET', `/orders/${id}`, { token: admin })).data;
const invoice = (id, type, amount) =>
  call('POST', `/orders/${id}/generate-invoice`, { token: admin, body: { invoice_type: type, payment_method: 'BANK_TRANSFER', amount } });
function markPaid(orderId, invId, extra = {}) {
  const f = new FormData();
  f.append('proof', jpeg(), 'proof.jpg');
  for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
  return call('POST', `/orders/${orderId}/invoice/${invId}/mark-paid`, { token: admin, form: f });
}
async function payDp(o, amount = 300_000) {
  const inv = await invoice(o.id, 'DP', amount);
  await markPaid(o.id, inv.data.id);
  return inv.data;
}
async function payFull(o) {
  const inv = await invoice(o.id, 'FULL', Number(o.final_price));
  await markPaid(o.id, inv.data.id);
  return inv.data;
}
const putLine = (id, body) => call('PUT', `/schedule/lines/${id}`, { token: admin, body });
const act = (drv, lineId, a, body = {}) =>
  call('POST', `/driver/trips/${lineId}/${a}`, { token: drv.token, body: { client_ref: uuid(), occurred_at: new Date().toISOString(), ...body } });
function report(drv, lineId, fields, withPhoto = true) {
  const f = new FormData();
  f.append('client_ref', fields.client_ref ?? uuid());
  for (const [k, v] of Object.entries(fields)) if (k !== 'client_ref') f.append(k, String(v));
  if (withPhoto) f.append('photo', jpeg(), 'p.jpg');
  return call('POST', `/driver/trips/${lineId}/reports`, { token: drv.token, form: f });
}
const pushesTo = async (drv) => (await pushes()).filter((x) => x.to.includes(drv.push));
/**
 * The text strings of an uploaded PDF in drawing order, joined by one space,
 * so a phrase the PDF wrapped over two lines still reads as one (pdf-lib
 * writes standard-font text as hex strings inside deflated content streams).
 */
async function pdfStrings(url) {
  if (!url) return '';
  const key = decodeURIComponent(new URL(url).pathname.replace(/^.*\/object\/public\//, ''));
  const buf = Buffer.from(await (await fetch(`${MOCK}/__object?key=${encodeURIComponent(key)}`)).arrayBuffer());
  const raw = buf.toString('latin1');
  const streams = [raw];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const end = raw.indexOf('endstream', m.index);
    if (end < 0) break;
    try { streams.push(inflateSync(buf.subarray(m.index + m[0].length, end)).toString('latin1')); } catch {}
  }
  const out = [];
  for (const st of streams) for (const h of st.matchAll(/<([0-9A-Fa-f\s]+)>/g)) out.push(Buffer.from(h[1].replace(/\s/g, ''), 'hex').toString('latin1'));
  return out.join(' ').replace(/\s+/g, ' ');
}

/** The body EditOrderForm sends: every day with its id, plus `changes` per day. */
function editBody(o, { days, reason, notes } = {}) {
  const rows = days ?? o.service_items.map((l) => ({ id: l.id }));
  return {
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    customers: [{ name: o.customer_name, phone: o.customer_phone, is_primary: true }],
    pickup_location: o.service_items[0].pickup_location,
    dropoff_location: o.service_items[0].dropoff_location,
    order_date: o.order_date,
    final_price: Number(o.final_price),
    ...(reason ? { change_reason: reason } : {}),
    service_items: rows.map((row, i) => {
      const l = o.service_items.find((x) => x.id === row.id) ?? o.service_items[0];
      return {
        ...(row.id ? { id: row.id } : {}),
        service_date: row.service_date ?? l.service_date,
        start_at: row.start_at ?? l.start_at,
        end_at: row.end_at ?? l.end_at,
        service_kind: l.service_kind, service_package: l.service_package,
        pickup_location: row.pickup_location ?? l.pickup_location,
        dropoff_location: l.dropoff_location,
        quantity: 1, unit_price: row.unit_price ?? Number(l.unit_price), total_price: row.unit_price ?? Number(l.unit_price),
        notes: notes ?? l.notes ?? undefined, sort_order: i,
      };
    }),
  };
}

// ── Fleet ──────────────────────────────────────────────────────────────────
const d1 = await makeDriver(1);
const d2 = await makeDriver(2);
const d3 = await makeDriver(3);
const d4 = await makeDriver(4);
const [car1, car2, car3, car4, car5, car6] = [await makeCar('Avanza'), await makeCar('Innova'), await makeCar('Xpander'), await makeCar('Zenix'), await makeCar('Hiace'), await makeCar('Fortuner')];

// ── A. Payment status follows money, not invoices (T2) ─────────────────────
await section('A. Invoice revision and payment_status (T2)', async () => {
  const o = await makeOrder('A');
  const inv = await invoice(o.id, 'DP', 200_000);
  check('A1 DP invoice issued', inv.status === 201, `status ${inv.status}`);
  check('A2 issuing does not change payment_status', (await order(o.id)).payment_status === 'UNPAID');
  const blocked = await putLine(o.service_items[0].id, { is_external: false, driver_id: d1.id, car_id: car1.id, line_status: 'ASSIGNED' });
  check('A3 driver on an unpaid order refused (409)', blocked.status === 409, blocked.json?.message);
  const rev = await call('POST', `/orders/${o.id}/invoice/${inv.data.id}/revise`, { token: admin, body: { amount: 250_000 } });
  check('A4 revision created', rev.status === 201, `status ${rev.status}`);
  const after = await order(o.id);
  check('A5 revising an unpaid DP keeps payment_status UNPAID', after.payment_status === 'UNPAID', `payment_status=${after.payment_status}`);
  const assign = await putLine(o.service_items[0].id, { is_external: false, driver_id: d1.id, car_id: car1.id, line_status: 'SCHEDULED' });
  check('A6 still no driver without money received (409)', assign.status === 409, `status ${assign.status}`);
  const direct = await call('PUT', `/orders/${o.id}`, { token: admin, body: { payment_status: 'PAID' } });
  check('A7 payment_status cannot be set through the order update', direct.status === 200 && (await order(o.id)).payment_status === 'UNPAID');
  const o2 = await makeOrder('A8');
  const full = await invoice(o2.id, 'FULL', 1_000_000);
  await call('POST', `/orders/${o2.id}/invoice/${full.data.id}/revise`, { token: admin, body: { amount: 900_000 } });
  check('A8 revising an unpaid FULL invoice keeps UNPAID', (await order(o2.id)).payment_status === 'UNPAID');
  const o3 = await makeOrder('A9');
  await payFull(o3);
  const up = await call('PUT', `/orders/${o3.id}`, { token: admin, body: editBody(o3, { reason: 'naik harga', days: [{ id: o3.service_items[0].id, unit_price: 1_200_000 }] }) });
  const a9 = await order(o3.id);
  check('A9 Edit Order raises the total of a paid order → DP_PAID', up.status === 200 && a9.payment_status === 'DP_PAID' && Number(a9.final_price) === 1200000, a9.payment_status);
  await call('PUT', `/orders/${o3.id}`, { token: admin, body: editBody(a9, { reason: 'kembali', days: [{ id: o3.service_items[0].id, unit_price: 1_000_000 }] }) });
  check('A10 back to the paid amount → PAID', (await order(o3.id)).payment_status === 'PAID');
});

// ── B. One way to assign (T4, owner decision 4 Okt) ───────────────────────
await section('B. Assignment paths (T4: one way to assign)', async () => {
  const st = async (drv) => (await prisma.driver.findUnique({ where: { id: drv.id } })).status;
  const cs = async (car) => (await prisma.car.findUnique({ where: { id: car.id } })).status;
  const oB1 = await makeOrder('B1', { startDay: 2 });
  const inv = await invoice(oB1.id, 'DP', 200_000);
  const paid = await markPaid(oB1.id, inv.data.id);
  check('B1 DP marked paid', paid.status === 200, `status ${paid.status}`);
  check('B2 payment_status DP_PAID', (await order(oB1.id)).payment_status === 'DP_PAID');
  const day1 = oB1.service_items[0].id;
  // The day drawer / Edit Hari send the day's current status with the driver.
  const r = await putLine(day1, { is_external: false, driver_id: d1.id, car_id: car1.id, line_status: 'SCHEDULED' });
  check('B3 per-day assign accepted', r.status === 200, `status ${r.status} ${r.json?.message ?? ''}`);
  const o = await order(oB1.id);
  check('B4 per-day assign makes the day ASSIGNED and the order ASSIGNED', o.service_items[0].line_status === 'ASSIGNED' && o.order_status === 'ASSIGNED', `${o.service_items[0].line_status} / ${o.order_status}`);
  check('B5 assigning is not accepting (driver_accepted_at empty)', o.service_items[0].driver_accepted_at === null);
  check('B6 default fee from the table (12H = 200.000)', Number(o.service_items[0].driver_fee) === 200000, String(o.service_items[0].driver_fee));
  const pay = await prisma.payable.findUnique({ where: { service_item_id: day1 } });
  check('B7 payable created UNPAID for the driver', pay?.status === 'UNPAID' && Number(pay.total_amount) === 200000);
  const t = (await call('GET', '/driver/trips?scope=active', { token: d1.token })).data.find((x) => x.id === day1);
  check('B8 app lists the trip ASSIGNED with driver_accepted_at null ("Terima tugas" still shown)', t?.status === 'ASSIGNED' && t.driver_accepted_at === null && t.accepted_at === null, JSON.stringify(t && { status: t.status, driver_accepted_at: t.driver_accepted_at }));
  await sleep(500);
  check('B9 driver got "Tugas baru"', (await pushesTo(d1)).some((x) => x.title === 'Tugas baru'));
  check('B10 trip in 2 days: driver and car stay AVAILABLE', (await st(d1)) === 'AVAILABLE' && (await cs(car1)) === 'AVAILABLE', `${await st(d1)} / ${await cs(car1)}`);
  const acc = await act(d1, day1, 'accept');
  const det = await call('GET', `/driver/trips/${day1}`, { token: d1.token });
  check('B11 accept sets driver_accepted_at (detail too), day stays ASSIGNED', acc.status === 200 && !!acc.data.driver_accepted_at && det.data.driver_accepted_at === acc.data.driver_accepted_at && det.data.status === 'ASSIGNED');
  const reassign = await call('POST', `/orders/${oB1.id}/reassign`, { token: admin, body: { driver_id: d2.id, car_id: car2.id } });
  const moved = await prisma.orderServiceItem.findUnique({ where: { id: day1 } });
  check('B12 "Ganti Semua" works on a per-day assigned day; the new driver has to accept again', reassign.status === 200 && moved.driver_id === d2.id && moved.line_status === 'ASSIGNED' && moved.driver_accepted_at === null, `status ${reassign.status} ${reassign.json?.message ?? ''}`);
  const un = await putLine(day1, { is_external: false, driver_id: null, car_id: null, line_status: 'ASSIGNED' });
  const ou = await order(oB1.id);
  check('B13 driver taken off a day not started: back to SCHEDULED, order CREATED', un.status === 200 && ou.service_items[0].line_status === 'SCHEDULED' && ou.order_status === 'CREATED', `${ou.service_items[0].line_status} / ${ou.order_status}`);

  // "Tetapkan untuk Semua" ends in the same state as per-day assign.
  const oB2 = await makeOrder('B2', { days: 2, price: 900_000, startDay: 3 });
  await payDp(oB2, 360_000);
  const bulk = await call('POST', `/orders/${oB2.id}/assign`, { token: admin, body: { driver_id: d2.id, car_id: car2.id } });
  check('B14 "Tetapkan untuk Semua" accepted', bulk.status === 201, `${bulk.status} ${bulk.json?.message ?? ''}`);
  const o2 = await order(oB2.id);
  check('B15 bulk = per-day: days ASSIGNED and not accepted, order ASSIGNED', o2.service_items.every((l) => l.line_status === 'ASSIGNED' && l.driver_accepted_at === null) && o2.order_status === 'ASSIGNED');
  const t2 = (await call('GET', '/driver/trips?scope=active', { token: d2.token })).data.find((x) => x.id === o2.service_items[0].id);
  check('B16 app gets ASSIGNED with driver_accepted_at null', t2?.status === 'ASSIGNED' && t2.driver_accepted_at === null);
  check('B17 trips in 3-4 days: driver AVAILABLE, car AVAILABLE (not ON_DUTY days ahead)', (await st(d2)) === 'AVAILABLE' && (await cs(car2)) === 'AVAILABLE', `${await st(d2)} / ${await cs(car2)}`);
  const oB3 = await makeOrder('B3', { price: 800_000, startDay: 6 });
  await payFull(oB3);
  const bulk3 = await call('POST', `/orders/${oB3.id}/assign`, { token: admin, body: { driver_id: d2.id, car_id: car1.id } });
  check('B18 a driver booked on other dates is free (bulk assign 201)', bulk3.status === 201, `${bulk3.status} ${bulk3.json?.message ?? ''}`);

  // Overlapping days: refused the same way on both paths, with a clear message.
  const oB4 = await makeOrder('B4', { startDay: 3 });
  await payDp(oB4, 200_000);
  const b4day = oB4.service_items[0].id;
  const clash = await putLine(b4day, { is_external: false, driver_id: d2.id, car_id: car3.id, line_status: 'SCHEDULED' });
  check('B19 per-day assign refused when the driver has an overlapping day (409, names the order)', clash.status === 409 && (clash.json?.message ?? '').includes(o2.order_code), clash.json?.message);
  const clashBulk = await call('POST', `/orders/${oB4.id}/assign`, { token: admin, body: { driver_id: d2.id, car_id: car3.id } });
  check('B20 bulk assign refused for the same overlap (409)', clashBulk.status === 409 && /sudah ada tugas lain/.test(clashBulk.json?.message ?? ''), clashBulk.json?.message);
  const carClash = await putLine(b4day, { is_external: false, driver_id: d4.id, car_id: car2.id });
  check('B21 a car on an overlapping day refused too (409)', carClash.status === 409 && /^Mobil/.test(carClash.json?.message ?? ''), carClash.json?.message);
  const late = await putLine(b4day, { is_external: false, start_at: wibIso(3, '20:30'), end_at: wibIso(3, '23:00') });
  const lateOk = await putLine(b4day, { is_external: false, driver_id: d2.id, car_id: car3.id });
  check('B22 same date, hours that do not overlap: allowed', late.status === 200 && lateOk.status === 200, lateOk.json?.message);

  // ON_DUTY / IN_USE only on the WIB day of the trip, or while it runs.
  const oB5 = await makeOrder('B5', { startDay: 0 });
  await payDp(oB5, 200_000);
  const b5day = oB5.service_items[0].id;
  await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { status: 'OFF' } });
  const off = await putLine(b5day, { is_external: false, driver_id: d4.id, car_id: car6.id });
  await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { status: 'AVAILABLE' } });
  check('B23 a driver flagged OFF cannot be given a day (409)', off.status === 409 && /OFF/.test(off.json?.message ?? ''), off.json?.message);
  const today = await putLine(b5day, { is_external: false, driver_id: d4.id, car_id: car6.id });
  check('B24 trip today: driver ON_DUTY, car IN_USE', today.status === 200 && (await st(d4)) === 'ON_DUTY' && (await cs(car6)) === 'IN_USE', `${today.status} ${await st(d4)} / ${await cs(car6)}`);
  const tomorrow = await putLine(b5day, { is_external: false, service_date: wibIso(1, '00:00'), start_at: wibIso(1, '08:00'), end_at: wibIso(1, '20:00') });
  check('B25 the same trip moved to tomorrow: driver and car AVAILABLE again', tomorrow.status === 200 && (await st(d4)) === 'AVAILABLE' && (await cs(car6)) === 'AVAILABLE', `${await st(d4)} / ${await cs(car6)}`);
  const moveTo = async (day) =>
    call('PUT', `/orders/${oB5.id}`, { token: admin, body: editBody(await order(oB5.id), { days: [{ id: b5day, service_date: wibIso(day, '00:00'), start_at: wibIso(day, '08:00'), end_at: wibIso(day, '20:00') }] }) });
  const back = await moveTo(0);
  check('B26 Edit Order moving it back to today: ON_DUTY / IN_USE at once', back.status === 200 && (await st(d4)) === 'ON_DUTY' && (await cs(car6)) === 'IN_USE', `${back.status} ${back.json?.message ?? ''}`);
  const again = await moveTo(1);
  check('B27 and to tomorrow again: AVAILABLE', again.status === 200 && (await st(d4)) === 'AVAILABLE' && (await cs(car6)) === 'AVAILABLE');
  const started = await act(d4, b5day, 'start');
  check('B28 a trip under way keeps driver ON_DUTY and car IN_USE whatever its date', started.status === 200 && (await st(d4)) === 'ON_DUTY' && (await cs(car6)) === 'IN_USE');
  // The only day cannot be cancelled in Edit Hari any more (B1.1): the order is cancelled.
  const closed = await call('POST', `/orders/${oB5.id}/cancel`, { token: admin, body: { reason: 'tes B29' } });
  check('B29 trip closed (order cancelled): driver and car AVAILABLE', closed.status === 200 && (await st(d4)) === 'AVAILABLE' && (await cs(car6)) === 'AVAILABLE', `${closed.status} ${closed.json?.message ?? ''}`);

  // Two units on the same date and hours: one driver / car cannot take both
  // on the bulk paths either (per-day assign already refuses the second).
  const [d7, d8, d9] = [await makeDriver(7), await makeDriver(8), await makeDriver(9)];
  const [car7, car8, car9] = [await makeCar('Alphard'), await makeCar('Calya'), await makeCar('Sigra')];
  const unit = { service_date: wibIso(8, '00:00'), start_at: wibIso(8, '08:00'), end_at: wibIso(8, '20:00'), pickup_location: 'Bogor Botani Square', dropoff_location: 'Bandara Soetta', service_kind: '12H', service_package: 'ALL-IN', unit_price: 500_000 };
  const cr = await call('POST', '/orders', {
    token: admin,
    body: { customer_name: `TEST B6 ${tag}`, customer_phone: `0857${rnd()}`, pickup_location: 'Bogor Botani Square', dropoff_location: 'Bandara Soetta', order_date: new Date().toISOString(), final_price: 1_000_000, service_items: [unit, { ...unit }] },
  });
  const oB6 = await order(cr.data.id);
  await payDp(oB6, 300_000);
  const [u1, u2] = oB6.service_items.map((l) => l.id);
  const days6 = () => prisma.orderServiceItem.findMany({ where: { order_id: oB6.id } });
  const both = await call('POST', `/orders/${oB6.id}/assign`, { token: admin, body: { driver_id: d7.id, car_id: car7.id } });
  check('B30 bulk assign refused when two days of the order overlap (409), nothing assigned', both.status === 409 && /dua hari/.test(both.json?.message ?? '') && (await days6()).every((l) => l.driver_id === null), `${both.status} ${both.json?.message ?? ''}`);
  const p1 = await putLine(u1, { is_external: false, driver_id: d7.id, car_id: car7.id });
  const p2 = await putLine(u2, { is_external: false, driver_id: d8.id, car_id: car8.id });
  const swap = await call('POST', `/orders/${oB6.id}/reassign`, { token: admin, body: { driver_id: d9.id, car_id: car9.id } });
  const kept = await days6();
  check('B31 "Ganti Semua" refused when one driver would get both overlapping days (409), days unchanged', p1.status === 200 && p2.status === 200 && swap.status === 409 && /dua hari/.test(swap.json?.message ?? '') && kept.some((l) => l.driver_id === d7.id) && kept.some((l) => l.driver_id === d8.id), `${p1.status} ${p2.status} ${swap.status} ${swap.json?.message ?? ''}`);
  const evening = await putLine(u2, { is_external: false, start_at: wibIso(8, '20:30'), end_at: wibIso(8, '23:00') });
  const swap2 = await call('POST', `/orders/${oB6.id}/reassign`, { token: admin, body: { driver_id: d9.id, car_id: car9.id } });
  check('B32 same date, hours that do not overlap: "Ganti Semua" gives both days to one driver', evening.status === 200 && swap2.status === 200 && (await days6()).every((l) => l.driver_id === d9.id && l.car_id === car9.id), `${evening.status} ${swap2.status} ${swap2.json?.message ?? ''}`);

  // Two admins give one driver overlapping days of two orders at the same
  // moment: the second waits for the first and is refused (not both saved).
  const d10 = await makeDriver(10);
  const d11 = await makeDriver(11);
  const [car10, car11, car12, car13] = [await makeCar('Ertiga'), await makeCar('Terios'), await makeCar('Rush'), await makeCar('Livina')];
  const racePair = async (name, first, second) => {
    const oa = await makeOrder(`${name}a`, { startDay: 9 });
    const ob = await makeOrder(`${name}b`, { startDay: 9 });
    await payDp(oa, 200_000);
    await payDp(ob, 200_000);
    return Promise.all([first(oa), second(ob)]);
  };
  const r1 = await racePair('B7',
    (o) => putLine(o.service_items[0].id, { is_external: false, driver_id: d10.id, car_id: car10.id }),
    (o) => putLine(o.service_items[0].id, { is_external: false, driver_id: d10.id, car_id: car11.id }));
  const held10 = await prisma.orderServiceItem.count({ where: { driver_id: d10.id } });
  check('B33 two per-day assigns of one driver to overlapping days at once: one saved, the other 409', r1.filter((r) => r.status === 409).length === 1 && held10 === 1, r1.map((r) => `${r.status} ${r.json?.message ?? ''}`).join(' | '));
  const r2 = await racePair('B8',
    (o) => putLine(o.service_items[0].id, { is_external: false, driver_id: d11.id, car_id: car12.id }),
    (o) => call('POST', `/orders/${o.id}/assign`, { token: admin, body: { driver_id: d11.id, car_id: car13.id } }));
  const held11 = await prisma.orderServiceItem.count({ where: { driver_id: d11.id } });
  check('B34 per-day assign and "Tetapkan untuk Semua" of one driver at once: one saved, the other 409', r2.filter((r) => r.status === 409).length === 1 && held11 === 1, r2.map((r) => `${r.status} ${r.json?.message ?? ''}`).join(' | '));
});

// ── C. Edit Order keeps the days (T1) ──────────────────────────────────────
await section('C. Edit Order on a running order (T1)', async () => {
  const o = await makeOrder('C', { startDay: 0 });
  await payFull(o);
  const asg = await call('POST', `/orders/${o.id}/assign`, { token: admin, body: { driver_id: d1.id, car_id: car3.id } });
  check('C0 bulk assign', asg.status === 201, asg.json?.message);
  const lineId = o.service_items[0].id;
  check('C1 driver starts the trip', (await act(d1, lineId, 'start')).status === 200);
  check('C2 fuel receipt stored', (await report(d1, lineId, { report_type: 'FUEL', amount: 150000, notes: 'Pertalite' })).status === 200);
  const exp = await prisma.expense.findFirst({ where: { order_service_item_id: lineId } });
  await call('PATCH', `/lines/expenses/${exp.id}`, { token: admin, body: { status: 'APPROVED' } });
  const pay = await prisma.payable.findUnique({ where: { service_item_id: lineId } });
  await call('POST', `/payables/${pay.id}/mark-paid`, { token: admin, body: { payment_method: 'CASH' } });
  const cur = await order(o.id);
  check('C3 before edit: IN_PROGRESS, payable PAID', cur.order_status === 'IN_PROGRESS' && (await prisma.payable.findUnique({ where: { id: pay.id } })).status === 'PAID');

  const edit = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(cur, { notes: 'catatan baru', days: [{ id: lineId, pickup_location: 'Lobby Botani Square' }] }) });
  check('C5 edit accepted', edit.status === 200, `status ${edit.status} ${edit.json?.message ?? ''}`);
  const after = await order(o.id);
  const nl = after.service_items[0];
  check('C6 the day keeps its id', after.service_items.length === 1 && nl.id === lineId);
  check('C7 driver, car and IN_PROGRESS kept; content updated', nl.driver_id === d1.id && nl.car_id === car3.id && nl.line_status === 'IN_PROGRESS' && nl.pickup_location === 'Lobby Botani Square' && nl.notes === 'catatan baru');
  check('C8 paid payable kept', (await prisma.payable.count({ where: { id: pay.id, status: 'PAID' } })) === 1);
  check('C9 approved receipt kept', (await prisma.expense.count({ where: { id: exp.id, status: 'APPROVED' } })) === 1);
  check('C10 order still IN_PROGRESS with an IN_PROGRESS day', after.order_status === 'IN_PROGRESS');
  const trip = await call('GET', `/driver/trips/${lineId}`, { token: d1.token });
  check('C11 driver still has the trip, with the new pickup', trip.status === 200 && trip.data.pickup_location === 'Lobby Botani Square');
  const reports = await prisma.tripReport.count({ where: { order_service_item_id: lineId } });
  check('C12 reports still attached to the day', reports >= 2, `reports=${reports}`);

  const drop = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(after, { days: [{ service_date: nl.service_date, start_at: nl.start_at, end_at: nl.end_at }] }) });
  check('C13 replacing a running day with a new one refused (409), nothing changed', drop.status === 409 && (await order(o.id)).service_items[0].id === lineId, drop.json?.message);
  const legacy = await call('PUT', `/orders/${o.id}`, {
    token: admin,
    body: { ...editBody(after), service_items: editBody(after).service_items.map(({ id, ...rest }) => rest) },
  });
  check('C14 an old dashboard without day ids cannot wipe it (409)', legacy.status === 409 && (await order(o.id)).service_items[0].id === lineId);
  const bad = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(after, { days: [{ id: uuid() }] }) });
  check('C15 unknown day id refused (400)', bad.status === 400);

  const added = await call('PUT', `/orders/${o.id}`, {
    token: admin,
    body: editBody(after, { reason: 'tambah hari', days: [{ id: lineId }, { service_date: wibIso(1, '00:00'), start_at: wibIso(1, '08:00'), end_at: wibIso(1, '20:00'), unit_price: 1_000_000 }] }),
  });
  const o3 = await order(o.id);
  const newDay = o3.service_items.find((l) => l.id !== lineId);
  check('C16 adding a day: new SCHEDULED day, running day untouched', added.status === 200 && o3.service_items.length === 2 && newDay?.line_status === 'SCHEDULED' && !newDay.driver_id && o3.service_items.find((l) => l.id === lineId).line_status === 'IN_PROGRESS', added.json?.message);
  check('C17 order total follows the days (2 × 1.000.000; fuel is not billed on ALL-IN)', Number(o3.final_price) === 2000000, String(o3.final_price));
  const noReason = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(o3, { days: [{ id: lineId }, { id: newDay.id, unit_price: 1_200_000 }] }) });
  check('C18 price change without a reason refused (400)', noReason.status === 400);
  // A3 (owner, 7 Oct 2026): an order that has money keeps its days in Edit
  // Order; a day comes off through Edit Hari, so its cancellation fee counts.
  // (Before A3 the untouched new day was removed for free, total 1.000.000.)
  const removeNew = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(o3, { reason: 'batal tambah', days: [{ id: lineId }] }) });
  const o4 = await order(o.id);
  check('C19 [A3] removing a day of an order that has money refused (409 DAY_DELETE_NEEDS_CANCEL, points to Edit Hari); day and total 2.000.000 kept',
    removeNew.status === 409 && removeNew.json?.code === 'DAY_DELETE_NEEDS_CANCEL' && /Batalkan hari itu lewat Edit Hari supaya biaya pembatalan dihitung/.test(removeNew.json?.message ?? '') &&
    o4.service_items.length === 2 && Number(o4.final_price) === 2000000, `${removeNew.status} ${removeNew.json?.code ?? ''} ${removeNew.json?.message ?? ''} ${o4.final_price}`);
  const cancelNew = await putLine(newDay.id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'batal tambah hari' });
  const o4b = await order(o.id);
  check('C19b [A3] cancelled in Edit Hari instead: tier 1 (tomorrow), fee 200.000, total 1.200.000',
    cancelNew.status === 200 && cancelNew.data?.cancellation?.tier === 1 && Number(cancelNew.data?.cancel_fee) === 200000 && Number(o4b.final_price) === 1200000,
    `${cancelNew.status} ${cancelNew.json?.message ?? ''} ${JSON.stringify(cancelNew.data?.cancellation)} ${o4b.final_price}`);
  check('C20 driver not stuck: ON_DUTY because of the running day', (await prisma.driver.findUnique({ where: { id: d1.id } })).status === 'ON_DUTY');
  check('C21 an order must keep at least one day (400)', (await call('PUT', `/orders/${o.id}`, { token: admin, body: { ...editBody(o4), service_items: [] } })).status === 400);

  // Mixed order: one day handed to a partner; a day added later starts internal.
  const m = await makeOrder('C22', { days: 2, startDay: 5 });
  const vendor = await call('POST', '/external-vendors', { token: admin, body: { name: `Vendor C ${tag}`, phone: '081211111111' } });
  await putLine(m.service_items[1].id, { is_external: true, external_vendor_id: vendor.data.id, driver_name_raw: 'Pak Ujang', plate_raw: 'F 1 AA', rtr_amount: 500000 });
  const mo = await order(m.id);
  const addM = await call('PUT', `/orders/${m.id}`, {
    token: admin,
    body: editBody(mo, { reason: 'tambah hari', days: [...mo.service_items.map((l) => ({ id: l.id })), { service_date: wibIso(7, '00:00'), start_at: wibIso(7, '08:00'), end_at: wibIso(7, '20:00'), unit_price: 1_000_000 }] }),
  });
  const mAfter = await order(m.id);
  const addedDay = mAfter.service_items.find((l) => !mo.service_items.some((x) => x.id === l.id));
  check('C22 day added to a mixed order is internal (no vendor)', addM.status === 200 && addedDay && !addedDay.is_external && !addedDay.external_vendor_id, addM.json?.message);
  // A day with only a car reserved is in use: not deleted by leaving it out.
  await putLine(addedDay.id, { is_external: false, car_id: car5.id });
  const dropCar = await call('PUT', `/orders/${m.id}`, { token: admin, body: editBody(mAfter, { reason: 'hapus hari', days: mo.service_items.map((l) => ({ id: l.id })) }) });
  check('C23 a day with a car reserved cannot be removed (409)', dropCar.status === 409 && (await order(m.id)).service_items.length === 3);
  const dropPartner = await call('PUT', `/orders/${m.id}`, { token: admin, body: editBody(mAfter, { reason: 'hapus hari', days: [{ id: mo.service_items[0].id }, { id: addedDay.id }] }) });
  check('C24 a partner day with driver/plate cannot be removed (409)', dropPartner.status === 409);

  // Edit Order and a driver action on the same order at the same moment.
  const race = await makeOrder('C25', { startDay: 0 });
  await payFull(race);
  await putLine(race.service_items[0].id, { is_external: false, driver_id: d3.id, car_id: car4.id, line_status: 'ASSIGNED' });
  const ro = await order(race.id);
  const [er, sr] = await Promise.all([
    call('PUT', `/orders/${race.id}`, { token: admin, body: editBody(ro, { notes: 'balapan', days: [{ id: ro.service_items[0].id, pickup_location: 'Gerbang Tol Bogor' }] }) }),
    act(d3, ro.service_items[0].id, 'start'),
  ]);
  const raceLine = (await order(race.id)).service_items[0];
  check('C25 Edit Order + "Berangkat" at once: both succeed, day kept and started', er.status === 200 && sr.status === 200 && raceLine.line_status === 'IN_PROGRESS' && raceLine.pickup_location === 'Gerbang Tol Bogor', `${er.status}/${sr.status}`);
  await act(d3, ro.service_items[0].id, 'finish');

  // The same "add a day" save sent twice at once: one day, not two.
  const dbl = await makeOrder('C26', { startDay: 9 });
  const dblBody = editBody(dbl, { reason: 'tambah hari', days: [{ id: dbl.service_items[0].id }, { service_date: wibIso(10, '00:00'), start_at: wibIso(10, '08:00'), end_at: wibIso(10, '20:00'), unit_price: 1_000_000 }] });
  const [s1, s2] = await Promise.all([
    call('PUT', `/orders/${dbl.id}`, { token: admin, body: dblBody }),
    call('PUT', `/orders/${dbl.id}`, { token: admin, body: dblBody }),
  ]);
  check('C26 double "add a day" save: one 200, one 409, one new day', [s1.status, s2.status].sort().join() === '200,409' && (await order(dbl.id)).service_items.length === 2, `${s1.status}/${s2.status}`);

  // Moving a day already given to a driver: driver told, confirmation to resend.
  const mv = await order(o.id);
  await call('POST', `/schedule/lines/${lineId}/send-confirmation`, { token: admin, body: {} });
  const before = await prisma.orderServiceItem.findUnique({ where: { id: lineId } });
  // A3: every day is sent (the day cancelled in C19b too); leaving one out
  // would be a delete, refused on an order with money.
  const moved = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(mv, { days: mv.service_items.map((l) => (l.id === lineId ? { id: lineId, start_at: wibIso(0, '10:30') } : { id: l.id })) }) });
  await sleep(600);
  const afterMove = await prisma.orderServiceItem.findUnique({ where: { id: lineId } });
  check('C27 moving a driver\'s day: confirmation reset, driver told "Jadwal tugas diubah"', moved.status === 200 && !!before.confirmation_sent_at && !afterMove.confirmation_sent_at && (await pushesTo(d1)).some((x) => x.title === 'Jadwal tugas diubah'), moved.json?.message);

  // Removing the last open day would cancel the order: use Batalkan Pesanan.
  const lc = await makeOrder('C28', { days: 2, startDay: 11 });
  await putLine(lc.service_items[0].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes C28' });
  const lcRes = await call('PUT', `/orders/${lc.id}`, { token: admin, body: editBody(await order(lc.id), { reason: 'hapus', days: [{ id: lc.service_items[0].id }] }) });
  check('C28 removing the last open day refused (409), order not cancelled', lcRes.status === 409 && (await order(lc.id)).order_status !== 'CANCELLED', lcRes.json?.message);

  // A cancelled day that kept its driver stays on the order, with a clear message.
  const cd = await makeOrder('C29', { days: 2, startDay: 12 });
  await payDp(cd, 400_000);
  await putLine(cd.service_items[0].id, { is_external: false, driver_id: d3.id, line_status: 'ASSIGNED' });
  await putLine(cd.service_items[0].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes C29' });
  const cdRes = await call('PUT', `/orders/${cd.id}`, { token: admin, body: editBody(await order(cd.id), { reason: 'hapus', days: [{ id: cd.service_items[1].id }] }) });
  check('C29 cancelled day with a driver cannot be removed; message says it stays', cdRes.status === 409 && /sudah dibatalkan/.test(cdRes.json?.message ?? ''), cdRes.json?.message);

  // A day stored at 08:00 WIB (made without a date): the form sends WIB
  // midnight of the same day, which is not a move.
  const nd = await call('POST', '/orders', {
    token: admin,
    body: {
      customer_name: `TEST C30 ${tag}`, customer_phone: `0857${rnd()}`, pickup_location: 'Bogor', dropoff_location: 'Jakarta',
      order_date: new Date().toISOString(), final_price: 1_000_000,
      service_items: [{ start_at: wibIso(13, '08:00'), end_at: wibIso(13, '20:00'), pickup_location: 'Bogor', dropoff_location: 'Jakarta', service_kind: '12H', service_package: 'ALL-IN', unit_price: 1_000_000 }],
    },
  });
  const ndo = await order(nd.data.id);
  await payDp(ndo, 200_000);
  await putLine(ndo.service_items[0].id, { is_external: false, driver_id: d2.id, car_id: car2.id, line_status: 'ASSIGNED' });
  await call('POST', `/schedule/lines/${ndo.service_items[0].id}/send-confirmation`, { token: admin, body: {} });
  const pushesBefore = (await pushesTo(d2)).length;
  const ndEdit = await call('PUT', `/orders/${ndo.id}`, { token: admin, body: editBody(await order(ndo.id), { notes: 'x', days: [{ id: ndo.service_items[0].id, service_date: wibIso(13, '00:00') }] }) });
  await sleep(600);
  const ndLine = await prisma.orderServiceItem.findUnique({ where: { id: ndo.service_items[0].id } });
  check('C30 same WIB day sent as midnight is not a move (no push, confirmation kept)', ndEdit.status === 200 && !!ndLine.confirmation_sent_at && (await pushesTo(d2)).length === pushesBefore, ndEdit.json?.message);
  check('C31 final_price alone cannot be set (400)', (await call('PUT', `/orders/${ndo.id}`, { token: admin, body: { final_price: 5_000_000, change_reason: 'x' } })).status === 400);
  // A stored total that is out of date (charges an older edit left out) is
  // corrected by the next edit without asking for a reason.
  await call('POST', `/orders/${ndo.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'OT 2 jam', amount: 60000 } });
  await prisma.order.update({ where: { id: ndo.id }, data: { final_price: 1_000_000 } });
  const st = await call('PUT', `/orders/${ndo.id}`, { token: admin, body: editBody(await order(ndo.id), { notes: 'y' }) });
  check('C32 stale total corrected on the next edit (no reason needed), logged', st.status === 200 && Number((await order(ndo.id)).final_price) === 1060000 && (await prisma.orderChangeLog.count({ where: { order_id: ndo.id, actor: 'SYSTEM' } })) === 1, st.json?.message);
});

// ── D. Full driver flow ────────────────────────────────────────────────────
await section('D. Driver flow', async () => {
  const o = await makeOrder('D', { startDay: 0 });
  await payDp(o, 300_000);
  const lineId = o.service_items[0].id;
  await putLine(lineId, { is_external: false, driver_id: d2.id, car_id: car1.id, line_status: 'ASSIGNED' });
  const acc = await act(d2, lineId, 'accept');
  check('D1 accept: driver_accepted_at set, status unchanged', acc.status === 200 && !!acc.data.driver_accepted_at && acc.data.accepted_at === acc.data.driver_accepted_at && acc.data.status === 'ASSIGNED');
  const ref = uuid();
  const s1 = await act(d2, lineId, 'start', { client_ref: ref });
  const s2 = await act(d2, lineId, 'start', { client_ref: ref });
  const starts = await prisma.tripReport.count({ where: { order_service_item_id: lineId, report_type: 'START' } });
  check('D2 start → IN_PROGRESS; resend is a no-op', s1.data.status === 'IN_PROGRESS' && s2.status === 200 && starts === 1);
  const arr = await act(d2, lineId, 'arrive', { latitude: -6.56, longitude: 106.8, location_accuracy_m: 12, location_mocked: false });
  check('D3 arrive records actual_pickup_at', arr.status === 200 && !!arr.data.actual_pickup_at);
  check('D4 ARRIVAL_PHOTO without GPS refused (400)', (await report(d2, lineId, { report_type: 'ARRIVAL_PHOTO', stamped: 'true' })).status === 400);
  const ap = await report(d2, lineId, { report_type: 'ARRIVAL_PHOTO', stamped: 'true', latitude: -6.56, longitude: 106.8, location_accuracy_m: 12, location_mocked: 'true' });
  const apRow = await prisma.tripReport.findFirst({ where: { order_service_item_id: lineId, report_type: 'ARRIVAL_PHOTO' } });
  check('D5 ARRIVAL_PHOTO stored with GPS and the mock flag', ap.status === 200 && apRow?.location_mocked === true && !!apRow.file_url);
  check('D6 board refused while not paid in full (409)', (await act(d2, lineId, 'board')).status === 409);
  check('D7 finish without board refused while not paid (409)', (await act(d2, lineId, 'finish')).status === 409);
  check('D8 payment_ready=false shown to the driver', (await call('GET', `/driver/trips/${lineId}`, { token: d2.token })).data.payment_ready === false);
  const st = await invoice(o.id, 'SETTLEMENT', 700_000);
  await markPaid(o.id, st.data.id);
  await sleep(800);
  check('D9 driver told "Order … sudah lunas"', (await pushesTo(d2)).some((x) => /sudah lunas/.test(x.title)));
  const board2 = await act(d2, lineId, 'board');
  check('D10 board allowed once paid in full', board2.status === 200 && !!board2.data.customer_onboard_at);
  check('D11 odometer end before start refused (409)', (await report(d2, lineId, { report_type: 'ODOMETER_END', amount: 1000 })).status === 409);
  check('D12 odometer without photo refused (400)', (await report(d2, lineId, { report_type: 'ODOMETER_START', amount: 1000 }, false)).status === 400);
  check('D13 odometer start OK', (await report(d2, lineId, { report_type: 'ODOMETER_START', amount: 45210 })).status === 200);
  check('D14 second odometer start refused (409)', (await report(d2, lineId, { report_type: 'ODOMETER_START', amount: 45211 })).status === 409);
  check('D15 odometer end below start refused (409)', (await report(d2, lineId, { report_type: 'ODOMETER_END', amount: 45000 })).status === 409);
  check('D16 odometer end OK', (await report(d2, lineId, { report_type: 'ODOMETER_END', amount: 45380 })).status === 200);
  const pr = uuid();
  const p1 = await report(d2, lineId, { report_type: 'PARKING', amount: 20000, client_ref: pr });
  const p2 = await report(d2, lineId, { report_type: 'PARKING', amount: 20000, client_ref: pr });
  check('D17 parking receipt resend is a no-op', p1.status === 200 && p2.status === 200 && (await prisma.expense.count({ where: { order_service_item_id: lineId, type: 'PARKING' } })) === 1);
  const f = new FormData();
  f.append('report_type', 'NOTE');
  f.append('client_ref', uuid());
  f.append('notes', 'x');
  check('D18 another driver cannot report on this trip (404)', (await call('POST', `/driver/trips/${lineId}/reports`, { token: d1.token, form: f })).status === 404);
  const fin = await act(d2, lineId, 'finish', { notes: 'selesai' });
  check('D19 finish → DONE; order awaits finalization', fin.data.status === 'DONE' && (await order(o.id)).awaiting_finalization === true);
  const cDone = await call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'x' } });
  check('D19b cancel refused once every day is done (409), invoices untouched', cDone.status === 409 && (await order(o.id)).invoices.every((i) => i.status !== 'CANCELLED'), cDone.json?.message);
  check('D20 late receipt after DONE accepted', (await report(d2, lineId, { report_type: 'TOLL', amount: 30000 })).status === 200);
  check('D21 finalize refused while costs are PENDING (409)', (await call('POST', `/orders/${o.id}/finalize`, { token: admin })).status === 409);
  for (const e of await prisma.expense.findMany({ where: { order_service_item_id: lineId } })) {
    const body = e.type === 'TOLL' ? { status: 'REJECTED', review_note: 'struk tidak terbaca' } : { status: 'APPROVED' };
    await call('PATCH', `/lines/expenses/${e.id}`, { token: admin, body });
  }
  await sleep(800);
  check('D22 driver told "Biaya ditolak" with the reason', (await pushesTo(d2)).some((x) => x.title === 'Biaya ditolak' && /tidak terbaca/.test(x.body)));
  const pay = await prisma.payable.findUnique({ where: { service_item_id: lineId } });
  check('D23 payable = fee 200.000 + parking 20.000', Number(pay.total_amount) === 220000, String(pay.total_amount));
  const fz = await call('POST', `/orders/${o.id}/finalize`, { token: admin });
  check('D24 finalize → DONE', fz.status === 200 && fz.data.order_status === 'DONE');
  check('D25 DONE order is read-only (409)', (await call('PUT', `/orders/${o.id}`, { token: admin, body: { notes: 'x' } })).status === 409);
  const [r1, r2] = await Promise.all([
    call('POST', `/payables/${pay.id}/mark-paid`, { token: admin, body: {} }),
    call('POST', `/payables/${pay.id}/mark-paid`, { token: admin, body: {} }),
  ]);
  await sleep(800);
  const feePush = (await pushesTo(d2)).filter((x) => x.title === 'Fee sudah dibayar');
  check('D26 double "Tandai dibayar" pays and notifies once', [r1.status, r2.status].includes(200) && feePush.length === 1, `pushes ${feePush.length}`);
  const inbox = await call('GET', '/driver/notifications', { token: d2.token });
  check('D27 inbox keeps every push, all unread', inbox.data.items.length >= 4 && inbox.data.unread === inbox.data.items.length);
  check('D28 mark all read → unread 0', (await call('POST', '/driver/notifications/read', { token: d2.token, body: { all: true } })).data.unread === 0);
  const reopen = await putLine(lineId, { is_external: false, line_status: 'IN_PROGRESS' });
  const kept = await prisma.orderServiceItem.findUnique({ where: { id: lineId } });
  check('D29 [T5] a day of a finalized order cannot be reopened (409, clear message)', reopen.status === 409 && /sudah selesai/.test(reopen.json?.message ?? '') && kept.line_status === 'DONE', reopen.json?.message);
  const fee = await putLine(lineId, { is_external: false, driver_fee: 999000 });
  check('D30 [T5] nor its driver fee changed in Edit Hari (409)', fee.status === 409 && Number((await prisma.orderServiceItem.findUnique({ where: { id: lineId } })).driver_fee) === 200000);
  check('D31 [T5] "Ganti Semua" on a finalized order refused (409)', (await call('POST', `/orders/${o.id}/reassign`, { token: admin, body: { driver_id: d1.id, car_id: car2.id } })).status === 409);
});

// ── E. Cancellation ────────────────────────────────────────────────────────
await section('E. Cancellation', async () => {
  const o = await makeOrder('E', { days: 2, price: 500_000, startDay: 3 });
  const dp = await payDp(o, 300_000);
  const ea = await call('POST', `/orders/${o.id}/assign`, { token: admin, body: { driver_id: d3.id, car_id: car4.id } });
  check('E0 assign for E', ea.status === 201, ea.json?.message);
  const c = await call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'Pelanggan batal' } });
  check('E1 tier 1 before day H: penalty 20% = 200.000, refund 100.000', c.data?.tier === 1 && c.data.penalty === 200000 && c.data.refundDue === 100000, JSON.stringify(c.data));
  const after = await order(o.id);
  check('E2 order CANCELLED, days CANCELLED, driver released, fee 0', after.order_status === 'CANCELLED' && after.service_items.every((l) => l.line_status === 'CANCELLED' && !l.driver_id && Number(l.driver_fee) === 0));
  // A3: Batalkan Pesanan voids only unpaid invoices; the paid DP stays PAID.
  // Fee 2 days × 20% = 200.000 of the 300.000 received: 100.000 is released
  // as saldo lebih, and refundDue is that credit.
  check('E3 [A6, A3] DP covers the fee: no cancellation-fee invoice, the paid DP stays PAID, fee stored on the order, 100.000 saldo lebih',
    !after.invoices.some((i) => i.invoice_type === 'CANCELLATION_FEE') && after.invoices.find((i) => i.id === dp.id).status === 'PAID' &&
    Number(after.cancellation_fee) === 200000 && after.cancellation_reason === 'Pelanggan batal' && !!after.cancelled_at &&
    after.money?.credit_balance === 100000 && c.data?.refundDue === 100000,
    `DP ${after.invoices.find((i) => i.id === dp.id)?.status}, credit ${after.money?.credit_balance}, refundDue ${c.data?.refundDue}`);
  check('E4 driver action on the cancelled day → 404', (await act(d3, o.service_items[0].id, 'start')).status === 404);
  check('E5 cancelling twice refused (409)', (await call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'lagi' } })).status === 409);
  check('E6 driver AVAILABLE again', (await prisma.driver.findUnique({ where: { id: d3.id } })).status === 'AVAILABLE');
  const reopen = await putLine(o.service_items[0].id, { is_external: false, line_status: 'SCHEDULED' });
  check('E7 [T5] a day of a cancelled order cannot be reopened (409, clear message)', reopen.status === 409 && /sudah dibatalkan/.test(reopen.json?.message ?? ''), reopen.json?.message);
  const give = await putLine(o.service_items[1].id, { is_external: false, driver_id: d1.id, car_id: car1.id });
  const e8 = await prisma.orderServiceItem.findUnique({ where: { id: o.service_items[1].id } });
  check('E8 [T5] nor given a driver again (409, day unchanged)', give.status === 409 && e8.line_status === 'CANCELLED' && !e8.driver_id);
});

// ── F. Auth ────────────────────────────────────────────────────────────────
await section('F. Auth', async () => {
  const intl = '+62 ' + d1.phone.slice(1, 4) + '-' + d1.phone.slice(4);
  check('F1 login with +62 / spaces / dashes', (await call('POST', '/auth/login', { body: { identifier: intl, password: 'test1234' } })).status === 200);
  check('F2 wrong password → 401', (await call('POST', '/auth/login', { body: { identifier: d1.phone, password: 'wrong' } })).status === 401);
  check('F3 driver token on admin API → 403', (await call('GET', '/orders', { token: d1.token })).status === 403);
  check('F4 admin token on driver API → 403', (await call('GET', '/driver/trips', { token: admin })).status === 403);
  check('F5 duplicate driver phone (628… form) refused (409)', (await call('PUT', `/drivers/${d2.id}`, { token: admin, body: { phone: '62' + d1.phone.slice(1) } })).status === 409);
});

// ── G. Payments (T3) ───────────────────────────────────────────────────────
await section('G. Payments (T3)', async () => {
  const o = await makeOrder('G');
  const inv = await invoice(o.id, 'DP', 200_000);
  const [a, b] = await Promise.all([markPaid(o.id, inv.data.id), markPaid(o.id, inv.data.id)]);
  const receipts = await prisma.receipt.count({ where: { invoice_id: inv.data.id } });
  check('G1 double "Tandai Terbayar" makes one receipt', a.status === 200 && b.status === 200 && receipts === 1, `statuses ${a.status}/${b.status}, receipts=${receipts}`);
  const cust = await prisma.customer.findUnique({ where: { id: o.customer_id } });
  check('G2 customer total_paid counted once (200.000)', Number(cust.total_paid) === 200000, String(cust.total_paid));
  const ord = await order(o.id);
  check('G2b order paid_to_date 200.000, DP_PAID', Number(ord.paid_to_date) === 200000 && ord.payment_status === 'DP_PAID');
  check('G3 DP below 20% refused (409)', (await invoice(o.id, 'DP', 100_000)).status === 409);
  check('G4 invoice above the remaining balance refused (409)', (await invoice(o.id, 'SETTLEMENT', 900_000)).status === 409);
  check('G5 FULL when another invoice exists refused (409)', (await invoice(o.id, 'FULL', 800_000)).status === 409);
  const o2 = await makeOrder('G6');
  check('G6 SETTLEMENT without a DP refused (409)', (await invoice(o2.id, 'SETTLEMENT', 500_000)).status === 409);
  const inv7 = await invoice(o2.id, 'FULL', 1_000_000);
  const p7 = await markPaid(o2.id, inv7.data.id, { amount_received: 1_100_000, amount_mismatch_ack: true });
  const ord7 = await order(o2.id);
  check('G7 overpayment: PAID, paid_to_date 1.100.000', p7.status === 200 && ord7.payment_status === 'PAID' && Number(ord7.paid_to_date) === 1100000);
  check('G8 mark-paid without proof refused (400)', (await call('POST', `/orders/${o2.id}/invoice/${inv7.data.id}/mark-paid`, { token: admin, form: new FormData() })).status === 400);
  // G9 (finance A2): refunds go through /refunds, bounded by the saldo lebih
  // (the 100.000 overpaid); the old endpoint is an alias with the same bound.
  const rf = new FormData();
  rf.append('proof', jpeg(), 'r.jpg');
  rf.append('amount', '100000');
  rf.append('client_ref', uuid());
  const ref = await call('POST', `/orders/${o2.id}/refunds`, { token: admin, form: rf });
  const ord9 = await order(o2.id);
  check('G9 refund of the 100.000 saldo lebih recorded with proof (201); the old refund columns follow',
    ref.status === 201 && Number(ref.data?.refund?.amount) === 100000 && Number(ord9.refund_amount) === 100000 && ord9.is_refunded === true && ord9.money.credit_balance === 0,
    `${ref.status} ${ref.json?.message ?? ''} ${ord9.refund_amount} ${ord9.money?.credit_balance}`);
  const rfOld = new FormData();
  rfOld.append('proof', jpeg(), 'r.jpg');
  const refOld = await call('POST', `/orders/${o2.id}/mark-refunded`, { token: admin, form: rfOld });
  check('G9b the old mark-refunded (alias) finds no saldo lebih left: refused (400), nothing refunded twice',
    refOld.status === 400 && Number((await order(o2.id)).refunded_total) === 100000, `${refOld.status} ${refOld.json?.message ?? ''}`);
  check('G10 revising a PAID invoice refused (409)', (await call('POST', `/orders/${o2.id}/invoice/${inv7.data.id}/revise`, { token: admin, body: { amount: 900_000 } })).status === 409);
  // Two different invoices of one order paid at the same moment: both counted.
  const o3 = await makeOrder('G11');
  const i1 = await invoice(o3.id, 'DP', 400_000);
  const i2 = await invoice(o3.id, 'SETTLEMENT', 600_000);
  await Promise.all([markPaid(o3.id, i1.data.id), markPaid(o3.id, i2.data.id)]);
  const ord3 = await order(o3.id);
  check('G11 two invoices paid at once: paid_to_date 1.000.000, PAID', Number(ord3.paid_to_date) === 1000000 && ord3.payment_status === 'PAID', `${ord3.paid_to_date} ${ord3.payment_status}`);
  const nums = (await prisma.receipt.findMany({ where: { invoice: { order_id: o3.id } }, select: { customer_seq: true } })).map((r) => r.customer_seq).sort();
  check('G12 kwitansi numbers have no gap', nums.length === 2 && nums[1] - nums[0] === 1, nums.join(','));
  const inv3 = await prisma.invoice.findUnique({ where: { id: i1.data.id }, include: { receipts: true } });
  check('G13 kwitansi PDF attached after payment (invoice + receipt)', !!inv3.receipt_url && inv3.receipts.every((r) => !!r.file_url));
  // Pay and revise the same invoice at the same moment: exactly one wins.
  const o4 = await makeOrder('G14');
  const i4 = await invoice(o4.id, 'DP', 200_000);
  const [pay4, rev4] = await Promise.all([
    markPaid(o4.id, i4.data.id),
    call('POST', `/orders/${o4.id}/invoice/${i4.data.id}/revise`, { token: admin, body: { amount: 300_000 } }),
  ]);
  const st4 = (await prisma.invoice.findUnique({ where: { id: i4.data.id } })).status;
  const rc4 = await prisma.receipt.count({ where: { invoice_id: i4.data.id } });
  const ok4 = (st4 === 'PAID' && rc4 === 1 && rev4.status === 409) || (st4 === 'REVISED' && rc4 === 0 && pay4.status === 409);
  check('G14 pay + revise at once: one wins, no payment on a revised invoice', ok4, `invoice ${st4}, receipts ${rc4}, pay ${pay4.status}, revise ${rev4.status}`);
  // Money on an invoice voided by a cancellation still counts. The day was
  // yesterday (tier 3, fee 100%), so the DP does not cover the fee.
  const o5 = await makeOrder('G15', { startDay: -1 });
  await payDp(o5, 200_000);
  const c5 = await call('POST', `/orders/${o5.id}/cancel`, { token: admin, body: { reason: 'batal' } });
  const fee = (await order(o5.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  check('G15a [A6] fee invoice asks only for the rest (fee 1.000.000 − DP 200.000)', c5.status === 200 && c5.data.tier === 3 && Number(fee?.amount) === 800000, `${JSON.stringify(c5.data ?? c5.json)} ${fee?.amount}`);
  await markPaid(o5.id, fee.id, { amount_received: 50_000, amount_mismatch_ack: true });
  const ord5 = await order(o5.id);
  check('G15 paid_to_date keeps the DP of a cancelled order (200.000 + 50.000)', c5.status === 200 && Number(ord5.paid_to_date) === 250000, String(ord5.paid_to_date));
  const stmt = await call('POST', `/orders/${o5.id}/statement`, { token: admin, body: {} });
  check('G16 statement counts the same money (250.000)', stmt.status === 200 && Number(stmt.data.total_received) === 250000, JSON.stringify(stmt.data ?? stmt.json).slice(0, 120));
  const o6 = await makeOrder('G17');
  const i6 = await invoice(o6.id, 'DP', 200_000);
  check('G17 invalid paid_at refused (400), nothing recorded', (await markPaid(o6.id, i6.data.id, { paid_at: '03/10/2026 abc' })).status === 400 && (await prisma.receipt.count({ where: { invoice_id: i6.data.id } })) === 0);
  // Two payments that together make the order paid in full: one "lunas" push.
  const o7 = await makeOrder('G18', { startDay: 1 });
  await payDp(o7, 200_000);
  await putLine(o7.service_items[0].id, { is_external: false, driver_id: d3.id, line_status: 'ASSIGNED' });
  const s7a = await invoice(o7.id, 'SETTLEMENT', 400_000);
  const s7b = await invoice(o7.id, 'SETTLEMENT', 400_000);
  await Promise.all([markPaid(o7.id, s7a.data.id), markPaid(o7.id, s7b.data.id)]);
  await sleep(800);
  const code7 = (await order(o7.id)).order_code;
  const lunas = (await pushesTo(d3)).filter((x) => x.title.includes(code7) && /sudah lunas/.test(x.title));
  check('G18 two payments completing the order at once: one "sudah lunas" push', lunas.length === 1, `pushes ${lunas.length}`);
  // Revising keeps the customer's total_billed = sum of active invoices.
  const o8 = await makeOrder('G19');
  const i8 = await invoice(o8.id, 'DP', 200_000);
  await call('POST', `/orders/${o8.id}/invoice/${i8.data.id}/revise`, { token: admin, body: { amount: 250_000 } });
  check('G19 revision moves total_billed with the new amount (250.000)', Number((await prisma.customer.findUnique({ where: { id: o8.customer_id } })).total_billed) === 250000);
  // Payment recorded without paid_to_date (sheet import) keeps its status.
  const o9 = await makeOrder('G20');
  await prisma.order.update({ where: { id: o9.id }, data: { payment_status: 'PAID' } });
  await putLine(o9.service_items[0].id, { is_external: false, notes: 'catatan' });
  check('G20 imported "paid" order without paid_to_date stays PAID after a day edit', (await order(o9.id)).payment_status === 'PAID');
  // Money refunded no longer counts: a charge after a refund is owed again.
  await call('POST', `/orders/${o2.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'OT', amount: 100000 } }).catch(() => null);
  const o2b = await order(o2.id);
  check('G21 after a 100.000 refund, a 100.000 charge makes the order DP_PAID again', Number(o2b.final_price) === 1100000 && o2b.payment_status === 'DP_PAID', `${o2b.final_price} ${o2b.payment_status}`);
});

// ── H. Website leads ───────────────────────────────────────────────────────
await section('H. Website leads', async () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = () => `ARS-${Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
  const c1 = code();
  const lead = { lead_code: c1, name: `Lead ${tag}`, trip_date: '2026-10-20', pickup_time: '08:00', pickup_location: 'Bogor', destination: 'Bandung', unit: 'Innova Reborn', passenger_count: 5, duration_key: 'return' };
  const post = (body) => fetch(`${BASE}/public/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://arasya-web.vercel.app' }, body: JSON.stringify(body) });
  const r1 = await post(lead);
  const r2 = await post(lead);
  check('H1 public lead → 204, resend stored once', r1.status === 204 && r2.status === 204 && (await prisma.webLead.count({ where: { lead_code: c1 } })) === 1);
  check('H2 allowed origin gets the CORS header', r1.headers.get('access-control-allow-origin') === 'https://arasya-web.vercel.app');
  check('H3 invalid lead still answers 204', (await post({ ...lead, lead_code: 'XX-1' })).status === 204);
  const c2 = code();
  await post({ ...lead, lead_code: c2, website: 'http://spam' });
  check('H4 honeypot filled → not stored', (await prisma.webLead.count({ where: { lead_code: c2 } })) === 0);
  const c3 = code();
  const beacon = await fetch(`${BASE}/public/leads`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...lead, lead_code: c3 }) });
  check('H5 text/plain (sendBeacon) body accepted', beacon.status === 204 && (await prisma.webLead.count({ where: { lead_code: c3 } })) === 1);
  const L = await prisma.webLead.findUnique({ where: { lead_code: c1 } });
  const o = await makeOrder('H', { extra: { web_lead_id: L.id } });
  check('H6 order from a lead uses the lead code', o.order_code === c1, o.order_code);
  check('H7 lead CONVERTED', (await prisma.webLead.findUnique({ where: { id: L.id } })).status === 'CONVERTED');
  check('H8 ignoring a converted lead refused (409)', (await call('POST', `/leads/${L.id}/ignore`, { token: admin, body: {} })).status === 409);
  const again = await makeOrder('H9', { extra: { web_lead_id: L.id } }).catch((e) => e);
  check('H9 second order from the same lead refused', again instanceof Error && / 409 /.test(again.message));
});

// ── I. Partner days ────────────────────────────────────────────────────────
await section('I. Partner (rekanan) days', async () => {
  const o = await makeOrder('I');
  const v = await call('POST', '/external-vendors', { token: admin, body: { name: `Vendor ${tag}`, phone: '081200000000' } });
  const lineId = o.service_items[0].id;
  const r = await putLine(lineId, { is_external: true, external_vendor_id: v.data.id, driver_name_raw: 'Pak Budi', driver_phone_raw: '0812999', plate_raw: 'b 1234 xy', rtr_amount: 600000, line_status: 'ASSIGNED' });
  check('I1 partner day on an UNPAID order allowed', r.status === 200);
  check('I2 plate upper-cased, VENDOR payable', r.data?.plate_raw === 'B 1234 XY' && (await prisma.payable.findUnique({ where: { service_item_id: lineId } }))?.kind === 'VENDOR');
  const conf = await call('POST', `/schedule/lines/${lineId}/send-confirmation`, { token: admin, body: {} });
  check('I3 confirmation (manual mode) returns a wa.me link', conf.status === 200 && /^https:\/\/wa\.me\/62/.test(conf.data.customer.wa_url ?? ''));
  const again = await call('POST', `/schedule/lines/${lineId}/send-confirmation`, { token: admin, body: {} });
  const forced = await call('POST', `/schedule/lines/${lineId}/send-confirmation`, { token: admin, body: { force: true } });
  check('I4 sending again without change refused (409); force allowed', again.status === 409 && forced.status === 200);
  const cur = await order(o.id);
  const edit = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(cur, { notes: 'catatan' }) });
  const after = (await order(o.id)).service_items[0];
  check('I5 Edit Order keeps the partner day (vendor, driver, plate)', edit.status === 200 && after.is_external && after.external_vendor_id === v.data.id && after.plate_raw === 'B 1234 XY');
  // An order made for a partner: editing it creates no empty vendor payables,
  // and an untouched partner day can still be removed.
  const po = await makeOrder('I6', { days: 2, extra: { is_external: true, external_vendor_id: v.data.id } });
  const pe = await call('PUT', `/orders/${po.id}`, { token: admin, body: editBody(po, { notes: 'catatan' }) });
  check('I6 Edit Order on a partner order creates no 0-rupiah vendor payables', pe.status === 200 && (await prisma.payable.count({ where: { order_id: po.id } })) === 0);
  const pr = await call('PUT', `/orders/${po.id}`, { token: admin, body: editBody(po, { reason: 'kurangi hari', days: [{ id: po.service_items[0].id }] }) });
  check('I7 an untouched partner day can be removed', pr.status === 200 && (await order(po.id)).service_items.length === 1, pr.json?.message);
});

// ── J. Phone clock, stale trips, packages, same-day cancel ─────────────────
await section('J. Phone clock, stale trips, packages, cancel on day H', async () => {
  const o = await makeOrder('J', { startDay: 0, pkg: 'XOPS' });
  await payFull(o);
  const lineId = o.service_items[0].id;
  await putLine(lineId, { is_external: false, driver_id: d3.id, car_id: car5.id, line_status: 'ASSIGNED' });
  const s = await act(d3, lineId, 'start', { occurred_at: new Date(Date.now() + 5 * 3600e3).toISOString() });
  check('J1 future phone time clamped to server now', Math.abs(new Date(s.data.actual_start_at).getTime() - Date.now()) < 60e3);
  const a = await act(d3, lineId, 'arrive', { occurred_at: new Date(Date.now() - 30 * 86400e3).toISOString() });
  const age = (Date.now() - new Date(a.data.actual_pickup_at).getTime()) / 86400e3;
  check('J2 phone time 30 days old clamped to 7 days', age > 6.9 && age < 7.1, age.toFixed(2));
  await report(d3, lineId, { report_type: 'FUEL', amount: 300000 });
  const e = await prisma.expense.findFirst({ where: { order_service_item_id: lineId } });
  check('J3 XOPS: fuel billed to the customer', e.bill_to_customer === true);
  await call('PATCH', `/lines/expenses/${e.id}`, { token: admin, body: { status: 'APPROVED' } });
  const oa = await order(o.id);
  check('J4 approved XOPS fuel → billable charge, final_price 1.300.000', oa.adjustments.some((x) => x.created_by === 'Biaya perjalanan') && Number(oa.final_price) === 1300000);
  check('J5 billed charge raises the total: payment_status back to DP_PAID, trip stays unlocked', oa.payment_status === 'DP_PAID' && oa.start_payment.ready === true, oa.payment_status);
  const edit = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(oa, { notes: 'x' }) });
  check('J5b Edit Order with charges: no reason needed, total stays 1.300.000', edit.status === 200 && Number((await order(o.id)).final_price) === 1300000, `${edit.status} ${edit.json?.message ?? ''}`);
  check('J6 deleting a driver receipt refused (409)', (await call('DELETE', `/lines/expenses/${e.id}`, { token: admin })).status === 409);
  const wibHour = new Date(Date.now() + 7 * 3600e3).getUTCHours();
  const c = await call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'tes hari H' } });
  check('J7 cancel on day H after a departure → tier 3 (100%)', c.data?.tier === 3, `WIB hour ${wibHour}, ${JSON.stringify(c.data)}`);
  const jFee = (await order(o.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  check('J7b [A6] fee 1.300.000 − 1.000.000 already paid: invoice for 300.000', c.data?.stillOwed === 300000 && Number(jFee?.amount) === 300000, `${c.data?.stillOwed} / ${jFee?.amount}`);
  // J12 (B12, owner Q1 7 Oct 2026): "before 10:00" is strictly before
  // 10:00:00.000 WIB. J7 runs on the real clock, so the boundary is checked
  // on the rule itself (dist, no database).
  const { computeCancellationPenalty } = createRequire(import.meta.url)('../../dist/src/modules/orders/cancellation-policy.js');
  const tierAt = (iso, started = false) =>
    computeCancellationPenalty({ finalPrice: 1_000_000, firstServiceDate: new Date('2026-10-10T00:00:00+07:00'), anyLineStarted: started, now: new Date(iso) });
  const tiers12 = [
    tierAt('2026-10-10T09:59:59.999+07:00'), tierAt('2026-10-10T10:00:00.000+07:00'), tierAt('2026-10-10T10:00:59+07:00'),
    tierAt('2026-10-10T08:00:00+07:00', true), tierAt('2026-10-09T23:59:59+07:00'), tierAt('2026-10-11T08:00:00+07:00'),
  ];
  check('J12 [B12] day H 09:59:59.999 WIB → tier 2 (50%); 10:00:00.000 and 10:00:59 → tier 3 (100%); started → 3; the day before → 1; after day H → 3',
    tiers12.map((t) => t.tier).join() === '2,3,3,3,1,3' && tiers12[0].penalty === 500000 && tiers12[1].penalty === 1000000,
    tiers12.map((t) => `${t.tier}/${t.penalty}`).join(' '));
  const line = (await order(o.id)).service_items[0];
  check('J8 started day keeps its driver and fee after cancel', line.driver_id === d3.id && Number(line.driver_fee) === 200000);
  const o3 = await makeOrder('J9', { startDay: -3 });
  await payFull(o3);
  await putLine(o3.service_items[0].id, { is_external: false, driver_id: d2.id, line_status: 'ASSIGNED' });
  check('J9 trip older than yesterday hidden from the app', !(await call('GET', '/driver/trips?scope=active', { token: d2.token })).data.some((t) => t.id === o3.service_items[0].id));
  check('J10 listed under "Belum ditutup" (overdue=true)', (await call('GET', '/schedule?overdue=true&page_size=200', { token: admin })).json.items.some((l) => l.id === o3.service_items[0].id));
  check('J11 the driver can still open it by link', (await call('GET', `/driver/trips/${o3.service_items[0].id}`, { token: d2.token })).status === 200);
});

// ── K. Validation edges ────────────────────────────────────────────────────
await section('K. Validation edges', async () => {
  const o = await makeOrder('K', { startDay: 2 });
  await payDp(o, 200_000);
  const lineId = o.service_items[0].id;
  await putLine(lineId, { is_external: false, driver_id: d2.id, car_id: car2.id, line_status: 'ASSIGNED' });
  check('K1 latitude without longitude refused (400)', (await call('POST', `/driver/trips/${lineId}/arrive`, { token: d2.token, body: { latitude: -6.5 } })).status === 400);
  const gif = new FormData();
  gif.append('client_ref', uuid());
  gif.append('report_type', 'PHOTO');
  gif.append('photo', new Blob(['x'], { type: 'image/gif' }), 'a.gif');
  check('K2 GIF photo refused (415)', (await call('POST', `/driver/trips/${lineId}/reports`, { token: d2.token, form: gif })).status === 415);
  const big = new FormData();
  big.append('client_ref', uuid());
  big.append('report_type', 'PHOTO');
  big.append('photo', new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: 'image/jpeg' }), 'big.jpg');
  check('K3 photo over 10 MB refused (413)', (await call('POST', `/driver/trips/${lineId}/reports`, { token: d2.token, form: big })).status === 413);
  const ref = uuid();
  const n1 = new FormData();
  n1.append('client_ref', ref);
  n1.append('report_type', 'NOTE');
  n1.append('notes', 'a');
  await call('POST', `/driver/trips/${lineId}/reports`, { token: d2.token, form: n1 });
  const o2 = await makeOrder('K4', { startDay: 5 });
  await payDp(o2, 200_000);
  await putLine(o2.service_items[0].id, { is_external: false, driver_id: d2.id, line_status: 'ASSIGNED' });
  const n2 = new FormData();
  n2.append('client_ref', ref);
  n2.append('report_type', 'NOTE');
  n2.append('notes', 'b');
  check('K4 client_ref reused on another trip refused (409)', (await call('POST', `/driver/trips/${o2.service_items[0].id}/reports`, { token: d2.token, form: n2 })).status === 409);
  check('K5 invalid Expo push token refused (400)', (await call('POST', '/devices', { token: d2.token, body: { token: 'abc', platform: 'android' } })).status === 400);
  check('K6 unassigning a driver allowed', (await putLine(lineId, { is_external: false, driver_id: null, car_id: null, line_status: 'SCHEDULED' })).status === 200);
  check('K7 unpaid payable removed with the driver', (await prisma.payable.findUnique({ where: { service_item_id: lineId } })) === null);
  check('K8 removed driver gets 404 on that trip', (await call('GET', `/driver/trips/${lineId}`, { token: d2.token })).status === 404);
});

// ── L. Admin notifications, e-toll requests, location names (F1, F4–F6) ────
await section('L. Admin notifications, driver requests, location names', async () => {
  const d4 = await makeDriver(6, { etoll_card: 'Mandiri 6032 ••••1234' });
  const me = async () => (await call('GET', '/driver/me', { token: d4.token })).data;
  check('L1 driver created with etoll_card; /driver/me returns it', (await me())?.etoll_card === 'Mandiri 6032 ••••1234');
  const upd = await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { etoll_card: 'BCA Flazz ••••9876' } });
  const listed = (await call('GET', '/drivers', { token: admin })).data.find((x) => x.id === d4.id);
  check('L2 admin edits etoll_card (update, list, /driver/me)', upd.status === 200 && listed?.etoll_card === 'BCA Flazz ••••9876' && (await me()).etoll_card === 'BCA Flazz ••••9876');
  check('L3 etoll_card over 60 characters refused (400)', (await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { etoll_card: 'x'.repeat(61) } })).status === 400);
  await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { etoll_card: '' } });
  check('L4 empty etoll_card clears it', (await me()).etoll_card === null);
  await call('PUT', `/drivers/${d4.id}`, { token: admin, body: { etoll_card: 'Mandiri ••••1234' } });

  // Each driver action notifies the admins once; resends add nothing.
  const o = await makeOrder('L', { startDay: 0 });
  await payFull(o);
  const lineId = o.service_items[0].id;
  const car6 = await makeCar('Brio');
  const asg = await putLine(lineId, { is_external: false, driver_id: d4.id, car_id: car6.id, line_status: 'ASSIGNED' });
  if (asg.status !== 200) throw new Error(`assign: ${asg.status} ${asg.json?.message}`);
  const notes = (type) => prisma.adminNotification.findMany({ where: { service_item_id: lineId, type } });
  const n = async (type) => (await notes(type)).length;
  await act(d4, lineId, 'accept');
  await act(d4, lineId, 'accept');
  check('L5 accept twice → one TRIP_ACCEPTED', (await n('TRIP_ACCEPTED')) === 1);
  const sref = uuid();
  await act(d4, lineId, 'start', { client_ref: sref });
  await act(d4, lineId, 'start', { client_ref: sref });
  await act(d4, lineId, 'start');
  const started = await notes('TRIP_STARTED');
  check('L6 start, resend, second start → one TRIP_STARTED linked to the order', started.length === 1 && started[0].link === `/dashboard/orders/${o.id}` && started[0].order_code === o.order_code && started[0].driver_id === d4.id && started[0].title.includes(`Driver 6 ${tag}`), started[0]?.title);
  const loc = { latitude: -6.5971, longitude: 106.806, location_accuracy_m: 9, location_mocked: false, location_name: 'Jl. Pajajaran, Bogor' };
  check('L7 location_name over 200 characters refused (400)', (await act(d4, lineId, 'arrive', { ...loc, location_name: 'x'.repeat(201) })).status === 400);
  const aref = uuid();
  const a1 = await act(d4, lineId, 'arrive', { client_ref: aref, ...loc });
  await act(d4, lineId, 'arrive', { client_ref: aref, ...loc });
  const arrived = await notes('TRIP_ARRIVED');
  check('L8 arrive + resend → one TRIP_ARRIVED with the place name', a1.status === 200 && arrived.length === 1 && /sampai di lokasi jemput/.test(arrived[0].title) && arrived[0].body.includes('Jl. Pajajaran, Bogor') && arrived[0].body.startsWith(o.order_code), arrived[0]?.body);
  const arow = await prisma.tripReport.findFirst({ where: { order_service_item_id: lineId, report_type: 'ARRIVE_CUSTOMER' } });
  check('L9 arrive stores location_name with the GPS fix', arow?.location_name === 'Jl. Pajajaran, Bogor' && arow.latitude === -6.5971);
  const bref = uuid();
  await act(d4, lineId, 'board', { client_ref: bref });
  await act(d4, lineId, 'board', { client_ref: bref });
  check('L10 board + resend → one TRIP_BOARDED', (await n('TRIP_BOARDED')) === 1);
  const photo = { client_ref: uuid(), report_type: 'PHOTO', notes: 'Checkpoint 1', stamped: 'true', latitude: -6.6, longitude: 106.81, location_accuracy_m: 15, location_name: 'Tol Jagorawi KM 30' };
  const p1 = await report(d4, lineId, photo);
  const p2 = await report(d4, lineId, photo);
  const reps = await notes('TRIP_REPORT');
  check('L11 checkpoint photo + resend → one TRIP_REPORT', p1.status === 200 && p2.status === 200 && reps.length === 1 && /mengirim foto/.test(reps[0].title) && reps[0].body.includes('Checkpoint 1'), reps.map((r) => r.title).join(' | '));
  const prow = await prisma.tripReport.findUnique({ where: { client_ref: photo.client_ref } });
  check('L12 report stores GPS + location_name and returns it', prow?.location_name === 'Tol Jagorawi KM 30' && prow.latitude === -6.6 && p1.data?.location_name === 'Tol Jagorawi KM 30' && p2.data?.location_name === 'Tol Jagorawi KM 30');
  const toll = { client_ref: uuid(), report_type: 'TOLL', amount: 45000, notes: 'Tol Jagorawi' };
  await report(d4, lineId, toll);
  await report(d4, lineId, toll);
  const costs = await notes('TRIP_COST');
  const exp = await prisma.expense.findFirst({ where: { order_service_item_id: lineId, type: 'TOLL' } });
  check('L13 toll receipt + resend → one TRIP_COST "Tol Rp 45.000 — perlu ditinjau"', costs.length === 1 && costs[0].title.includes('Tol Rp 45.000') && costs[0].title.includes('perlu ditinjau') && costs[0].expense_id === exp?.id && costs[0].link === `/dashboard/orders/${o.id}`, costs[0]?.title);
  check('L14 a cost is not also a TRIP_REPORT', (await n('TRIP_REPORT')) === 1);
  const fref = uuid();
  await act(d4, lineId, 'finish', { client_ref: fref });
  await act(d4, lineId, 'finish', { client_ref: fref });
  await act(d4, lineId, 'finish');
  check('L15 finish + resends → one TRIP_FINISHED', (await n('TRIP_FINISHED')) === 1);
  check('L16 seven notifications for the trip in all', (await prisma.adminNotification.count({ where: { service_item_id: lineId } })) === 7);

  // location_name wherever the coordinates are returned.
  const trip = (await call('GET', `/driver/trips/${lineId}`, { token: d4.token })).data;
  check('L17 driver trip detail returns location_name', trip.reports.some((r) => r.report_type === 'ARRIVE_CUSTOMER' && r.location_name === 'Jl. Pajajaran, Bogor') && trip.reports.some((r) => r.report_type === 'PHOTO' && r.location_name === 'Tol Jagorawi KM 30'));
  check('L18 admin order view returns location_name', (await order(o.id)).service_items[0].reports.some((r) => r.location_name === 'Jl. Pajajaran, Bogor'));
  const hist = await call('GET', `/schedule/history?driver_id=${d4.id}&page_size=200`, { token: admin });
  check('L19 trip history (schedule) returns location_name', hist.json?.items?.find((l) => l.id === lineId)?.reports?.some((r) => r.location_name === 'Jl. Pajajaran, Bogor'));

  // Feed + per-admin read state.
  const u2 = await call('POST', '/users', { token: admin, body: { email: `admin2-${tag}@e2e.local`, password: 'secret123', role: 'ADMIN' } });
  const admin2 = (await call('POST', '/auth/login', { body: { email: `admin2-${tag}@e2e.local`, password: 'secret123' } })).data?.token;
  const feed = await call('GET', '/notifications?limit=100', { token: admin });
  const mine = feed.data?.items?.filter((x) => x.service_item_id === lineId) ?? [];
  const keys = ['id', 'type', 'title', 'body', 'order_id', 'order_code', 'service_item_id', 'driver_id', 'driver_request_id', 'expense_id', 'link', 'created_at', 'read'];
  check('L20 GET /notifications lists them newest first with the contract fields', feed.status === 200 && mine.length === 7 && mine[0].type === 'TRIP_FINISHED' && keys.every((k) => k in mine[0]) && mine.every((x) => x.read === false) && typeof feed.data.unread_count === 'number', `${feed.status} ${mine.length}`);
  check('L21 driver token cannot read the admin feed (403)', (await call('GET', '/notifications', { token: d4.token })).status === 403);
  const c1 = (await call('GET', '/notifications/unread-count', { token: admin })).data;
  const c2 = (await call('GET', '/notifications/unread-count', { token: admin2 })).data;
  const newest = await prisma.adminNotification.findFirst({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
  check('L22 unread-count gives the count and the newest notification', u2.status === 201 && c1.unread_count >= 7 && c1.latest_id === newest.id && new Date(c1.latest_at).getTime() === newest.created_at.getTime() && c2.unread_count === c1.unread_count, JSON.stringify(c1));
  const r1 = await call('POST', '/notifications/read', { token: admin, body: { ids: [mine[0].id] } });
  await call('POST', '/notifications/read', { token: admin, body: { ids: [mine[0].id] } });
  check('L23 reading one: unread_count − 1 for that admin only (re-read is a no-op)', r1.data?.unread_count === c1.unread_count - 1 && (await call('GET', '/notifications/unread-count', { token: admin })).data.unread_count === c1.unread_count - 1 && (await call('GET', '/notifications/unread-count', { token: admin2 })).data.unread_count === c2.unread_count);
  const f1 = (await call('GET', '/notifications?limit=100', { token: admin })).data.items.find((x) => x.id === mine[0].id);
  const f2 = (await call('GET', '/notifications?limit=100', { token: admin2 })).data.items.find((x) => x.id === mine[0].id);
  const unreadOnly = (await call('GET', '/notifications?limit=100&unread=1', { token: admin })).data.items;
  check('L24 read flag is per admin; unread=1 hides read ones', f1?.read === true && f2?.read === false && !unreadOnly.some((x) => x.id === mine[0].id) && unreadOnly.some((x) => x.id === mine[1].id));
  const older = (await call('GET', `/notifications?limit=2&before=${encodeURIComponent(mine[1].created_at)}`, { token: admin })).data.items;
  check('L25 before= pages to older ones', older.length > 0 && older.every((x) => new Date(x.created_at) < new Date(mine[1].created_at)));
  check('L26 read without ids or all refused (400)', (await call('POST', '/notifications/read', { token: admin, body: {} })).status === 400);
  const all = await call('POST', '/notifications/read', { token: admin, body: { all: true } });
  check('L27 read all → 0 for that admin, the other admin unchanged', all.data?.unread_count === 0 && (await call('GET', '/notifications/unread-count', { token: admin2 })).data.unread_count === c2.unread_count);

  // E-toll top-up request (F5).
  const before = await prisma.adminNotification.count({ where: { type: 'DRIVER_REQUEST', driver_id: d4.id } });
  const ref1 = uuid();
  const body = { type: 'ETOLL_TOPUP', balance: 12000, note: 'Saldo tinggal sedikit', client_ref: ref1, occurred_at: new Date().toISOString() };
  const q1 = await call('POST', '/driver/requests', { token: d4.token, body });
  const reqNotes = () => prisma.adminNotification.findMany({ where: { type: 'DRIVER_REQUEST', driver_id: d4.id } });
  const rn = await reqNotes();
  check('L28 e-toll request → 201 OPEN, card from the driver profile', q1.status === 201 && q1.data?.request?.status === 'OPEN' && q1.data.request.card_label === 'Mandiri ••••1234' && q1.data.request.balance === 12000, JSON.stringify(q1.json));
  check('L29 admins notified "minta top-up e-toll" with card and balance', rn.length === before + 1 && /minta top-up e-toll/.test(rn[0]?.title) && rn[0].body.includes('Kartu Mandiri ••••1234') && rn[0].body.includes('saldo Rp 12.000') && rn[0].driver_request_id === q1.data.request.id, rn[0]?.body);
  const q2 = await call('POST', '/driver/requests', { token: d4.token, body });
  check('L30 same client_ref → 200, same request, no new notification', q2.status === 200 && q2.data?.request?.id === q1.data.request.id && !q2.data.already_open && (await reqNotes()).length === before + 1);
  const q3 = await call('POST', '/driver/requests', { token: d4.token, body: { ...body, client_ref: uuid() } });
  check('L31 another while one is open → 200 already_open, no new notification', q3.status === 200 && q3.data?.already_open === true && q3.data.request.id === q1.data.request.id && (await reqNotes()).length === before + 1);
  check('L32 another driver cannot reuse the client_ref (409)', (await call('POST', '/driver/requests', { token: d3.token, body })).status === 409);
  check('L33 unknown request type refused (400)', (await call('POST', '/driver/requests', { token: d4.token, body: { ...body, type: 'FUEL', client_ref: uuid() } })).status === 400);
  const own = await call('GET', '/driver/requests?status=open', { token: d4.token });
  check('L34 driver lists own open requests', own.status === 200 && own.data.items.length === 1 && own.data.items[0].id === q1.data.request.id);
  const adm = await call('GET', '/driver-requests?status=OPEN', { token: admin });
  const row = adm.data?.items?.find((x) => x.id === q1.data.request.id);
  check('L35 admin list shows it with driver id/name/phone only', !!row && Object.keys(row.driver).sort().join() === 'id,name,phone' && row.driver.id === d4.id);
  check('L36 driver token cannot use the admin list (403)', (await call('GET', '/driver-requests', { token: d4.token })).status === 403);
  const done = await call('POST', `/driver-requests/${q1.data.request.id}/done`, { token: admin, body: { note: 'Sudah diisi Rp 100.000' } });
  await sleep(300);
  const topupPush = (await pushesTo(d4)).filter((x) => x.title === 'Top-up e-toll sudah diproses');
  const inbox = await call('GET', '/driver/notifications', { token: d4.token });
  check('L37 admin marks done → DONE, driver gets one push + inbox row', done.status === 200 && done.data?.request?.status === 'DONE' && !!done.data.request.handled_at && done.data.request.handled_note === 'Sudah diisi Rp 100.000' && topupPush.length === 1 && topupPush[0].body.includes('Sudah diisi Rp 100.000') && inbox.data.items.some((x) => x.type === 'driver_request_done'), `${done.status} pushes ${topupPush.length}`);
  const again = await call('POST', `/driver-requests/${q1.data.request.id}/done`, { token: admin2, body: {} });
  check('L38 second "done" refused (409), no second push', again.status === 409 && (await pushesTo(d4)).filter((x) => x.title === 'Top-up e-toll sudah diproses').length === 1, `${again.status}`);
  check('L39 unknown request id → 404', (await call('POST', `/driver-requests/${uuid()}/done`, { token: admin, body: {} })).status === 404);
  const q4 = await call('POST', '/driver/requests', { token: d4.token, body: { type: 'ETOLL_TOPUP', card_label: 'BRIZZI ••••5555', client_ref: uuid() } });
  check('L40 after done a new request is accepted (201) and notifies', q4.status === 201 && q4.data.request.id !== q1.data.request.id && q4.data.request.card_label === 'BRIZZI ••••5555' && (await reqNotes()).length === before + 2);
  const allOwn = await call('GET', '/driver/requests?status=all', { token: d4.token });
  check('L41 driver list (all) newest first', allOwn.data.items.length === 2 && allOwn.data.items[0].id === q4.data.request.id && allOwn.data.items[1].status === 'DONE');
  const doneList = await call('GET', '/driver-requests?status=done', { token: admin });
  check('L42 admin list by status DONE', doneList.data.items.some((x) => x.id === q1.data.request.id) && !doneList.data.items.some((x) => x.id === q4.data.request.id));

  // A checkpoint photo the phone did not stamp gets the server stamp (dark
  // caption band at the bottom), like the arrival photo; stamped=true and
  // receipts are stored as taken. A plain white JPEG shows the difference.
  const { Jimp } = await import('jimp');
  const plain = await new Jimp({ width: 320, height: 240, color: 0xffffffff }).getBuffer('image/jpeg');
  const upload = async (fields) => {
    const f = new FormData();
    f.append('client_ref', uuid());
    for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
    f.append('photo', new Blob([plain], { type: 'image/jpeg' }), 'c.jpg');
    const r = await call('POST', `/driver/trips/${lineId}/reports`, { token: d4.token, form: f });
    const key = decodeURIComponent(new URL(r.data.file_url).pathname.replace(/^.*\/object\/public\//, ''));
    const img = await Jimp.read(Buffer.from(await (await fetch(`${MOCK}/__object?key=${encodeURIComponent(key)}`)).arrayBuffer()));
    return { status: r.status, bottom: (img.getPixelColor(2, img.bitmap.height - 2) >>> 24) & 0xff };
  };
  const gps = { latitude: -6.61, longitude: 106.82, location_accuracy_m: 10, location_name: 'Tol Jagorawi KM 35' };
  const unstamped = await upload({ report_type: 'PHOTO', notes: 'Checkpoint 2', ...gps });
  const phoneStamped = await upload({ report_type: 'PHOTO', notes: 'Checkpoint 3', stamped: 'true', ...gps });
  const receipt = await upload({ report_type: 'PARKING', amount: 5000 });
  check('L43 checkpoint photo without the phone stamp gets the server stamp; stamped=true and receipts stored as taken', unstamped.status === 200 && unstamped.bottom < 128 && phoneStamped.status === 200 && phoneStamped.bottom > 200 && receipt.status === 200 && receipt.bottom > 200, JSON.stringify({ unstamped, phoneStamped, receipt }));
});

// ── M. Trip costs billed to the customer vs money owed to the driver (F3) ──
// Rule: "Dibayar oleh" decides whether the driver is owed (DRIVER = own money
// or uang jalan, reimbursed through the payable; COMPANY = e-toll/company
// card, nothing owed). "Ditagih ke pelanggan" decides who finally bears the
// cost (Invoice Tambahan, pass-through: no effect on the margin).
await section('M. Trip costs: billed to the customer vs owed to the driver', async () => {
  const d4 = await makeDriver(5);
  // An old order date, so the order can be picked out alone in /analytics/dashboard.
  const orderDate = new Date('2021-03-10T10:00:00+07:00').toISOString();
  const o = await makeOrder('M', { startDay: 0, extra: { order_date: orderDate } });
  await payDp(o, 300_000);
  const lineId = o.service_items[0].id;
  await putLine(lineId, { is_external: false, driver_id: d4.id, line_status: 'ASSIGNED', driver_fee: 200000, travel_advance: 100000 });
  const money = async () => {
    const [ord, line, pay, fin] = await Promise.all([
      order(o.id),
      prisma.orderServiceItem.findUnique({ where: { id: lineId } }),
      prisma.payable.findUnique({ where: { service_item_id: lineId } }),
      prisma.orderFinalFinance.findUnique({ where: { order_id: o.id } }),
    ]);
    return {
      total: Number(ord.final_price), charges: ord.adjustments.filter((a) => a.is_billable).length,
      reimburse: Number(pay.reimburse_amount), owed: Number(pay.total_amount),
      ops: Number(line.ops_cost), margin: Number(fin.margin_amount),
    };
  };
  const show = (m) => `total ${m.total}, owed ${m.owed} (reimburse ${m.reimburse}), ops ${m.ops}, margin ${m.margin}`;
  const cost = async (type, amount, review) => {
    await report(d4, lineId, { report_type: type, amount });
    const e = await prisma.expense.findFirst({ where: { order_service_item_id: lineId, type } });
    const r = await call('PATCH', `/lines/expenses/${e.id}`, { token: admin, body: { status: 'APPROVED', ...review } });
    if (r.status !== 200) throw new Error(`approve ${type}: ${r.status} ${JSON.stringify(r.json)}`);
    return e;
  };
  let m = await money();
  check('M1 before costs: owed = fee 200.000 − uang jalan 100.000', m.owed === 100000 && m.total === 1000000 && m.margin === 800000, show(m));

  // The driver paid parking (own money / uang jalan); the customer pays it back.
  const parking = await cost('PARKING', 50000, { bill_to_customer: true });
  m = await money();
  check('M2 driver-paid parking billed to the customer: on the invoice (1.050.000) and reimbursed (owed 150.000), margin unchanged',
    m.total === 1050000 && m.reimburse === 50000 && m.owed === 150000 && m.ops === 0 && m.margin === 800000, show(m));

  // Toll paid with the company e-toll card, billed to the customer: nothing owed to the driver.
  await cost('TOLL', 40000, { paid_by: 'COMPANY', bill_to_customer: true });
  m = await money();
  check('M3 company-paid toll billed to the customer: not owed to the driver (owed stays 150.000)',
    m.total === 1090000 && m.owed === 150000 && m.margin === 800000, show(m));

  // Fuel the driver paid and Arasya bears: reimbursed and a cost.
  await cost('FUEL', 30000, {});
  m = await money();
  check('M4 driver-paid fuel Arasya bears: reimbursed (owed 180.000), margin −30.000',
    m.total === 1090000 && m.owed === 180000 && m.ops === 30000 && m.margin === 770000, show(m));

  // Unticking "Ditagih ke pelanggan" moves the cost from the customer to Arasya;
  // the driver who paid it is still owed it.
  await call('PATCH', `/lines/expenses/${parking.id}`, { token: admin, body: { bill_to_customer: false } });
  m = await money();
  check('M5 parking no longer billed: off the invoice, still reimbursed, margin −50.000',
    m.total === 1040000 && m.owed === 180000 && m.ops === 80000 && m.margin === 720000, show(m));
  await call('PATCH', `/lines/expenses/${parking.id}`, { token: admin, body: { bill_to_customer: true } });
  m = await money();
  check('M6 billed again: one invoice line per cost, owed unchanged', m.total === 1090000 && m.charges === 2 && m.owed === 180000 && m.margin === 770000, show(m));

  // Admin "Biaya Tambahan" (overtime) is income from the customer only.
  await call('POST', `/orders/${o.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'Overtime 2 jam', amount: 60000, quantity: 1, is_billable: true } });
  m = await money();
  check('M7 admin Biaya Tambahan never touches the driver payable; counts as income',
    m.total === 1150000 && m.owed === 180000 && m.margin === 830000, show(m));

  // The analytics margin list treats billed trip costs as pass-through too.
  const q = `date_from=${encodeURIComponent('2021-03-10T00:00:00+07:00')}&date_to=${encodeURIComponent('2021-03-10T23:59:59+07:00')}`;
  const an = await call('GET', `/analytics/dashboard?${q}`, { token: admin });
  const row = an.data?.margin?.top?.find((r) => r.order_id === o.id);
  check('M8 /analytics/dashboard order margin = order card margin (billed trip costs not counted as profit)',
    row && row.margin === m.margin && row.revenue === m.total, JSON.stringify(row));

  // A3 (finance design §6, INV-6): a billed trip cost taken off while an
  // unpaid invoice still bills it beyond what is owed is refused with the
  // numbers. Settlement = everything billable (1.150.000 − 300.000 DP).
  const st9 = await invoice(o.id, 'SETTLEMENT', (await order(o.id)).money.billable_remaining);
  const toll9 = await prisma.expense.findFirst({ where: { order_service_item_id: lineId, type: 'TOLL' } });
  const rej9 = await call('PATCH', `/lines/expenses/${toll9.id}`, { token: admin, body: { status: 'REJECTED', review_note: 'tes INV-6' } });
  const m9 = await money();
  check('M9 [A3, INV-6] rejecting the billed toll (40.000) while the unpaid settlement (850.000) bills it → 409 OPEN_INVOICE_EXCEEDS (total 1.110.000, at most 810.000 open); nothing changed',
    st9.status === 201 && rej9.status === 409 && rej9.json?.code === 'OPEN_INVOICE_EXCEEDS' && rej9.json.new_total === 1110000 && rej9.json.open_billed === 850000 &&
    rej9.json.max_open_billed === 810000 && (await prisma.expense.findUnique({ where: { id: toll9.id } })).status === 'APPROVED' && m9.total === 1150000,
    `${st9.status} ${rej9.status} ${JSON.stringify(rej9.json).slice(0, 260)} ${show(m9)}`);
});

// ── N. Office e-toll cards: pool, handovers, top-ups, history ──────────────
await section('N. Office e-toll cards', async () => {
  const dA = await makeDriver(20);
  const dB = await makeDriver(21);
  const num = `6032${rnd()}${rnd().slice(0, 5)}`; // 16 digits
  const c1 = await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'BCA', name: `Flazz ${tag}`, card_number: num.replace(/(\d{4})/g, '$1 ').trim(), balance: 50000 } });
  const card = c1.data;
  check('N1 admin adds a card (201): number stored as digits, label, balance 50.000 from the first check',
    c1.status === 201 && card.card_number === num && card.label === `BCA Flazz · Flazz ${tag} ••••${num.slice(-4)}` && card.balance === 50000 && !!card.balance_at && card.holder === null, JSON.stringify(c1.json));
  check('N2 same card number again refused (409)', (await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'BCA', name: 'Dobel', card_number: num } })).status === 409);
  check('N3 card number with letters or too short refused (400)',
    (await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'BCA', name: 'X', card_number: '6032abcd' } })).status === 400 &&
    (await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'BCA', name: 'X', card_number: '1234' } })).status === 400);
  check('N4 driver token cannot use the admin card list (403)', (await call('GET', '/etoll-cards', { token: dA.token })).status === 403);
  const listA = await call('GET', '/driver/etoll-cards', { token: dA.token });
  const seen = listA.data?.items?.find((x) => x.id === card.id);
  check('N5 driver list: last four digits only, never the full number', !!seen && seen.card_last4 === num.slice(-4) && !('card_number' in seen) && !JSON.stringify(listA.json).includes(num), JSON.stringify(seen));

  // "Ambil kartu" (driver), resend, then another driver takes it over.
  const cardNotes = () => prisma.adminNotification.findMany({ where: { type: 'ETOLL_CARD', link: `/dashboard/etoll-cards/${card.id}` }, orderBy: { created_at: 'asc' } });
  const takeRef = uuid();
  const t1 = await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dA.token, body: { client_ref: takeRef, occurred_at: new Date().toISOString() } });
  check('N6 driver takes the card → 201, holder mine, admins told once', t1.status === 201 && t1.data?.card?.holder?.mine === true && (await cardNotes()).length === 1 && /mengambil kartu e-toll/.test((await cardNotes())[0].title), JSON.stringify(t1.json));
  const t1b = await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dA.token, body: { client_ref: takeRef } });
  const t1c = await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dA.token, body: { client_ref: uuid() } });
  check('N7 resend (same client_ref) and "Ambil" again while holding it → 200, one handover, no new notice',
    t1b.status === 200 && t1c.status === 200 && (await prisma.etollCardHandover.count({ where: { card_id: card.id } })) === 1 && (await cardNotes()).length === 1);
  check('N8 /driver/me shows the held card as etoll_card', (await call('GET', '/driver/me', { token: dA.token })).data?.etoll_card === card.label);
  check('N9 another driver cannot reuse the take client_ref (409)', (await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dB.token, body: { client_ref: takeRef } })).status === 409);

  // Old app (no card_id): the holder's request is linked to the held card.
  const oldReq = await call('POST', '/driver/requests', { token: dA.token, body: { type: 'ETOLL_TOPUP', card_label: card.label, balance: 30000, client_ref: uuid() } });
  let c = (await call('GET', `/etoll-cards/${card.id}`, { token: admin })).data;
  check('N10 request from an older app is linked to the card the driver holds; balance typed = balance check',
    oldReq.status === 201 && oldReq.data.request.card_id === card.id && c.card.balance === 30000 && c.transactions.some((t) => t.type === 'BALANCE_CHECK' && t.request_id === oldReq.data.request.id), JSON.stringify(oldReq.json));
  const newReq = await call('POST', '/driver/requests', { token: dB.token, body: { type: 'ETOLL_TOPUP', card_id: card.id, client_ref: uuid() } });
  check('N11 one open request per card: another driver asking for the same card → already_open', newReq.status === 200 && newReq.data.already_open === true && newReq.data.request.id === oldReq.data.request.id);
  check('N12 request for an unknown card → 404', (await call('POST', '/driver/requests', { token: dB.token, body: { type: 'ETOLL_TOPUP', card_id: uuid(), client_ref: uuid() } })).status === 404);

  const t2 = await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dB.token, body: { client_ref: uuid(), balance: 28000 } });
  const hs = await prisma.etollCardHandover.findMany({ where: { card_id: card.id }, orderBy: { taken_at: 'asc' } });
  const notes2 = await cardNotes();
  check('N13 another driver takes it over: first handover TAKEN_OVER, new holder, notice says who had it',
    t2.status === 201 && hs.length === 2 && hs[0].return_kind === 'TAKEN_OVER' && !!hs[0].returned_at && hs[1].driver_id === dB.id && !hs[1].returned_at && /sebelumnya dipegang/.test(notes2[notes2.length - 1].body), notes2[notes2.length - 1]?.body);
  check('N14 /driver/me of the first driver no longer shows the card', (await call('GET', '/driver/me', { token: dA.token })).data?.etoll_card === null);
  check('N15 the balance typed at "Ambil" is the new estimate (28.000)', (await call('GET', `/etoll-cards/${card.id}`, { token: admin })).data.card.balance === 28000);

  // Admin "Tandai sudah top-up" with the amount.
  const admReq = (await call('GET', '/driver-requests?status=OPEN', { token: admin })).data.items.find((x) => x.id === oldReq.data.request.id);
  check('N16 admin request list carries the card (full number for m-banking)', admReq?.card?.id === card.id && admReq.card.card_number === num && admReq.card.balance === 28000);
  check('N17 top-up amount 0 refused (400)', (await call('POST', `/driver-requests/${oldReq.data.request.id}/done`, { token: admin, body: { amount: 0 } })).status === 400);
  const done = await call('POST', `/driver-requests/${oldReq.data.request.id}/done`, { token: admin, body: { amount: 100000 } });
  await sleep(300);
  c = (await call('GET', `/etoll-cards/${card.id}`, { token: admin })).data;
  const topPush = (await pushesTo(dA)).filter((x) => x.title === 'Top-up e-toll sudah diproses');
  check('N18 done with amount: TOPUP on the card, estimate 128.000, last check time unchanged',
    done.status === 200 && c.card.balance === 128000 && c.transactions.filter((t) => t.type === 'TOPUP' && t.amount === 100000 && t.request_id === oldReq.data.request.id).length === 1 && c.card.balance_at === c.transactions.find((t) => t.note === 'Saat diambil')?.occurred_at, JSON.stringify(c.card));
  check('N19 driver push names the card and amount and says to update the balance on the card',
    topPush.length === 1 && topPush[0].body.includes(`••••${num.slice(-4)} sudah diisi Rp 100.000`) && /update saldo/.test(topPush[0].body), topPush[0]?.body);
  check('N20 second "done" refused (409), no second top-up',
    (await call('POST', `/driver-requests/${oldReq.data.request.id}/done`, { token: admin, body: { amount: 100000 } })).status === 409 &&
    (await prisma.etollTransaction.count({ where: { card_id: card.id, type: 'TOPUP' } })) === 1);

  // A request without any card (older app, no card held): the admin picks one.
  const loose = await call('POST', '/driver/requests', { token: dA.token, body: { type: 'ETOLL_TOPUP', card_label: 'Kartu lama', client_ref: uuid() } });
  check('N21 amount without a card refused (400 "Pilih kartu")', loose.status === 201 && !loose.data.request.card_id && (await call('POST', `/driver-requests/${loose.data.request.id}/done`, { token: admin, body: { amount: 50000 } })).status === 400);
  const picked = await call('POST', `/driver-requests/${loose.data.request.id}/done`, { token: admin, body: { amount: 50000, card_id: card.id, balance_after: 180000 } });
  c = (await call('GET', `/etoll-cards/${card.id}`, { token: admin })).data;
  check('N22 admin picks the card: request linked, balance after the top-up becomes the known balance (180.000)',
    picked.status === 200 && picked.data.request.card_id === card.id && c.card.balance === 180000, JSON.stringify(picked.json));

  // Admin entries, void, toll.
  const toll = await call('POST', `/etoll-cards/${card.id}/transactions`, { token: admin, body: { type: 'TOLL', amount: 24500, note: 'Tol Jagorawi', client_ref: uuid() } });
  check('N23 admin records a toll → estimate 155.500', toll.status === 201 && toll.data.card.balance === 155500, JSON.stringify(toll.json));
  const chkRef = uuid();
  const chk = await call('POST', `/etoll-cards/${card.id}/transactions`, { token: admin, body: { type: 'BALANCE_CHECK', balance_after: 150000, client_ref: chkRef } });
  const chk2 = await call('POST', `/etoll-cards/${card.id}/transactions`, { token: admin, body: { type: 'BALANCE_CHECK', balance_after: 150000, client_ref: chkRef } });
  check('N24 balance check resets the estimate (150.000); resend → 200, stored once',
    chk.status === 201 && chk.data.card.balance === 150000 && chk2.status === 200 && chk2.data.transaction.id === chk.data.transaction.id);
  check('N25 top-up without amount / check without balance refused (400)',
    (await call('POST', `/etoll-cards/${card.id}/transactions`, { token: admin, body: { type: 'TOPUP' } })).status === 400 &&
    (await call('POST', `/etoll-cards/${card.id}/transactions`, { token: admin, body: { type: 'BALANCE_CHECK' } })).status === 400);
  const v1 = await call('POST', `/etoll-cards/transactions/${chk.data.transaction.id}/void`, { token: admin, body: { reason: 'Salah ketik' } });
  check('N26 voiding the check brings the estimate back (155.500); second void 409',
    v1.status === 200 && v1.data.card.balance === 155500 && !!v1.data.transaction.voided_at &&
    (await call('POST', `/etoll-cards/transactions/${chk.data.transaction.id}/void`, { token: admin, body: {} })).status === 409);

  // Driver balance and "Kembalikan kartu".
  const balRef = uuid();
  const b1 = await call('POST', `/driver/etoll-cards/${card.id}/balance`, { token: dB.token, body: { client_ref: balRef, balance: 140000, source: 'NFC' } });
  const b2 = await call('POST', `/driver/etoll-cards/${card.id}/balance`, { token: dB.token, body: { client_ref: balRef, balance: 140000 } });
  check('N27 driver records the balance it read (201), resend 200 once; source NFC kept',
    b1.status === 201 && b1.data.card.balance === 140000 && b2.status === 200 && (await prisma.etollTransaction.count({ where: { client_ref: balRef, source: 'NFC' } })) === 1);
  const retRef = uuid();
  const r1 = await call('POST', `/driver/etoll-cards/${card.id}/return`, { token: dB.token, body: { client_ref: retRef, balance: 135000 } });
  const r2 = await call('POST', `/driver/etoll-cards/${card.id}/return`, { token: dB.token, body: { client_ref: retRef, balance: 135000 } });
  const r3 = await call('POST', `/driver/etoll-cards/${card.id}/return`, { token: dA.token, body: { client_ref: uuid() } });
  check('N28 driver returns it: holder empty, balance 135.000; resend and a driver not holding it → 200 no-op',
    r1.status === 200 && r1.data.returned === true && r1.data.card.holder === null && r1.data.card.balance === 135000 && r2.status === 200 && r2.data.returned === false && r3.status === 200 && r3.data.returned === false &&
    (await prisma.etollTransaction.count({ where: { card_id: card.id, note: 'Saat dikembalikan' } })) === 1);
  check('N29 admin "sudah kembali" on a card nobody holds → 409', (await call('POST', `/etoll-cards/${card.id}/return`, { token: admin, body: {} })).status === 409);
  const give = await call('POST', `/etoll-cards/${card.id}/give`, { token: admin, body: { driver_id: dA.id } });
  check('N30 admin hands it to a driver; the driver sees it as theirs', give.status === 200 && give.data.card.holder?.driver?.id === dA.id &&
    (await call('GET', '/driver/etoll-cards', { token: dA.token })).data.items[0]?.id === card.id);

  // History, deactivate, delete.
  const hist = (await call('GET', `/etoll-cards/${card.id}`, { token: admin })).data;
  check('N31 history: transactions and handovers newest first, admin emails for who entered what',
    hist.handovers.length === 3 && hist.handovers[0].driver.id === dA.id && hist.transactions.length >= 8 &&
    new Date(hist.transactions[0].occurred_at) >= new Date(hist.transactions[hist.transactions.length - 1].occurred_at) && Object.values(hist.users).includes('admin@e2e.local'));
  const req3 = await call('POST', '/driver/requests', { token: dA.token, body: { type: 'ETOLL_TOPUP', card_id: card.id, client_ref: uuid() } });
  const off = await call('PATCH', `/etoll-cards/${card.id}`, { token: admin, body: { status: 'INACTIVE', inactive_reason: 'Hilang' } });
  const req3After = await prisma.driverRequest.findUnique({ where: { id: req3.data.request.id } });
  check('N32 deactivating a held card: handover closed, its open request cancelled, gone from the driver list',
    off.status === 200 && off.data.status === 'INACTIVE' && off.data.inactive_reason === 'Hilang' && off.data.holder === null && req3After.status === 'CANCELLED' &&
    !(await call('GET', '/driver/etoll-cards', { token: dA.token })).data.items.some((x) => x.id === card.id));
  check('N33 an inactive card cannot be taken (409)', (await call('POST', `/driver/etoll-cards/${card.id}/take`, { token: dA.token, body: { client_ref: uuid() } })).status === 409);
  check('N34 a card with history cannot be deleted (409)', (await call('DELETE', `/etoll-cards/${card.id}`, { token: admin })).status === 409);
  const spare = await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'MANDIRI', name: `Typo ${tag}`, card_number: `6032${rnd()}9` } });
  const del = await call('DELETE', `/etoll-cards/${spare.data.id}`, { token: admin });
  check('N35 a card without history is deleted', spare.status === 201 && spare.data.balance === null && del.status === 200 && !(await prisma.etollCard.findUnique({ where: { id: spare.data.id } })));
  const act2 = await call('PATCH', `/etoll-cards/${card.id}`, { token: admin, body: { status: 'ACTIVE', name: `Flazz ${tag} B` } });
  check('N36 reactivating clears the reason; rename', act2.status === 200 && act2.data.status === 'ACTIVE' && act2.data.inactive_reason === null && act2.data.name === `Flazz ${tag} B`);

  // Two drivers press "Ambil kartu" on a free card at the same moment, and one
  // phone sends the same take twice at once: one open handover, one per ref.
  const race = (await call('POST', '/etoll-cards', { token: admin, body: { issuer: 'BRI', name: `Race ${tag}`, card_number: `6013${rnd()}${rnd().slice(0, 5)}` } })).data;
  const sameRef = uuid();
  const rs = await Promise.all([
    call('POST', `/driver/etoll-cards/${race.id}/take`, { token: dA.token, body: { client_ref: sameRef } }),
    call('POST', `/driver/etoll-cards/${race.id}/take`, { token: dA.token, body: { client_ref: sameRef } }),
    call('POST', `/driver/etoll-cards/${race.id}/take`, { token: dB.token, body: { client_ref: uuid() } }),
  ]);
  const open = await prisma.etollCardHandover.findMany({ where: { card_id: race.id, returned_at: null } });
  check('N37 takes at the same moment: exactly one open handover, the same client_ref stored once',
    rs.every((x) => x.status === 200 || x.status === 201) && open.length === 1 && (await prisma.etollCardHandover.count({ where: { client_ref: sameRef } })) === 1,
    rs.map((x) => x.status).join(','));
});

// ── O. One finance formula: Dashboard, Revenue page and order card ────────
// Each step is measured as a before/after difference over a window that
// covers every day used here, so other sections' data does not matter.
await section('O. Finance formulas (extra charges, cancellations, cancelled days)', async () => {
  const dO = await makeDriver(30);
  const dP = await makeDriver(31);
  const carO = await makeCar('Alphard');
  const carP = await makeCar('Pajero');
  const ymd = (days) => wibIso(days, '12:00').slice(0, 10);
  const range = `date_from=${ymd(-1)}&date_to=${ymd(60)}`;
  const dash = async () => (await call('GET', `/analytics/dashboard-v2?${range}`, { token: admin })).data;
  const rev = async () => (await call('GET', `/analytics/revenue?${range}`, { token: admin })).data;
  const get = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
  const diff = (a, b, path) => Number(get(b, path)) - Number(get(a, path));
  const show = (a, b, paths) => paths.map((p) => `${p} ${diff(a, b, p)}`).join(', ');
  const noFeeInvoice = (o) => !o.invoices.some((i) => i.invoice_type === 'CANCELLATION_FEE');

  // Extra charge (overtime) and a trip cost billed back at cost.
  const o1 = await makeOrder('O1', { startDay: 5 });
  await payDp(o1, 300_000);
  await putLine(o1.service_items[0].id, { is_external: false, driver_id: dO.id, car_id: carO.id, line_status: 'ASSIGNED', driver_fee: 200000 });
  let before = await dash();
  let rb = await rev();
  await call('POST', `/orders/${o1.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'Overtime 2 jam', amount: 150000, quantity: 1, is_billable: true } });
  let after = await dash();
  let ra = await rev();
  check('O1 [A1] overtime billed: Dashboard revenue, margin and internal channel +150.000 (extra charges)',
    diff(before, after, 'accrual.revenue') === 150000 && diff(before, after, 'accrual.margin') === 150000 &&
    diff(before, after, 'accrual.extra_charges') === 150000 && diff(before, after, 'channel.internal.revenue') === 150000,
    show(before, after, ['accrual.revenue', 'accrual.margin', 'accrual.extra_charges', 'channel.internal.revenue']));
  check('O2 [A1] Revenue page: order-level extra charges +150.000', diff(rb, ra, 'order_level.extra_charges') === 150000, show(rb, ra, ['order_level.extra_charges']));
  before = after;
  const pe = await call('POST', `/lines/${o1.service_items[0].id}/expenses`, { token: admin, body: { type: 'PARKING', amount: 40000, paid_by: 'COMPANY', bill_to_customer: true } });
  after = await dash();
  check('O3 parking billed back at cost: pass-through +40.000, revenue and margin unchanged',
    pe.status < 300 && diff(before, after, 'accrual.pass_through') === 40000 && diff(before, after, 'accrual.revenue') === 0 && diff(before, after, 'accrual.margin') === 0,
    `${pe.status} ${show(before, after, ['accrual.pass_through', 'accrual.revenue', 'accrual.margin'])}`);

  // Cancel before day H, DP covers the 20% fee.
  const o2 = await makeOrder('O4', { startDay: 6 });
  await payDp(o2, 200_000);
  before = await dash();
  const c2 = await call('POST', `/orders/${o2.id}/cancel`, { token: admin, body: { reason: 'Pelanggan batal O4' } });
  after = await dash();
  const o2a = await order(o2.id);
  check('O4 [A6] DP covers the 20% fee: no cancellation invoice, nothing owed, no refund',
    c2.status === 200 && c2.data.penalty === 200000 && c2.data.stillOwed === 0 && c2.data.refundDue === 0 && noFeeInvoice(o2a), JSON.stringify(c2.data ?? c2.json));
  check('O5 fee, date and reason stored on the order; paid in full',
    Number(o2a.cancellation_fee) === 200000 && !!o2a.cancelled_at && o2a.cancellation_reason === 'Pelanggan batal O4' && o2a.payment_status === 'PAID', o2a.payment_status);
  check('O6 [A2] Dashboard: the day leaves revenue (−1.000.000), the fee comes in (+200.000)',
    diff(before, after, 'accrual.revenue') === -800000 && diff(before, after, 'accrual.cancellation_income') === 200000 && diff(before, after, 'accrual.margin') === -800000,
    show(before, after, ['accrual.revenue', 'accrual.cancellation_income', 'accrual.margin']));
  const fin2 = await prisma.orderFinalFinance.findUnique({ where: { order_id: o2.id } });
  check('O7 [A8] order card after cancel: total and margin = fee 200.000', Number(fin2?.total_user_amount) === 200000 && Number(fin2?.margin_amount) === 200000, `${fin2?.total_user_amount} / ${fin2?.margin_amount}`);
  const rebill = [await invoice(o2.id, 'FULL', 200000), await invoice(o2.id, 'ADDITIONAL', 50000)];
  check('O7b the fee the DP covered cannot be billed again (new invoices refused)', rebill.every((r) => r.status >= 400), rebill.map((r) => `${r.status} ${r.json?.message ?? ''}`).join(' | '));

  // The day was yesterday and never started (tier 3, fee 100%): the DP does
  // not cover the fee. (Before day H the 20% fee never exceeds the ≥ 20% DP.)
  const o3 = await makeOrder('O8', { startDay: -1 });
  await payDp(o3, 300_000);
  before = await dash();
  const c3 = await call('POST', `/orders/${o3.id}/cancel`, { token: admin, body: { reason: 'Pelanggan batal O8' } });
  after = await dash();
  const fee3 = (await order(o3.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  check('O8 [A6] DP 300.000 < fee 1.000.000: one cancellation invoice for the remaining 700.000',
    c3.data?.tier === 3 && c3.data.stillOwed === 700000 && Number(fee3?.amount) === 700000 && fee3?.status === 'ISSUED' && c3.data.cancellationInvoiceNumber === fee3?.invoice_number,
    JSON.stringify(c3.data ?? c3.json));
  check('O9 [A2] the unpaid fee stays in receivables (700.000 before and after the cancel)', diff(before, after, 'outstanding.ar_outstanding') === 0, show(before, after, ['outstanding.ar_outstanding']));
  const extra3 = await invoice(o3.id, 'ADDITIONAL', 300000);
  const revUp = await call('POST', `/orders/${o3.id}/invoice/${fee3.id}/revise`, { token: admin, body: { amount: 1000000 } });
  check('O9b the DP already received is not billed again: extra invoice and revising the fee invoice up to 1.000.000 refused',
    extra3.status >= 400 && revUp.status >= 400, `${extra3.status} ${extra3.json?.message ?? ''} | ${revUp.status} ${revUp.json?.message ?? ''}`);
  before = after;
  await markPaid(o3.id, fee3.id);
  after = await dash();
  const o3b = await order(o3.id);
  check('O10 paying that invoice: 700.000 leaves receivables, the order is PAID (1.000.000 received)',
    diff(before, after, 'outstanding.ar_outstanding') === -700000 && Number(o3b.paid_to_date) === 1000000 && o3b.payment_status === 'PAID',
    `${show(before, after, ['outstanding.ar_outstanding'])} ${o3b.paid_to_date} ${o3b.payment_status}`);

  // Cancel after the driver left: the kept fee stays a cost.
  const o4 = await makeOrder('O11', { startDay: 0 });
  await payFull(o4);
  const l4 = o4.service_items[0].id;
  await putLine(l4, { is_external: false, driver_id: dO.id, car_id: carO.id, line_status: 'ASSIGNED', driver_fee: 200000 });
  await act(dO, l4, 'start');
  before = await dash();
  rb = await rev();
  const c4 = await call('POST', `/orders/${o4.id}/cancel`, { token: admin, body: { reason: 'Batal di jalan' } });
  after = await dash();
  ra = await rev();
  check('O11 cancel after departure: tier 3, paid in full, no invoice',
    c4.data?.tier === 3 && c4.data.stillOwed === 0 && noFeeInvoice(await order(o4.id)), JSON.stringify(c4.data ?? c4.json));
  check('O12 [A3] Dashboard: the kept driver fee stays a cost; the fee replaces the day price (revenue and margin unchanged)',
    diff(before, after, 'accrual.revenue') === 0 && diff(before, after, 'accrual.margin') === 0 && diff(before, after, 'accrual.driver_cost') === 0,
    show(before, after, ['accrual.revenue', 'accrual.margin', 'accrual.driver_cost']));
  check('O12b [A3] Revenue page: the unit keeps the fee as a cost (gross −1.000.000), the fee shows per order (+1.000.000)',
    diff(rb, ra, 'internal_cars.totals.final.driver_fee') + diff(rb, ra, 'internal_cars.totals.estimated.driver_fee') === 0 &&
    diff(rb, ra, 'internal_cars.totals.final.gross') + diff(rb, ra, 'internal_cars.totals.estimated.gross') === -1000000 &&
    diff(rb, ra, 'order_level.cancellation_income') === 1000000,
    show(rb, ra, ['internal_cars.totals.final.driver_fee', 'internal_cars.totals.estimated.driver_fee', 'internal_cars.totals.final.gross', 'internal_cars.totals.estimated.gross', 'order_level.cancellation_income']));

  // Cancel after day 1 is done (A7): the order stays open and closes through finalize.
  const o5 = await makeOrder('O13', { days: 2, price: 500_000, startDay: 0 });
  await payFull(o5);
  const [day1, day2] = [...o5.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date)).map((l) => l.id);
  await putLine(day1, { is_external: false, driver_id: dP.id, car_id: carP.id, line_status: 'ASSIGNED', driver_fee: 200000 });
  await act(dP, day1, 'start');
  await act(dP, day1, 'arrive', { latitude: -6.56, longitude: 106.8, location_accuracy_m: 12, location_mocked: false });
  await act(dP, day1, 'board');
  const fin = await act(dP, day1, 'finish', { notes: 'selesai' });
  check('O13 day 1 finished by the driver', fin.data?.status === 'DONE', JSON.stringify(fin.json).slice(0, 160));
  before = await dash();
  const c5 = await call('POST', `/orders/${o5.id}/cancel`, { token: admin, body: { reason: 'Pelanggan pulang lebih awal' } });
  after = await dash();
  const o5a = await order(o5.id);
  // A3: Batalkan Pesanan is per day. Day 1 is done and keeps its 500.000;
  // day 2 is tomorrow, tier 1: fee 20% = 100.000. Total 600.000, so 400.000
  // of the 1.000.000 paid is released as saldo lebih. (The old whole-order
  // rule took tier 3 = 1.000.000 and kept everything.)
  check('O14 [A7, A3] cancel after day 1: day 2 tier 1, fee 100.000, no invoice, 400.000 released as saldo lebih; order open, awaiting finalization',
    c5.data?.tier === 1 && c5.data.penalty === 100000 && c5.data.stillOwed === 0 && c5.data.refundDue === 400000 && noFeeInvoice(o5a) &&
    o5a.order_status !== 'CANCELLED' && o5a.awaiting_finalization === true && Number(o5a.cancellation_fee) === 100000 &&
    Number(o5a.final_price) === 600000 && o5a.money?.credit_balance === 400000 &&
    (await prisma.orderCreditEntry.count({ where: { order_id: o5.id, kind: 'RELEASE', amount: 400000 } })) === 1,
    `${JSON.stringify(c5.data ?? c5.json)} ${o5a.order_status} ${o5a.final_price} credit ${o5a.money?.credit_balance}`);
  // A3: day 2 leaves revenue (−500.000) and its fee comes in (+100.000).
  check('O15 [A7, A3] Dashboard: day 2 leaves revenue (−500.000), its fee comes in (+100.000): revenue and margin −400.000',
    diff(before, after, 'accrual.revenue') === -400000 && diff(before, after, 'accrual.margin') === -400000 && diff(before, after, 'accrual.cancellation_income') === 100000,
    show(before, after, ['accrual.revenue', 'accrual.margin', 'accrual.cancellation_income']));
  const fin5 = await prisma.orderFinalFinance.findUnique({ where: { order_id: o5.id } });
  // A3: total = day 1 500.000 + day-2 fee 100.000; margin = total − day-1 driver fee.
  check('O16 [A3] order card: total 600.000, margin 400.000 (total − day-1 driver fee)', Number(fin5?.total_user_amount) === 600000 && Number(fin5?.margin_amount) === 400000, `${fin5?.total_user_amount} / ${fin5?.margin_amount}`);
  const resave = await putLine(day1, { is_external: false, driver_fee: 200000 });
  const o5b = await order(o5.id);
  // A3: the total stays 600.000 and the 400.000 saldo lebih stays.
  check('O17 [A3] re-saving the done day keeps the total 600.000 and the saldo lebih 400.000 (no second release), PAID',
    resave.status === 200 && Number(o5b.final_price) === 600000 && o5b.payment_status === 'PAID' && o5b.money?.credit_balance === 400000,
    `${resave.status} ${o5b.final_price} ${o5b.payment_status} credit ${o5b.money?.credit_balance}`);
  check('O18 the cancelled day stays closed (409)', (await putLine(day2, { is_external: false, line_status: 'SCHEDULED' })).status === 409);
  const again = await call('POST', `/orders/${o5.id}/cancel`, { token: admin, body: { reason: 'lagi' } });
  const edit = await call('PUT', `/orders/${o5.id}`, { token: admin, body: editBody(o5b, { notes: 'x' }) });
  const charge = await call('POST', `/orders/${o5.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'OT', amount: 50000 } });
  check('O19 second cancel, Edit Order and new charges refused (409)', again.status === 409 && edit.status === 409 && charge.status === 409, `${again.status} ${edit.status} ${charge.status}`);
  const fz = await call('POST', `/orders/${o5.id}/finalize`, { token: admin });
  const log = await prisma.orderChangeLog.findFirst({ where: { order_id: o5.id, new_value: 'DONE' } });
  check('O20 [A7] finalize closes it as DONE, the cancellation in the note', fz.status === 200 && fz.data?.order_status === 'DONE' && /remaining days were cancelled/.test(log?.note ?? ''), log?.note);
});

// ── P. Official price list: working copy, history, publishing; invoice notes ─
// The list is seeded by the migration (docs/PRICE.md). Everything this group
// changes is put back at the end, so only the logs and publications remain.
await section('P. Price list and invoice wording', async () => {
  const hadPublication = (await prisma.pricePublication.count()) > 0;
  const list = await call('GET', '/prices', { token: admin });
  const L = list.data;
  const zone = (code) => L.zones.find((z) => z.code === code);
  const car = (slug) => L.cars.find((c) => c.slug === slug);
  const rate = (code, slug, duration) => zone(code).rates.find((r) => r.car_id === car(slug).id && r.duration === duration);
  const allRates = L?.zones?.flatMap((z) => z.rates) ?? [];
  const allSurcharges = L?.zones?.flatMap((z) => z.surcharges) ?? [];
  check('P1 seeded list: 14 cars, 6 tables, 154 rates, 19 area surcharges, 17 cities, 3 driver costs',
    list.status === 200 && L.cars.length === 14 && L.zones.length === 6 && allRates.length === 154 && allSurcharges.length === 19 && L.cities.length === 17 && L.extras.length === 3,
    JSON.stringify({ status: list.status, cars: L?.cars?.length, zones: L?.zones?.length, rates: allRates.length, surcharges: allSurcharges.length, cities: L?.cities?.length, extras: L?.extras?.length }));
  const drop = zone('DROP_JABODETABEK');
  check('P2 seed: Avanza Jabodetabek 500.000/700.000, Avanza Bandung Fullday 1.100.000, Fortuner all-in "Dibahas dengan admin", Hiace Commuter 12 jam only, Ertiga and every Drop price are proposals',
    rate('JABODETABEK', 'toyota-avanza', '12H').amount === 500000 && rate('JABODETABEK', 'toyota-avanza', 'FULLDAY').amount === 700000 &&
    rate('BANDUNG', 'toyota-avanza', 'FULLDAY').amount === 1100000 && rate('SURABAYA', 'toyota-zenix-q-hybrid-modellista', 'FULLDAY').amount === 2200000 &&
    rate('JAKARTA', 'toyota-fortuner', '12H').amount === null && rate('JAKARTA', 'toyota-fortuner', 'FULLDAY').note === 'Dibahas dengan admin' &&
    rate('JABODETABEK', 'toyota-hiace-commuter', '12H').amount === 1500000 && rate('JABODETABEK', 'toyota-hiace-commuter', 'FULLDAY').amount === null &&
    rate('JABODETABEK', 'suzuki-ertiga', '12H').is_proposal === true && rate('JABODETABEK', 'toyota-avanza', '12H').is_proposal === false &&
    drop.rates.length === 14 && drop.rates.every((r) => r.duration === 'DROP' && r.is_proposal) && rate('DROP_JABODETABEK', 'toyota-fortuner', 'DROP').amount === 1600000 &&
    allRates.filter((r) => r.is_proposal).length === 8 * 11 + 6);
  check('P2b proposal_count = the rates still marked as proposals (94), every row carries updated_at',
    L.proposal_count === 94 && [...L.cars, ...L.zones, ...allRates, ...allSurcharges, ...L.cities, ...L.extras].every((r) => typeof r.updated_at === 'string' && !Number.isNaN(Date.parse(r.updated_at))),
    String(L.proposal_count));
  const ot = L.extras.find((e) => e.code === 'OVERTIME');
  const city = (slug) => L.cities.find((c) => c.slug === slug);
  check('P3 seed: Bogor = Jabodetabek + all-in Surabaya, Jakarta = Jabodetabek + all-in Jakarta, Singapura a quote; overtime 10%, meal 100.000; Jakarta surcharges in order',
    city('sewa-mobil-bogor').driver_zone_id === zone('JABODETABEK').id && city('sewa-mobil-bogor').all_in_zone_id === zone('SURABAYA').id &&
    city('sewa-mobil-jakarta').all_in_zone_id === zone('JAKARTA').id && city('sewa-mobil-singapura').quote === true && city('sewa-mobil-singapura').driver_zone_id === null &&
    ot.percent === 10 && ot.amount === null && L.extras.find((e) => e.code === 'DRIVER_MEAL').amount === 100000 &&
    zone('JAKARTA').surcharges.map((s) => s.area).join(',') === 'Tangerang,Bekasi,Cikarang,Depok,Bogor,Puncak');
  check('P4 a driver token cannot use the price list (403)', (await call('GET', '/prices', { token: d1.token })).status === 403);
  if (!hadPublication) {
    const none = await call('GET', '/public/prices');
    check('P5 public list before the first publish → 404 "belum diterbitkan"', none.status === 404 && /belum diterbitkan/.test(none.json?.message ?? ''), JSON.stringify(none.json));
  }

  // Edit a rate: one log per changed field, counted as unpublished.
  const before = L.unpublished_changes;
  const target = rate('JAKARTA', 'toyota-avanza', '12H');
  const upd = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 775000, note: 'Naik' }] } });
  const changed = upd.data?.zones.find((z) => z.code === 'JAKARTA').rates.find((r) => r.id === target.id);
  const logs = await prisma.priceChangeLog.findMany({ where: { entity_id: target.id }, orderBy: { created_at: 'desc' }, take: 2 });
  check('P6 PATCH a rate: saved with who changed it, one log per changed field (amount, note), unpublished +2',
    upd.status === 200 && changed?.amount === 775000 && changed.note === 'Naik' && upd.data.users[changed.updated_by] === 'admin@e2e.local' &&
    logs.some((l) => l.field === 'amount' && l.old_value === '750000' && l.new_value === '775000') && logs.some((l) => l.field === 'note' && l.old_value === null && l.new_value === 'Naik') &&
    upd.data.unpublished_changes === before + 2, JSON.stringify({ status: upd.status, changed, unpublished: upd.data?.unpublished_changes, before }));
  const same = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 775000, note: 'Naik' }] } });
  check('P7 the same values again: nothing logged', same.status === 200 && same.data.unpublished_changes === before + 2);
  const ask = rate('LUAR_KOTA', 'toyota-rush', 'FULLDAY');
  const askUpd = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: ask.id, amount: null, is_proposal: false }] } });
  const askRow = askUpd.data?.zones.find((z) => z.code === 'LUAR_KOTA').rates.find((r) => r.id === ask.id);
  check('P8 amount null = "tanya admin", proposal flag cleared', askUpd.status === 200 && askRow?.amount === null && askRow.is_proposal === false);
  check('P9 negative or decimal amount (400), unknown rate (404), driver token (403)',
    (await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: -1 }] } })).status === 400 &&
    (await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 1000.5 }] } })).status === 400 &&
    (await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: uuid(), amount: 1000 }] } })).status === 404 &&
    (await call('PATCH', '/prices/rates', { token: d1.token, body: { items: [{ id: target.id, amount: 1 }] } })).status === 403);

  // Two admins on the same page: a save from a stale page is refused (409).
  const jktRate = (data, id) => data?.zones.find((z) => z.code === 'JAKARTA').rates.find((r) => r.id === id);
  const loaded = jktRate(upd.data, target.id); // amount 775000, as the page shows it now
  const otherRate = rate('JAKARTA', 'mitsubishi-xpander', '12H');
  const fresh = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 780000, expected_updated_at: loaded.updated_at }] } });
  const savedA = jktRate(fresh.data, target.id);
  check('P9b save with the current expected_updated_at → 200, updated_at moves on',
    fresh.status === 200 && savedA?.amount === 780000 && savedA.updated_at !== loaded.updated_at, JSON.stringify({ status: fresh.status, msg: fresh.json?.message, savedA }));
  const stale = await call('PATCH', '/prices/rates', { token: admin, body: { items: [
    { id: otherRate.id, amount: 1234000, expected_updated_at: otherRate.updated_at },
    { id: target.id, amount: 790000, expected_updated_at: loaded.updated_at },
  ] } });
  const afterStale = (await call('GET', '/prices', { token: admin })).data;
  check('P9c a stale item → 409 "sudah diubah admin lain" with only its id in conflict_ids; nothing of the save is stored (the fresh item neither)',
    stale.status === 409 && stale.json?.message === 'Harga ini sudah diubah admin lain. Muat ulang halaman lalu ulangi.' &&
    JSON.stringify(stale.json?.conflict_ids) === JSON.stringify([target.id]) &&
    jktRate(afterStale, target.id).amount === 780000 && jktRate(afterStale, otherRate.id).amount === otherRate.amount,
    JSON.stringify(stale.json));
  const noCheck = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 775000 }] } });
  check('P9d without expected_updated_at: saved as before (no check); a non-ISO value → 400',
    noCheck.status === 200 && jktRate(noCheck.data, target.id).amount === 775000 &&
    (await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 775000, expected_updated_at: 'kemarin' }] } })).status === 400);
  const longAgo = '2000-01-01T00:00:00.000Z';
  const staleOne = async (path) => (await call('PATCH', path, { token: admin, body: { expected_updated_at: longAgo } }));
  const [zStale, eStale, cStale, carStale] = await Promise.all([
    staleOne(`/prices/zones/${zone('JAKARTA').id}`),
    staleOne(`/prices/extras/${L.extras[0].id}`),
    staleOne(`/prices/cities/${L.cities[0].id}`),
    staleOne(`/prices/cars/${L.cars[0].id}`),
  ]);
  check('P9e zone, driver cost, city and car: a stale expected_updated_at → 409 with the id',
    [zStale, eStale, cStale, carStale].every((r) => r.status === 409 && r.json?.conflict_ids?.length === 1) &&
    zStale.json.conflict_ids[0] === zone('JAKARTA').id && carStale.json.conflict_ids[0] === L.cars[0].id,
    [zStale, eStale, cStale, carStale].map((r) => r.status).join(','));
  // A write after a publication dated later than this server's clock (another
  // server, a clock step back) still counts as unpublished.
  const ahead = await prisma.pricePublication.create({
    data: { snapshot: {}, client_ref: uuid(), deploy_status: 'SKIPPED', created_at: new Date(Date.now() + 60_000) },
  });
  const afterAhead = await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 776000 }] } });
  const aheadLog = await prisma.priceChangeLog.findFirst({ where: { entity_id: target.id }, orderBy: { created_at: 'desc' } });
  check('P9f a change after a publication stamped in the future is still counted (log time > publication time)',
    afterAhead.status === 200 && afterAhead.data.unpublished_changes === 1 && aheadLog.created_at > ahead.created_at,
    JSON.stringify({ unpublished: afterAhead.data?.unpublished_changes }));
  await prisma.pricePublication.delete({ where: { id: ahead.id } });
  await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 775000 }] } });

  // Publish, then the public list.
  const pubCount = await prisma.pricePublication.count();
  const noRef = await call('POST', '/prices/publish', { token: admin, body: { note: 'tanpa ref', confirm_proposals: true } });
  check('P10a publish without client_ref → 400', noRef.status === 400, JSON.stringify(noRef.json));
  const proposals = (await call('GET', '/prices', { token: admin })).data.proposal_count;
  const unconfirmed = await call('POST', '/prices/publish', { token: admin, body: { client_ref: uuid() } });
  check('P10b publish while rates are proposals, without confirm_proposals → 409 naming how many; nothing stored',
    proposals === 93 && unconfirmed.status === 409 &&
    unconfirmed.json?.message === `Masih ada ${proposals} harga usulan yang belum dikonfirmasi owner. Centang konfirmasi untuk tetap menerbitkan.` &&
    unconfirmed.json?.proposal_count === proposals && (await prisma.pricePublication.count()) === pubCount,
    JSON.stringify({ proposals, status: unconfirmed.status, body: unconfirmed.json }));
  const hook = async (q = '') => (await fetch(`${MOCK}/__deploy-hook${q}`)).json();
  await hook('?fail=0');
  const hookCalls = (await hook()).calls;
  const ref = uuid();
  const p1 = await call('POST', '/prices/publish', { token: admin, body: { note: 'Daftar harga e2e', client_ref: ref, confirm_proposals: true } });
  const snap1 = p1.data?.snapshot;
  check('P10 publish with confirm_proposals → 201, the deploy hook called once (SENT), the snapshot has the new price',
    p1.status === 201 && p1.data.publication.deploy_status === 'SENT' && (await hook()).calls === hookCalls + 1 && snap1?.version === 1 && snap1.zones.find((z) => z.code === 'JAKARTA').rates['toyota-avanza']['12H'] === 775000,
    JSON.stringify(p1.data?.publication ?? p1.json));
  const res = await fetch(`${BASE}/public/prices`); // no token, no Origin (a server-side build)
  const body = await res.json();
  const snap = body.data;
  const text = JSON.stringify(body);
  check('P11 public list (no token, no Origin): the published snapshot, Cache-Control public 5 min, no proposal flags or admin ids',
    res.status === 200 && snap.published_at === snap1.published_at && snap.zones.find((z) => z.code === 'JAKARTA').rates['toyota-avanza']['12H'] === 775000 &&
    snap.zones.find((z) => z.code === 'LUAR_KOTA').rates['toyota-rush'].FULLDAY === null &&
    res.headers.get('cache-control') === 'public, max-age=300' && !/is_proposal|updated_by|published_by|changed_by/.test(text), `${res.status} ${res.headers.get('cache-control')}`);
  const jkt = snap.zones.find((z) => z.code === 'JAKARTA');
  check('P12 snapshot shape (website contract v1): cars, zones with rates by car slug (in fleet order), cities by zone code, extras by code',
    snap.cars.length === 14 && JSON.stringify(snap.cars[0]) === '{"slug":"toyota-avanza","name":"Toyota Avanza","price_class":"Avanza sekelas"}' &&
    Object.keys(jkt).join(',') === 'code,name,service_package,included,excluded,note,default_for_unlisted,rates,surcharges' &&
    jkt.service_package === 'ALL-IN X PARKIR' && JSON.stringify(jkt.surcharges[0]) === '{"area":"Tangerang","amount":200000}' &&
    Object.keys(jkt.rates).join(',') === snap.cars.map((c) => c.slug).join(',') && Object.keys(jkt.rates['toyota-avanza']).join(',') === '12H,FULLDAY' &&
    JSON.stringify(snap.zones.find((z) => z.code === 'DROP_JABODETABEK').rates['toyota-avanza']) === '{"DROP":500000}' &&
    JSON.stringify(snap.cities.find((c) => c.slug === 'sewa-mobil-jakarta')) === '{"slug":"sewa-mobil-jakarta","name":"Jakarta","driver_zone":"JABODETABEK","all_in_zone":"JAKARTA","quote":false}' &&
    JSON.stringify(snap.cities.find((c) => c.slug === 'sewa-mobil-thailand')) === '{"slug":"sewa-mobil-thailand","name":"Thailand","driver_zone":null,"all_in_zone":null,"quote":true}' &&
    snap.extras.OVERTIME.percent === 10 && snap.extras.DRIVER_LODGING.amount === 150000 && snap.zones.find((z) => z.code === 'SURABAYA').default_for_unlisted === true,
    JSON.stringify(snap.cars[0]));
  const site = await fetch(`${BASE}/public/prices`, { headers: { Origin: 'https://arasya-web.vercel.app' } });
  const other = await fetch(`${BASE}/public/prices`, { headers: { Origin: 'https://evil.example' } });
  check('P13 CORS: the website origin is allowed, another origin gets no allow header',
    site.headers.get('access-control-allow-origin') === 'https://arasya-web.vercel.app' && !other.headers.get('access-control-allow-origin'),
    `${site.headers.get('access-control-allow-origin')} / ${other.headers.get('access-control-allow-origin')}`);
  const p2 = await call('POST', '/prices/publish', { token: admin, body: { client_ref: ref } });
  check('P14 publish again with the same client_ref → 200, the same publication, stored once',
    p2.status === 200 && p2.data.publication.id === p1.data.publication.id && (await prisma.pricePublication.count({ where: { client_ref: ref } })) === 1);
  const L2 = (await call('GET', '/prices', { token: admin })).data;
  check('P15 after publishing: unpublished_changes 0, last_publication is it, with who published',
    L2.unpublished_changes === 0 && L2.last_publication?.id === p1.data.publication.id && L2.last_publication.deploy_status === 'SENT' && L2.users[L2.last_publication.published_by] === 'admin@e2e.local',
    JSON.stringify({ unpublished: L2.unpublished_changes, last: L2.last_publication }));

  // The hook is down: FAILED; the admin's resend (same client_ref) calls it again.
  await hook('?fail=1');
  const ref2 = uuid();
  const f1 = await call('POST', '/prices/publish', { token: admin, body: { client_ref: ref2, confirm_proposals: true } });
  await hook('?fail=0');
  const callsBefore = (await hook()).calls;
  const f2 = await call('POST', '/prices/publish', { token: admin, body: { client_ref: ref2, confirm_proposals: true } });
  const f3 = await call('POST', '/prices/publish', { token: admin, body: { client_ref: ref2, confirm_proposals: true } });
  const stored = await prisma.pricePublication.findUnique({ where: { client_ref: ref2 } });
  check('P15b hook down → FAILED; the resend calls it again → 200, the same publication, SENT (stored); a further resend does not call it',
    f1.status === 201 && f1.data.publication.deploy_status === 'FAILED' &&
    f2.status === 200 && f2.data.publication.id === f1.data.publication.id && f2.data.publication.deploy_status === 'SENT' && stored?.deploy_status === 'SENT' &&
    f3.status === 200 && (await hook()).calls === callsBefore + 1,
    JSON.stringify({ f1: f1.data?.publication ?? f1.json, f2: f2.data?.publication ?? f2.json }));

  // Area surcharges.
  const jakarta = zone('JAKARTA');
  const dup = await call('POST', '/prices/surcharges', { token: admin, body: { zone_id: jakarta.id, area: 'bekasi', amount: 150000 } });
  check('P16 a surcharge for an area the table already has (any capitalisation) → 409', dup.status === 409 && /sudah ada/.test(dup.json?.message ?? ''), dup.json?.message);
  const area = `Karawang ${tag}`;
  const add = await call('POST', '/prices/surcharges', { token: admin, body: { zone_id: jakarta.id, area, amount: 250000 } });
  const added = add.data?.zones.find((z) => z.code === 'JAKARTA').surcharges.find((s) => s.area === area);
  check('P17 new surcharge (201) goes last in its table and counts as unpublished', add.status === 201 && added?.amount === 250000 && added.sort_order === 6 && add.data.unpublished_changes === 1, JSON.stringify(added));
  check('P18 renaming it to an area already listed → 409', (await call('PATCH', `/prices/surcharges/${added.id}`, { token: admin, body: { area: 'Bogor' } })).status === 409);
  const moved = await call('PATCH', `/prices/surcharges/${added.id}`, { token: admin, body: { sort_order: 7, expected_updated_at: added.updated_at } });
  const movedRow = moved.data?.zones.find((z) => z.code === 'JAKARTA').surcharges.find((s) => s.id === added.id);
  const staleMove = await call('PATCH', `/prices/surcharges/${added.id}`, { token: admin, body: { sort_order: 8, expected_updated_at: added.updated_at } });
  const staleDel = await call('DELETE', `/prices/surcharges/${added.id}?expected_updated_at=${encodeURIComponent(added.updated_at)}`, { token: admin });
  check('P18b surcharge: fresh PATCH → 200; PATCH and DELETE from the stale page → 409 (still there)',
    moved.status === 200 && movedRow?.sort_order === 7 && staleMove.status === 409 && staleDel.status === 409 &&
    JSON.stringify(staleDel.json?.conflict_ids) === JSON.stringify([added.id]) && (await prisma.priceSurcharge.count({ where: { id: added.id } })) === 1,
    `${moved.status} ${staleMove.status} ${staleDel.status}`);
  const del = await call('DELETE', `/prices/surcharges/${added.id}?expected_updated_at=${encodeURIComponent(movedRow?.updated_at ?? '')}`, { token: admin });
  const delLog = await prisma.priceChangeLog.findFirst({ where: { entity_id: added.id, field: 'deleted' } });
  check('P19 delete: gone, the log keeps what it was (new_value null)',
    del.status === 200 && !del.data.zones.find((z) => z.code === 'JAKARTA').surcharges.some((s) => s.id === added.id) && delLog?.old_value === `${area}: 250000` && delLog.new_value === null);

  // Cities, cars, driver costs.
  const jktCity = city('sewa-mobil-jakarta');
  check('P20 city: an all-in table as its car + driver table → 400', (await call('PATCH', `/prices/cities/${jktCity.id}`, { token: admin, body: { driver_zone_id: jakarta.id } })).status === 400);
  const quote = await call('PATCH', `/prices/cities/${jktCity.id}`, { token: admin, body: { quote: true } });
  const qc = quote.data?.cities.find((c) => c.id === jktCity.id);
  const backCity = await call('PATCH', `/prices/cities/${jktCity.id}`, { token: admin, body: { quote: false, driver_zone_id: jktCity.driver_zone_id, all_in_zone_id: jktCity.all_in_zone_id } });
  const bc = backCity.data?.cities.find((c) => c.id === jktCity.id);
  check('P21 marking a city as quote clears both tables; back to its tables',
    quote.status === 200 && qc.quote === true && qc.driver_zone_id === null && qc.all_in_zone_id === null &&
    backCity.status === 200 && bc.quote === false && bc.driver_zone_id === jktCity.driver_zone_id && bc.all_in_zone_id === jktCity.all_in_zone_id);
  const slug = `test-car-${tag}`;
  const newCar = await call('POST', '/prices/cars', { token: admin, body: { slug, name: `Test Car ${tag}` } });
  const nc = newCar.data?.cars.find((c) => c.slug === slug);
  const ncRates = (newCar.data?.zones ?? []).flatMap((z) => z.rates.filter((r) => r.car_id === nc?.id).map((r) => ({ code: z.code, ...r })));
  check('P22 new car: last in the list, 11 empty rates (12 jam + Fullday in 5 tables, Drop in the drop table), all proposals',
    newCar.status === 201 && nc?.sort_order === 14 && ncRates.length === 11 &&
    ncRates.every((r) => r.amount === null && r.is_proposal && (r.code.startsWith('DROP') ? r.duration === 'DROP' : r.duration !== 'DROP')), JSON.stringify({ status: newCar.status, nc, n: ncRates.length }));
  check('P23 the same slug again → 409, a slug with spaces → 400',
    (await call('POST', '/prices/cars', { token: admin, body: { slug, name: 'Dobel' } })).status === 409 &&
    (await call('POST', '/prices/cars', { token: admin, body: { slug: 'Toyota Baru', name: 'X' } })).status === 400);
  const ex = await call('PATCH', `/prices/extras/${ot.id}`, { token: admin, body: { percent: 12.5 } });
  check('P24 overtime percent edited (12,5%)', ex.status === 200 && ex.data.extras.find((e) => e.code === 'OVERTIME').percent === 12.5);

  // History and publications.
  const hist = await call('GET', '/prices/history?limit=5', { token: admin });
  const items = hist.data?.items ?? [];
  const rateLog = (await call('GET', '/prices/history?limit=500', { token: admin })).data?.items.find((i) => i.entity_id === target.id);
  check('P25 history: newest first, limit, admin emails; a rate log is labelled car · table · duration',
    hist.status === 200 && items.length === 5 && items[0].field === 'percent' && new Date(items[0].created_at) >= new Date(items[4].created_at) &&
    Object.values(hist.data.users).includes('admin@e2e.local') && rateLog?.label === 'Toyota Avanza · All-in Jakarta · 12 jam', rateLog?.label);
  const pubs = await call('GET', '/prices/publications', { token: admin });
  check('P26 publications list (newest first) without the snapshot body', pubs.status === 200 && pubs.data.items[0]?.id === f1.data.publication.id && pubs.data.items[1]?.id === p1.data.publication.id && !('snapshot' in pubs.data.items[0]));

  // Put the seed back (the logs stay).
  await call('PATCH', '/prices/rates', { token: admin, body: { items: [{ id: target.id, amount: 750000, note: null }, { id: ask.id, amount: ask.amount, is_proposal: ask.is_proposal }] } });
  await call('PATCH', `/prices/extras/${ot.id}`, { token: admin, body: { percent: 10 } });
  if (nc) {
    await prisma.priceRate.deleteMany({ where: { car_id: nc.id } });
    await prisma.priceCar.delete({ where: { id: nc.id } });
  }
  const L3 = (await call('GET', '/prices', { token: admin })).data;
  check('P27 seed restored (Avanza all-in Jakarta 750.000, Rush luar kota Fullday 1.000.000, overtime 10%)',
    L3.zones.find((z) => z.code === 'JAKARTA').rates.find((r) => r.id === target.id).amount === 750000 &&
    L3.zones.find((z) => z.code === 'LUAR_KOTA').rates.find((r) => r.id === ask.id).amount === 1000000 && L3.cars.length === 14 &&
    L3.extras.find((e) => e.code === 'OVERTIME').percent === 10);

  // Invoice wording follows the package of the order's days (built file).
  const { packageNoteLines } = createRequire(import.meta.url)('../../dist/src/utils/packageNotes.js');
  const xops = packageNoteLines([{ service_package: 'XOPS', line_status: 'SCHEDULED' }]);
  check('P28 invoice notes, X Ops: car and driver only',
    xops.length === 2 && xops[0] === 'Harga termasuk mobil dan supir' && xops[1] === 'Belum termasuk BBM, tol, parkir/tiket masuk kawasan, dan makan supir; tips supir seikhlasnya dari Tamu', JSON.stringify(xops));
  const allIn = packageNoteLines([{ service_package: 'ALL-IN X PARKIR', line_status: 'DONE' }, { service_package: 'XOPS', line_status: 'CANCELLED' }]);
  check('P29 invoice notes, All-in X Parkir (a cancelled X Ops day ignored): the two all-in lines',
    allIn.length === 2 && allIn[0] === 'Harga termasuk mobil supir bbm tol makan supir' && allIn[1] === 'Parkir/tiket masuk kawasan dan tips supir seikhlasnya dari Tamu', JSON.stringify(allIn));
  const mixed = packageNoteLines([{ service_package: 'ALL-IN' }, { service_package: 'ALL-IN X PARKIR' }, { service_package: 'xops' }]);
  check('P30 invoice notes, mixed order: one prefixed pair per package; unknown/empty = All-in',
    mixed.length === 4 && mixed[0] === 'Paket All-in: Harga termasuk mobil supir bbm tol makan supir' && mixed[2] === 'Paket X Ops: Harga termasuk mobil dan supir' &&
    packageNoteLines([{ service_package: null }])[0] === 'Harga termasuk mobil supir bbm tol makan supir', JSON.stringify(mixed));
});

// ── Q. Cancelled days, billed totals and the DP minimum (B1, B2, B7, B12) ──
await section('Q. Cancelled days, billed totals, DP minimum (B1, B2, B7, B12)', async () => {
  const dQ = await makeDriver(40);
  const carQ = await makeCar('Brio');
  const line = (id) => prisma.orderServiceItem.findUnique({ where: { id } });
  const revise = (o, inv, amount) => call('POST', `/orders/${o.id}/invoice/${inv.id}/revise`, { token: admin, body: { amount } });
  // Text of an uploaded PDF (pdf-lib writes standard-font text as hex strings,
  // inside deflated content streams).
  const { inflateSync } = await import('node:zlib');
  const pdfText = async (url) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^.*\/object\/public\//, ''));
    const buf = Buffer.from(await (await fetch(`${MOCK}/__object?key=${encodeURIComponent(key)}`)).arrayBuffer());
    const raw = buf.toString('latin1');
    const parts = [raw];
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const end = raw.indexOf('endstream', m.index);
      if (end < 0) break;
      try { parts.push(inflateSync(buf.subarray(m.index + m[0].length, end)).toString('latin1')); } catch {}
    }
    return parts.join('\n').replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s/g, ''), 'hex').toString('latin1'));
  };

  // B1.1: Edit Hari never ends an order.
  const o1 = await makeOrder('Q1', { startDay: 20 });
  const p1 = await putLine(o1.service_items[0].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q1' });
  check('Q1 [B1.1] cancelling the only day in Edit Hari refused (409 LAST_OPEN_DAY, points to Batalkan Pesanan), day and order unchanged',
    p1.status === 409 && p1.json?.code === 'LAST_OPEN_DAY' && /hari terakhir yang masih aktif/.test(p1.json?.message ?? '') && /Batalkan Pesanan/.test(p1.json?.message ?? '') &&
    (await line(o1.service_items[0].id)).line_status === 'SCHEDULED' && (await order(o1.id)).order_status !== 'CANCELLED', p1.json?.message);
  const o2 = await makeOrder('Q2', { days: 2, startDay: 21 });
  const p2a = await putLine(o2.service_items[0].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q2' });
  const o2a = await order(o2.id);
  // A3: the cancelled day keeps its 20% fee: 1.000.000 + 200.000.
  check('Q2 [B1.1, A3] one day of a two-day order can be cancelled; total 1.200.000 (the open day + the 20% fee)', p2a.status === 200 && Number(o2a.final_price) === 1200000, `${p2a.status} ${p2a.json?.message ?? ''} ${o2a.final_price}`);
  const p2b = await putLine(o2.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q3' });
  check('Q3 [B1.1] the remaining day then refused (409), order not cancelled',
    p2b.status === 409 && /hari terakhir/.test(p2b.json?.message ?? '') && (await order(o2.id)).order_status !== 'CANCELLED', p2b.json?.message);
  // Day 1 done, day 2 still to run: cancelling or removing day 2 would end the order.
  const o3 = await makeOrder('Q4', { days: 2, startDay: 22 });
  const [d1st, d2nd] = [...o3.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date)).map((l) => l.id);
  await prisma.orderServiceItem.update({ where: { id: d1st }, data: { line_status: 'DONE' } });
  const p4 = await putLine(d2nd, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q4' });
  check('Q4 [B1.1] day 1 done: cancelling day 2 in Edit Hari refused (409)', p4.status === 409 && /hari terakhir/.test(p4.json?.message ?? '') && (await line(d2nd)).line_status === 'SCHEDULED', p4.json?.message);
  const p5 = await call('PUT', `/orders/${o3.id}`, { token: admin, body: editBody(await order(o3.id), { reason: 'hapus hari', days: [{ id: d1st }] }) });
  check('Q5 [B1.1] nor removed in Edit Order (409), day kept', p5.status === 409 && /hari terakhir/.test(p5.json?.message ?? '') && (await order(o3.id)).service_items.length === 2, p5.json?.message);

  // B1.3: Edit Hari does not push the total below what is billed.
  const o4 = await makeOrder('Q6', { days: 2, startDay: 23 });
  const full4 = (await invoice(o4.id, 'FULL', 2_000_000)).data;
  const p6 = await putLine(o4.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q6' });
  const o4a = await order(o4.id);
  // A3: B1.3 is now INV-6. The cancelled day keeps its 20% fee, so the new
  // total is 1.200.000; the unpaid 2.000.000 invoice may ask at most that.
  // The message names both amounts and how far to revise.
  check('Q6 [B1.3 → INV-6, A3] cancelling a day below the issued invoice refused (409 OPEN_INVOICE_EXCEEDS, Rp 1.200.000 and Rp 2.000.000), day and total unchanged',
    p6.status === 409 && p6.json?.code === 'OPEN_INVOICE_EXCEEDS' && /Rp 1\.200\.000/.test(p6.json?.message ?? '') && /Rp 2\.000\.000/.test(p6.json?.message ?? '') && /Revisi invoice/.test(p6.json?.message ?? '') &&
    p6.json.new_total === 1200000 && p6.json.covered === 0 && p6.json.open_billed === 2000000 && p6.json.max_open_billed === 1200000 &&
    o4a.service_items.every((l) => l.line_status === 'SCHEDULED') && Number(o4a.final_price) === 2000000, `${p6.status} ${JSON.stringify(p6.json).slice(0, 300)}`);
  // A3: revised to exactly the most it may ask (1.200.000), the cancel passes.
  const rv4 = await revise(o4, full4, 1_200_000);
  const p7 = await putLine(o4.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q7' });
  check('Q7 [B1.3 → INV-6, A3] after revising the invoice to Rp 1.200.000 the day can be cancelled; total 1.200.000',
    rv4.status === 201 && p7.status === 200 && Number((await order(o4.id)).final_price) === 1200000, `${rv4.status} ${p7.status} ${p7.json?.message ?? ''}`);

  // B2: DP_PAID needs 20% of the rental base actually received.
  const o5 = await makeOrder('Q8', { startDay: 24 });
  const dp5 = (await invoice(o5.id, 'DP', 200_000)).data;
  await markPaid(o5.id, dp5.id, { amount_received: 50_000, amount_mismatch_ack: true });
  const o5a = await order(o5.id);
  check('Q8 [B2] DP invoice marked paid with 50.000 received (< 20%): stays UNPAID', o5a.payment_status === 'UNPAID' && Number(o5a.paid_to_date) === 50000, `${o5a.payment_status} ${o5a.paid_to_date}`);
  const p9 = await putLine(o5.service_items[0].id, { is_external: false, driver_id: dQ.id, car_id: carQ.id });
  check('Q9 [B2] driver refused (409), message gives the money received and the minimum DP',
    p9.status === 409 && /Rp 50\.000/.test(p9.json?.message ?? '') && /Rp 200\.000/.test(p9.json?.message ?? ''), p9.json?.message);
  const st5 = (await invoice(o5.id, 'SETTLEMENT', 150_000)).data;
  await markPaid(o5.id, st5.id);
  const p10 = await putLine(o5.service_items[0].id, { is_external: false, driver_id: dQ.id, car_id: carQ.id });
  check('Q10 [B2] 200.000 received in total: DP_PAID, driver accepted', (await order(o5.id)).payment_status === 'DP_PAID' && p10.status === 200, `${p10.status} ${p10.json?.message ?? ''}`);
  const o6 = await makeOrder('Q11', { startDay: 25 });
  const dp6 = (await invoice(o6.id, 'DP', 200_000)).data;
  const low = await revise(o6, dp6, 100_000);
  const ok6 = await revise(o6, dp6, 250_000);
  check('Q11 [B2] revising a DP below 20% refused (409); 250.000 accepted', low.status === 409 && ok6.status === 201, `${low.status} ${low.json?.message ?? ''} / ${ok6.status}`);
  const o7 = await makeOrder('Q12', { startDay: 26 });
  await payDp(o7, 200_000);
  const add7 = await call('PUT', `/orders/${o7.id}`, {
    token: admin,
    body: editBody(o7, { reason: 'tambah hari', days: [{ id: o7.service_items[0].id }, { service_date: wibIso(27, '00:00'), start_at: wibIso(27, '08:00'), end_at: wibIso(27, '20:00'), unit_price: 1_000_000 }] }),
  });
  check('Q12 [B2] a day added: 200.000 is below 20% of 2.000.000, DP_PAID → UNPAID', add7.status === 200 && (await order(o7.id)).payment_status === 'UNPAID', `${add7.status} ${(await order(o7.id)).payment_status}`);

  // B7: the DP base and the PDFs leave cancelled days out.
  const o8 = await makeOrder('Q13', { days: 2, startDay: 28 });
  await putLine(o8.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q13' });
  // A3: the cancelled day keeps its 20% fee in the base: 1.000.000 + 200.000
  // = 1.200.000, so the DP minimum is 240.000 (was 200.000 of 1.000.000).
  const low8 = await invoice(o8.id, 'DP', 200_000);
  const dp8 = await invoice(o8.id, 'DP', 240_000);
  check('Q13 [B7, A3] DP base = the open day + the cancelled day\'s fee (1.200.000): 200.000 refused, 240.000 (20%) accepted',
    low8.status >= 400 && low8.status < 500 && dp8.status === 201, `${low8.status} ${low8.json?.message ?? ''} / ${dp8.status} ${dp8.json?.message ?? ''}`);
  // A3: the cancelled day prints its fee and tier; the PDF writes "—" as "-".
  const dpPdf = dp8.data?.file_url ? await pdfStrings(dp8.data.file_url) : '';
  const stmt8 = await call('POST', `/orders/${o8.id}/statement`, { token: admin, body: {} });
  const stPdf = stmt8.data?.statement_url ? await pdfStrings(stmt8.data.statement_url) : '';
  const dayFee20 = /\(Dibatalkan [-—] biaya pembatalan 20%\)/;
  check('Q14 [B7, A3] invoice and statement PDFs print the cancelled day as "(Dibatalkan — biaya pembatalan 20%)"; statement total 1.200.000',
    dayFee20.test(dpPdf) && dayFee20.test(stPdf) && Number(stmt8.data?.final_price) === 1200000,
    `dp ${dayFee20.test(dpPdf)} statement ${dayFee20.test(stPdf)} ${stmt8.data?.final_price} | ${(/Dibatalkan.{0,40}/.exec(dpPdf) ?? [''])[0]}`);
  const o9 = await makeOrder('Q15', { days: 2, startDay: 29 });
  const dp9 = (await invoice(o9.id, 'DP', 400_000)).data;
  await markPaid(o9.id, dp9.id, { amount_received: 300_000, amount_mismatch_ack: true });
  const before9 = (await order(o9.id)).payment_status;
  await putLine(o9.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q15' });
  // A3: after the cancel the base is 1.200.000 (the day's 20% fee stays), min 240.000.
  check('Q15 [B2/B7, A3] 300.000 received: UNPAID on 2 days (min 400.000), DP_PAID once a day is cancelled (min 240.000)',
    before9 === 'UNPAID' && (await order(o9.id)).payment_status === 'DP_PAID', `${before9} → ${(await order(o9.id)).payment_status}`);

  // B12: cancellation fees in whole rupiah.
  const o10 = await makeOrder('Q16', { price: 1_000_003, startDay: 30 });
  const c10 = await call('POST', `/orders/${o10.id}/cancel`, { token: admin, body: { reason: 'tes pembulatan' } });
  const fee10 = (await order(o10.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  check('Q16 [B12] 20% of 1.000.003 billed as 200.001 (whole rupiah), fee invoice the same',
    c10.status === 200 && c10.data.penalty === 200001 && c10.data.stillOwed === 200001 && Number(fee10?.amount) === 200001 && Number((await order(o10.id)).cancellation_fee) === 200001,
    `${JSON.stringify(c10.data ?? c10.json)} ${fee10?.amount}`);

  // B2 after a cancellation: the fee is what is owed, so it is also the DP base.
  const o11 = await makeOrder('Q17', { price: 5_000_000, startDay: 32 });
  const dp11 = (await invoice(o11.id, 'DP', 1_000_000)).data;
  await markPaid(o11.id, dp11.id, { amount_received: 50_000, amount_mismatch_ack: true });
  const c11 = await call('POST', `/orders/${o11.id}/cancel`, { token: admin, body: { reason: 'tes DP setelah batal' } });
  const o11a = await order(o11.id);
  check('Q17 [B2] 50.000 received on 5.000.000, cancelled before day H (fee 1.000.000): stays UNPAID (below 20% of the fee)',
    c11.status === 200 && c11.data.penalty === 1000000 && o11a.payment_status === 'UNPAID', `${c11.status} ${c11.data?.penalty} ${o11a.payment_status}`);
  const fee11 = o11a.invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE' && i.status === 'ISSUED');
  if (fee11) await markPaid(o11.id, fee11.id, { amount_received: 150_000, amount_mismatch_ack: true });
  const o11b = await order(o11.id);
  check('Q18 [B2] fee invoice 950.000 marked paid with 150.000: 200.000 received (20% of the fee) → DP_PAID',
    Number(fee11?.amount) === 950000 && Number(o11b.paid_to_date) === 200000 && o11b.payment_status === 'DP_PAID', `${fee11?.amount} ${o11b.paid_to_date} ${o11b.payment_status}`);
  // B7 on the documents of a cancelled order: a fee line, so the lines add up.
  const inv11 = fee11 ? await prisma.invoice.findUnique({ where: { id: fee11.id } }) : null;
  // A3: the fee is printed per day (finance design §8): the fee documents
  // list the day as "(Dibatalkan — biaya pembatalan 20%)" with its fee,
  // instead of one "Biaya Pembatalan - Tier 1" line for the whole order.
  const rc11 = inv11?.receipt_url ? await pdfStrings(inv11.receipt_url) : '';
  check('Q19 [B7, A3] kwitansi of the fee invoice: the per-day fee line at 20% ("Biaya pembatalan sewa …" / "(Dibatalkan — biaya pembatalan 20%)"), 1.000.000, no package notes',
    /(?:Biaya pembatalan sewa|\(Dibatalkan [-—] biaya pembatalan)[^%]{0,90}?\b20%/.test(rc11) && /1\.000\.000/.test(rc11) && !/Harga termasuk/.test(rc11),
    `day fee ${/Dibatalkan [-—] biaya pembatalan 20%/.test(rc11)} 1.000.000 ${/1\.000\.000/.test(rc11)} notes ${/Harga termasuk/.test(rc11)}`);
  const st11 = await call('POST', `/orders/${o11.id}/statement`, { token: admin, body: {} });
  const sp11 = st11.data?.statement_url ? await pdfStrings(st11.data.statement_url) : '';
  // A3: the fee sits on the day line, so no separate fee line (it would count twice).
  check('Q20 [B7, A3] statement of the cancelled order: the day as "(Dibatalkan — biaya pembatalan 20%)", no separate whole-order fee line, total 1.000.000, no package notes',
    /\(Dibatalkan [-—] biaya pembatalan 20%\)/.test(sp11) && !/Biaya Pembatalan - Tier/.test(sp11) && Number(st11.data?.final_price) === 1000000 && !/Harga termasuk/.test(sp11),
    `day ${/Dibatalkan [-—] biaya pembatalan 20%/.test(sp11)} fee line ${/Biaya Pembatalan - Tier/.test(sp11)} notes ${/Harga termasuk/.test(sp11)} ${st11.data?.final_price}`);

  // B1.1 in Edit Order only when the save removes a day, on the days as they
  // are inside its transaction: here the last open day finishes while the
  // save waits for the order lock, and the save removes nothing.
  const o12 = await makeOrder('Q21', { days: 2, startDay: 34 });
  const [e1, e2] = [...o12.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date)).map((l) => l.id);
  await prisma.orderServiceItem.update({ where: { id: e1 }, data: { line_status: 'DONE' } });
  const body12 = editBody(await order(o12.id));
  let save12;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${o12.id} FOR UPDATE`;
    await tx.orderServiceItem.update({ where: { id: e2 }, data: { line_status: 'DONE' } });
    save12 = call('PUT', `/orders/${o12.id}`, { token: admin, body: body12 });
    await sleep(1500);
  }, { timeout: 15000 });
  const r12 = await save12;
  check('Q21 [B1.1] Edit Order that removes no day saves (200) although the last open day finished meanwhile', r12.status === 200, `${r12.status} ${r12.json?.message ?? ''}`);

  // B1.3 compares with the total read under the order lock, not the one read
  // before it: here the save first sees an older, lower total.
  const o13 = await makeOrder('Q22', { days: 3, startDay: 36 });
  await invoice(o13.id, 'FULL', 3_000_000);
  await prisma.order.update({ where: { id: o13.id }, data: { final_price: 1_000_000 } });
  let save13;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${o13.id} FOR UPDATE`;
    await tx.order.update({ where: { id: o13.id }, data: { final_price: 3_000_000 } });
    save13 = putLine(o13.service_items[2].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q22' });
    await sleep(1500);
  }, { timeout: 15000 });
  const r13 = await save13;
  const o13a = await order(o13.id);
  check('Q22 [B1.3] a day cancelled below the issued invoice refused (409) against the total read under the lock; day and total unchanged',
    r13.status === 409 && /Rp 3\.000\.000/.test(r13.json?.message ?? '') && o13a.service_items.every((l) => l.line_status === 'SCHEDULED') && Number(o13a.final_price) === 3000000,
    `${r13.status} ${r13.json?.message ?? ''} ${o13a.final_price}`);

  // B7: the settlement is due on the first day that will run.
  const o14 = await makeOrder('Q23', { days: 2, startDay: 38 });
  const [g1, g2] = [...o14.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date));
  await putLine(g1.id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'tes Q23' });
  // A3: day 1's 20% fee stays in the total: 1.200.000, DP minimum 240.000.
  await invoice(o14.id, 'DP', 240_000);
  const st14 = await invoice(o14.id, 'SETTLEMENT', 960_000);
  const due14 = st14.data?.id ? (await prisma.invoice.findUnique({ where: { id: st14.data.id } }))?.due_date : null;
  check('Q23 [B7] settlement due on day 2 (day 1 cancelled), not on the cancelled day',
    st14.status === 201 && due14 != null && due14.getTime() === new Date(g2.service_date).getTime(), `${st14.status} ${due14?.toISOString()} vs ${g2.service_date}`);

  // Overtime % on documents: the published price list, not the working copy.
  const pubRes = await call('GET', '/public/prices');
  const pubPct = pubRes.status === 200 ? pubRes.data.extras.OVERTIME.percent : 10;
  const otRow = (await call('GET', '/prices', { token: admin })).data.extras.find((e) => e.code === 'OVERTIME');
  const draftPct = pubPct + 5;
  await call('PATCH', `/prices/extras/${otRow.id}`, { token: admin, body: { percent: draftPct } });
  const o15 = await makeOrder('Q24', { startDay: 40 });
  const dp15 = await invoice(o15.id, 'DP', 200_000);
  const dp15Pdf = dp15.data?.file_url ? await pdfText(dp15.data.file_url) : '';
  await call('PATCH', `/prices/extras/${otRow.id}`, { token: admin, body: { percent: otRow.percent } });
  const pct = (n) => `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n)}%`;
  check('Q24 invoice overtime % is the published one, not the unpublished edit',
    dp15Pdf.includes(`${pct(pubPct)} dari harga Full day`) && !dp15Pdf.includes(pct(draftPct)), `published ${pct(pubPct)} draft ${pct(draftPct)} found ${/[\d.,]+% dari harga Full day/.exec(dp15Pdf)?.[0]}`);

  // B12 (owner Q1): 10:00:00 WIB is already 100%, so the policy text says
  // "sebelum pukul 10.00 WIB", not "s.d." (which would include 10:00).
  const wa15 = dp15.data?.id
    ? await call('POST', `/orders/${o15.id}/invoice/${dp15.data.id}/send-whatsapp`, { token: admin, body: { target_phone: '081234567890' } })
    : { status: 0 };
  const caption15 = wa15.data?.message_text ?? '';
  // A3: the policy text is per day now (CANCELLATION_POLICY_TEXT, one place
  // in the API); it still says "sebelum pukul 10.00 WIB", never "s.d.".
  const dp15Flat = dp15.data?.file_url ? await pdfStrings(dp15.data.file_url) : '';
  const cap15Flat = caption15.replace(/\s+/g, ' ');
  check('Q25 [B12, A3] invoice PDF and WhatsApp caption carry the per-day policy ("Pembatalan dihitung per hari sewa", "hari sewa sebelum pukul 10.00 WIB", no "s.d. pukul 10.00")',
    /Pembatalan dihitung per hari sewa/.test(dp15Flat) && /hari sewa sebelum pukul 10\.00 WIB/.test(dp15Flat) && !/s\.d\. pukul 10/.test(dp15Flat) &&
    wa15.status === 201 && /Pembatalan dihitung per hari sewa/.test(cap15Flat) && /hari sewa sebelum pukul 10\.00 WIB/.test(cap15Flat) && !/s\.d\. pukul 10/.test(cap15Flat),
    `pdf ${/Pembatalan dihitung per hari sewa/.test(dp15Flat)}/${/hari sewa sebelum pukul 10\.00 WIB/.test(dp15Flat)} wa ${wa15.status} ${/Pembatalan dihitung per hari sewa/.test(cap15Flat)}/${/hari sewa sebelum pukul 10\.00 WIB/.test(cap15Flat)}`);
});

// ── R. Order money, lock order, client_ref, GA4 (finance package A1) ───────
// The parts of group R (finance design §11) that PR A1 covers: R22–R25, R33.
await section('R. Order money, saldo lebih, money received, refunds, locks, client_ref, GA4 (finance A1 + A2)', async () => {
  const dR = await makeDriver(50);
  const carR = await makeCar('Rush');
  const sen = (v) => Math.round(Number(v ?? 0) * 100);
  const cancel = (o, reason = 'R batal') => call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason } });
  // Answers a race may give: done, refused (409) or gone (404). Never a 500.
  const fine = (r) => [200, 201, 404, 409].includes(r.status);

  /** What must hold for one order after any interleaving (today's money rules). */
  async function moneyProblems(orderId) {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        service_items: true,
        adjustments: true,
        invoices: { include: { receipts: { orderBy: { created_at: 'asc' }, take: 1 } } },
      },
    });
    const bad = [];
    const money = o.invoices.filter((i) => i.status === 'PAID' || (i.status === 'CANCELLED' && i.paid_at));
    const received = money.reduce((s, i) => s + sen(i.receipts[0]?.amount ?? i.amount), 0);
    if (received !== sen(o.paid_to_date)) bad.push(`paid_to_date ${o.paid_to_date} ≠ receipts ${received / 100}`);
    const net = sen(o.paid_to_date) - (o.is_refunded ? sen(o.refund_amount) : 0);
    const total = sen(o.final_price);
    // A3: a cancelled day bills its own fee (dayBillable), charges stay billed.
    const dayBillable = o.service_items.reduce((s, l) => s + (l.line_status === 'CANCELLED' ? sen(l.cancel_fee) : sen(l.total_price)), 0);
    const charges = o.adjustments.filter((a) => a.is_billable).reduce((s, a) => s + sen(a.amount) * (a.quantity ?? 1), 0);
    let base;
    if (o.cancellation_fee != null && o.cancellation_rule !== 'DAY_V2') {
      // Legacy whole-order cancellation (ORDER_V1): the frozen fee.
      if (total !== sen(o.cancellation_fee)) bad.push(`total ${o.final_price} ≠ fee ${o.cancellation_fee}`);
      if (o.service_items.some((l) => l.line_status !== 'CANCELLED' && l.line_status !== 'DONE')) bad.push('a day still open after the cancel');
      if (o.invoices.some((i) => !['REVISED', 'CANCELLED'].includes(i.status) && i.invoice_type !== 'CANCELLATION_FEE')) bad.push('an invoice still active after the cancel');
      base = sen(o.cancellation_fee);
    } else if (o.cancellation_fee != null) {
      // A3 (DAY_V2): the total is computed from the days; the fee is Σ day
      // fees; only unpaid invoices are voided (a PAID one stays PAID).
      if (total !== dayBillable + charges) bad.push(`total ${o.final_price} ≠ days (done + fees) + charges ${(dayBillable + charges) / 100}`);
      const fees = o.service_items.filter((l) => l.line_status === 'CANCELLED').reduce((s, l) => s + sen(l.cancel_fee), 0);
      if (sen(o.cancellation_fee) !== fees) bad.push(`cancellation_fee ${o.cancellation_fee} ≠ Σ day fees ${fees / 100}`);
      if (o.service_items.some((l) => l.line_status !== 'CANCELLED' && l.line_status !== 'DONE')) bad.push('a day still open after the cancel');
      if (o.invoices.some((i) => ['DRAFT', 'ISSUED'].includes(i.status) && i.invoice_type !== 'CANCELLATION_FEE')) bad.push('an unpaid invoice still active after the cancel');
      base = dayBillable;
    } else {
      base = dayBillable;
      if (total !== base + charges) bad.push(`total ${o.final_price} ≠ days + charges ${(base + charges) / 100}`);
      if (o.service_items.some((l) => l.line_status === 'CANCELLED' && l.driver_id && !l.actual_start_at && !l.trip_started_at)) bad.push('a cancelled day that never started keeps its driver');
    }
    const minDp = Math.round((base / 100) * 0.2) * 100;
    const want = total > 0 && net >= total ? 'PAID' : net > 0 && net >= minDp ? 'DP_PAID' : 'UNPAID';
    if (o.payment_status !== want) bad.push(`payment_status ${o.payment_status}, rule says ${want}`);
    return bad;
  }

  // R22 (B9): one lock order. Before, cancelOrder locked order → days while
  // Edit Hari and the driver app lock day → order, and markInvoicePaid locked
  // invoice → order: a deadlock answered 500. Even rounds: both requests queue
  // behind a lock the test holds on the order row, so they meet inside their
  // transactions (cancel sent first, then the other one first). Odd rounds: no
  // held lock, the second request a little later each time.
  async function race(orderId, i, first, second) {
    if (i % 2 === 1) return Promise.all([first(), sleep((i % 5) * 60).then(second)]);
    let both;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
      const [a, b] = i % 4 === 0 ? [0, 40] : [40, 0];
      both = Promise.all([sleep(a).then(first), sleep(b).then(second)]);
      await sleep(1500);
    }, { timeout: 15000 });
    return both;
  }
  const races = { pay: {}, start: {}, edit: {}, payable: {} };
  // Invoice PDFs in the mock storage that belong to no invoice row (a fee PDF
  // left behind by a refused cancel).
  async function orphanPdfs(o) {
    const code = (await prisma.customer.findUnique({ where: { id: o.customer_id } })).code;
    const rows = new Set((await prisma.invoice.findMany({ where: { order: { customer_id: o.customer_id } }, select: { invoice_number: true } })).map((r) => r.invoice_number));
    return (await (await fetch(`${MOCK}/__objects`)).json())
      .map((k) => new RegExp(`/(INV-\\d+-${code}-\\d+)\\.pdf$`).exec(k)?.[1])
      .filter((n) => n && !rows.has(n));
  }
  const tally = (k, a, b) => (races[k][`${a.status}/${b.status}`] = (races[k][`${a.status}/${b.status}`] ?? 0) + 1);
  const bad22 = { pay: [], start: [], edit: [], payable: [] };
  for (let i = 0; i < 10; i++) {
    const oa = await makeOrder(`R22a${i}`, { startDay: 60 + i });
    const dpa = await invoice(oa.id, 'DP', 300_000);
    const [ca, pa] = await race(oa.id, i, () => cancel(oa), () => markPaid(oa.id, dpa.data.id));
    tally('pay', ca, pa);
    for (const r of [ca, pa]) if (!fine(r)) bad22.pay.push(`#${i} ${r.status} ${r.json?.message ?? ''}`);
    bad22.pay.push(...(await moneyProblems(oa.id)).map((m) => `#${i} ${m}`));
    // A refused cancel had already built its fee PDF: it must be deleted.
    bad22.pay.push(...(await orphanPdfs(oa)).map((n) => `#${i} fee PDF ${n} left without an invoice (cancel ${ca.status})`));

    const ob = await makeOrder(`R22b${i}`, { startDay: 80 + i });
    await payDp(ob, 300_000);
    const lb = ob.service_items[0].id;
    await putLine(lb, { is_external: false, driver_id: dR.id, car_id: carR.id, line_status: 'ASSIGNED' });
    await act(dR, lb, 'accept');
    const [cb, sb] = await race(ob.id, i, () => cancel(ob), () => act(dR, lb, 'start'));
    tally('start', cb, sb);
    for (const r of [cb, sb]) if (!fine(r)) bad22.start.push(`#${i} ${r.status} ${r.json?.message ?? ''}`);
    bad22.start.push(...(await moneyProblems(ob.id)).map((m) => `#${i} ${m}`));
    const dayB = await prisma.orderServiceItem.findUnique({ where: { id: lb } });
    if (cb.status === 200 && dayB.line_status !== 'CANCELLED') bad22.start.push(`#${i} cancelled order, day ${dayB.line_status}`);
    if (dayB.actual_start_at && dayB.driver_id !== dR.id) bad22.start.push(`#${i} a started day lost its driver`);

    const oc = await makeOrder(`R22c${i}`, { days: 2, startDay: 100 + 2 * i });
    await payDp(oc, 400_000);
    const [cc, ec] = await race(oc.id, i, () => cancel(oc), () => putLine(oc.service_items[1].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'R22c' }));
    tally('edit', cc, ec);
    for (const r of [cc, ec]) if (!fine(r)) bad22.edit.push(`#${i} ${r.status} ${r.json?.message ?? ''}`);
    bad22.edit.push(...(await moneyProblems(oc.id)).map((m) => `#${i} ${m}`));

    // Payable edits (Utang) locked payable → day → order before; cancel locks
    // day → order → payable.
    const od = await makeOrder(`R22d${i}`, { startDay: 140 + i });
    await payDp(od, 300_000);
    await putLine(od.service_items[0].id, { is_external: false, driver_id: dR.id, car_id: carR.id, line_status: 'ASSIGNED' });
    const pay = await prisma.payable.findFirst({ where: { service_item_id: od.service_items[0].id } });
    const [cd, ed] = await race(od.id, i, () => cancel(od), () =>
      call('PUT', `/payables/${pay?.id}`, { token: admin, body: { extras: [{ label: 'Bonus', amount: 25_000 }], keterangan: 'R22d' } }));
    tally('payable', cd, ed);
    if (!pay) bad22.payable.push(`#${i} no payable after assigning`);
    for (const r of [cd, ed]) if (!fine(r)) bad22.payable.push(`#${i} ${r.status} ${r.json?.message ?? ''}`);
    bad22.payable.push(...(await moneyProblems(od.id)).map((m) => `#${i} ${m}`));
  }
  const show = (k) => `${JSON.stringify(races[k])} ${bad22[k].slice(0, 3).join(' | ')}`;
  check('R22a [B9] cancel + "Tandai terbayar" at once, 10×: no 500, money consistent', bad22.pay.length === 0, show('pay'));
  check('R22b [B9] cancel + driver "Berangkat" at once, 10×: no 500, money and days consistent', bad22.start.length === 0, show('start'));
  check('R22c [B9] cancel + Edit Hari cancelling a day at once, 10×: no 500, money consistent', bad22.edit.length === 0, show('edit'));
  check('R22d [B9] cancel + editing the day\'s payable (Utang) at once, 10×: no 500, money consistent', bad22.payable.length === 0, show('payable'));
  check('R22e a cancel refused after its fee PDF was built leaves no PDF behind', bad22.pay.every((m) => !/fee PDF/.test(m)), bad22.pay.filter((m) => /fee PDF/.test(m)).slice(0, 3).join(' | '));

  // R23 (B8): client_ref on invoices.
  const gen = (o, body) => call('POST', `/orders/${o.id}/generate-invoice`, { token: admin, body: { payment_method: 'BANK_TRANSFER', ...body } });
  const seqOf = async (o) => (await prisma.customer.findUnique({ where: { id: o.customer_id } })).invoice_seq;
  const o23 = await makeOrder('R23');
  const ref23 = uuid();
  const body23 = { invoice_type: 'DP', amount: 300_000, client_ref: ref23 };
  const [g1, g2] = await Promise.all([gen(o23, body23), gen(o23, body23)]);
  const rows23 = await prisma.invoice.findMany({ where: { order_id: o23.id } });
  check('R23a same client_ref twice at once → one invoice (201 + 200, same number)',
    [g1.status, g2.status].sort().join() === '200,201' && rows23.length === 1 && g1.data?.invoice_number === g2.data?.invoice_number && g1.data?.id === rows23[0].id,
    `${g1.status}/${g2.status} rows ${rows23.length} ${g1.data?.invoice_number} ${g2.data?.invoice_number}`);
  const cust23 = await prisma.customer.findUnique({ where: { id: o23.customer_id } });
  const pdfs23 = (await (await fetch(`${MOCK}/__objects`)).json()).filter((k) => new RegExp(`/INV-\\d+-${cust23.code}-\\d+\\.pdf$`).test(k));
  check('R23b one total_billed (300.000) and one invoice PDF left in storage', Number(cust23.total_billed) === 300000 && pdfs23.length === 1, `${cust23.total_billed} ${pdfs23.join(',')}`);
  const seq23 = await seqOf(o23);
  const g3 = await gen(o23, body23);
  check('R23c a later resend → 200 with the same invoice, no new number reserved', g3.status === 200 && g3.data?.id === rows23[0].id && (await seqOf(o23)) === seq23, `${g3.status} seq ${seq23}`);
  const o23b = await makeOrder('R23d');
  const [x1, x2] = await Promise.all([
    gen(o23b, { invoice_type: 'DP', amount: 600_000, client_ref: uuid() }),
    gen(o23b, { invoice_type: 'DP', amount: 600_000, client_ref: uuid() }),
  ]);
  const rows23b = await prisma.invoice.findMany({ where: { order_id: o23b.id } });
  check('R23d two different refs that together pass the total, at once → one 201, one 409 (cap checked under the lock)',
    [x1.status, x2.status].sort().join() === '201,409' && rows23b.length === 1, `${x1.status}/${x2.status} rows ${rows23b.length}`);
  const other23 = await gen(o23b, body23);
  check('R23e a client_ref of another order → 409 (that reason), no invoice made',
    other23.status === 409 && /client_ref sudah dipakai untuk order lain/.test(other23.json?.message ?? '') && (await prisma.invoice.count({ where: { order_id: o23b.id } })) === rows23b.length,
    `${other23.status} ${other23.json?.message ?? ''}`);
  const rev = (o, inv, amount, client_ref) => call('POST', `/orders/${o.id}/invoice/${inv.id}/revise`, { token: admin, body: { amount, client_ref } });
  const rref = uuid();
  const [rv1, rv2] = await Promise.all([rev(o23, rows23[0], 350_000, rref), rev(o23, rows23[0], 350_000, rref)]);
  const rv3 = await rev(o23, rows23[0], 350_000, rref);
  const revs = await prisma.invoice.findMany({ where: { order_id: o23.id, parent_id: rows23[0].id } });
  check('R23f revise with the same client_ref twice at once, then again → one revision (201, 200, 200)',
    [rv1.status, rv2.status].sort().join() === '200,201' && rv3.status === 200 && revs.length === 1 && rv3.data?.id === revs[0].id,
    `${rv1.status}/${rv2.status}/${rv3.status} revisions ${revs.length}`);
  check('R23g total_billed follows the one revision (350.000)', Number((await prisma.customer.findUnique({ where: { id: o23.customer_id } })).total_billed) === 350000);
  const o23c = await makeOrder('R23h');
  const dp23c = await invoice(o23c.id, 'DP', 300_000);
  const [s1, s2] = await Promise.all([gen(o23c, { invoice_type: 'SETTLEMENT', amount: 700_000 }), rev(o23c, dp23c.data, 400_000, uuid())]);
  const billed23c = (await prisma.invoice.findMany({ where: { order_id: o23c.id, status: { notIn: ['REVISED', 'CANCELLED'] } } })).reduce((s, i) => s + Number(i.amount), 0);
  check('R23h settlement + raising the DP at once never bill past the total', billed23c <= 1_000_000 && [s1.status, s2.status].includes(409), `${s1.status}/${s2.status} billed ${billed23c}`);
  check('R23i without client_ref (older dashboards) still 201', (await gen(await makeOrder('R23i'), { invoice_type: 'DP', amount: 200_000 })).status === 201);

  // R24 (B8): client_ref on charges.
  const adj = (o, client_ref, amount = 150_000) =>
    call('POST', `/orders/${o.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'Overtime 2 jam', amount, ...(client_ref ? { client_ref } : {}) } });
  const o24 = await makeOrder('R24');
  const aref = uuid();
  const [a1, a2] = await Promise.all([adj(o24, aref), adj(o24, aref)]);
  const a3 = await adj(o24, aref);
  const rows24 = await prisma.orderAdjustment.findMany({ where: { order_id: o24.id } });
  const o24a = await order(o24.id);
  check('R24a same client_ref twice at once, then again → one charge (201, 200, 200), total 1.150.000',
    [a1.status, a2.status].sort().join() === '200,201' && a3.status === 200 && rows24.length === 1 && a3.data?.id === rows24[0].id && Number(o24a.final_price) === 1150000,
    `${a1.status}/${a2.status}/${a3.status} rows ${rows24.length} total ${o24a.final_price}`);
  check('R24b a charge client_ref of another order → 409', (await adj(await makeOrder('R24b'), aref)).status === 409);
  check('R24c without client_ref still 201', (await adj(o24, null, 50_000)).status === 201);
  await cancel(o24);
  check('R24d a resend after the order was cancelled → 200 with the same charge (no new one)', (await adj(o24, aref)).status === 200 && (await prisma.orderAdjustment.count({ where: { order_id: o24.id } })) === 2);

  // R25 (B12): GA4 through the mock collector (GA4_COLLECT_URL).
  const ga4 = async () => (await fetch(`${MOCK}/__ga4`)).json();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  async function gaLead() {
    const code = `ARS-${Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
    const cid = `${rnd()}.${rnd()}`;
    await fetch(`${BASE}/public/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://arasya-web.vercel.app' },
      body: JSON.stringify({ lead_code: code, name: `GA ${tag}`, trip_date: '2026-11-20', pickup_time: '08:00', pickup_location: 'Bogor', destination: 'Bandung', unit: 'Innova Reborn', passenger_count: 4, duration_key: 'return', ga_client_id: cid }),
    });
    return { ...(await prisma.webLead.findUnique({ where: { lead_code: code } })), cid };
  }
  const sentTo = async (lead) => (await ga4()).filter((e) => e.client_id === lead.cid);
  const l1 = await gaLead();
  const o25a = await makeOrder('R25a', { startDay: 5, extra: { web_lead_id: l1.id } });
  await payDp(o25a, 300_000);
  await sleep(800);
  const sent1 = await sentTo(l1);
  check('R25a control: a paid DP reports one purchase to the collector (value = order total)',
    sent1.length === 1 && sent1[0].events?.[0]?.name === 'purchase' && sent1[0].events[0].params.value === 1000000 && sent1[0].events[0].params.transaction_id === o25a.order_code,
    JSON.stringify(sent1).slice(0, 200));
  const l2 = await gaLead();
  const o25b = await makeOrder('R25b', { startDay: -1, extra: { web_lead_id: l2.id } });
  await cancel(o25b);
  const fee25 = (await order(o25b.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  const paid25 = fee25 ? await markPaid(o25b.id, fee25.id) : { status: 0 };
  await sleep(800);
  check('R25b paying the cancellation-fee invoice of a cancelled order sends no purchase',
    paid25.status === 200 && (await sentTo(l2)).length === 0 && !(await prisma.webLead.findUnique({ where: { id: l2.id } })).purchase_reported_at,
    `pay ${paid25.status}, sends ${(await sentTo(l2)).length}`);
  const o25c = await makeOrder('R25c', { startDay: 3 });
  await payDp(o25c, 300_000);
  await cancel(o25c);
  const l3 = await gaLead();
  const link = await call('POST', `/leads/${l3.id}/link`, { token: admin, body: { order_id: o25c.id } });
  await sleep(800);
  check('R25c linking a lead to a cancelled order that has money sends no purchase',
    link.status === 200 && (await order(o25c.id)).payment_status !== 'UNPAID' && (await sentTo(l3)).length === 0,
    `link ${link.status} ${link.json?.message ?? ''}, sends ${(await sentTo(l3)).length}`);

  // ── Finance A2 (finance design §11): saldo lebih, money received, refunds ──
  {
    const { inflateSync } = await import('node:zlib');
    const pdfText = async (url) => {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^.*\/object\/public\//, ''));
      const buf = Buffer.from(await (await fetch(`${MOCK}/__object?key=${encodeURIComponent(key)}`)).arrayBuffer());
      const raw = buf.toString('latin1');
      const parts = [raw];
      const re = /stream\r?\n/g;
      let m;
      while ((m = re.exec(raw))) {
        const end = raw.indexOf('endstream', m.index);
        if (end < 0) break;
        try { parts.push(inflateSync(buf.subarray(m.index + m[0].length, end)).toString('latin1')); } catch {}
      }
      return parts.join('\n').replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s/g, ''), 'hex').toString('latin1'));
    };
    const bill = (o, body) => call('POST', `/orders/${o.id}/generate-invoice`, { token: admin, body: { payment_method: 'BANK_TRANSFER', ...body } });
    const reviseA2 = (o, inv, body) => call('POST', `/orders/${o.id}/invoice/${inv.id}/revise`, { token: admin, body });
    const payAck = (o, inv, received) => markPaid(o.id, inv.id, { amount_received: received, amount_mismatch_ack: true });
    const charge = (o, amount) => call('POST', `/orders/${o.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'Overtime', amount } });
    const refundA2 = (o, amount, client_ref = uuid()) => {
      const f = new FormData();
      f.append('proof', jpeg(), 'r.jpg');
      f.append('amount', String(amount));
      f.append('client_ref', client_ref);
      return call('POST', `/orders/${o.id}/refunds`, { token: admin, form: f });
    };
    const markRefundedOld = (o, amount) => {
      const f = new FormData();
      f.append('proof', jpeg(), 'r.jpg');
      if (amount != null) f.append('amount', String(amount));
      return call('POST', `/orders/${o.id}/mark-refunded`, { token: admin, form: f });
    };
    const entries = (o) => prisma.orderCreditEntry.findMany({ where: { order_id: o.id }, orderBy: { created_at: 'asc' } });
    const ymd = (days) => wibIso(days, '12:00').slice(0, 10);
    const dash = async () => (await call('GET', `/analytics/dashboard-v2?date_from=${ymd(-1)}&date_to=${ymd(1)}`, { token: admin })).data;
    const d17 = await makeDriver(51);
    const car17 = await makeCar('Calya');

    // R12: the next invoice uses the saldo lebih; one the credit covers in
    // full is PAID at once with no cash and no GA4.
    const l12 = await gaLead();
    const o12 = await makeOrder('R12', { startDay: 7, extra: { web_lead_id: l12.id } });
    const full12 = (await bill(o12, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o12, full12, 1_200_000);
    await sleep(800);
    const ga12 = (await sentTo(l12)).length;
    await charge(o12, 150_000);
    const add12 = await bill(o12, { invoice_type: 'ADDITIONAL', amount: 150_000 });
    const o12a = await order(o12.id);
    const inv12 = await prisma.invoice.findUnique({ where: { id: add12.data?.id ?? '' }, include: { receipts: true } });
    check('R12a an additional charge of 150.000 on 200.000 saldo lebih: invoice PAID at once, cash 0, saldo lebih 150.000 used',
      add12.status === 201 && inv12?.status === 'PAID' && Number(inv12.amount) === 0 && Number(inv12.credit_applied) === 150000 &&
      Number(inv12.amount_received) === 0 && add12.data.gross === 150000,
      `${add12.status} ${add12.json?.message ?? ''} ${inv12?.status} ${inv12?.amount}/${inv12?.credit_applied}`);
    await sleep(800);
    check('R12b no money moved: paid_to_date 1.200.000, one kwitansi of 0, saldo lebih 50.000 (APPLIED −150.000), no second GA4 purchase',
      Number(o12a.paid_to_date) === 1200000 && inv12?.receipts.length === 1 && Number(inv12.receipts[0].amount) === 0 &&
      o12a.money.credit_balance === 50000 && o12a.payment_status === 'PAID' &&
      (await entries(o12)).some((e) => e.kind === 'APPLIED' && Number(e.amount) === -150000 && e.invoice_id === inv12.id) &&
      ga12 === 1 && (await sentTo(l12)).length === 1,
      `${o12a.paid_to_date} ${inv12?.receipts.length} ${o12a.money.credit_balance} ${o12a.payment_status} ga4 ${ga12}/${(await sentTo(l12)).length}`);
    const rc12 = inv12?.receipt_url ? await pdfText(inv12.receipt_url) : '';
    check('R12c [§8] its kwitansi says "Dibayar dari saldo lebih" and shows the SALDO LEBIH left',
      /Dibayar dari saldo lebih/.test(rc12) && /SALDO LEBIH/.test(rc12), `paid-from-credit ${/Dibayar dari saldo lebih/.test(rc12)} saldo ${/SALDO LEBIH/.test(rc12)}`);
    await charge(o12, 100_000);
    const add12b = await bill(o12, { invoice_type: 'ADDITIONAL', amount: 100_000 });
    const pdf12b = add12b.data?.file_url ? await pdfText(add12b.data.file_url) : '';
    check('R12d partly from saldo lebih: gross 100.000, 50.000 from credit, cash 50.000 asked; the invoice PDF prints "Dipotong dari saldo lebih"',
      add12b.status === 201 && add12b.data.status === 'ISSUED' && Number(add12b.data.amount) === 50000 && Number(add12b.data.credit_applied) === 50000 &&
      (await order(o12.id)).money.credit_balance === 0 && /Dipotong dari saldo lebih/.test(pdf12b),
      `${add12b.status} ${add12b.data?.amount}/${add12b.data?.credit_applied} pdf ${/Dipotong dari saldo lebih/.test(pdf12b)}`);
    const rev12 = await reviseA2(o12, add12b.data, { amount: 100_000, apply_credit: false });
    const o12c = await order(o12.id);
    check('R12e revising it without credit: the 50.000 comes back (UNAPPLIED), the revision asks 100.000 cash',
      rev12.status === 201 && Number(rev12.data.amount) === 100000 && Number(rev12.data.credit_applied) === 0 && o12c.money.credit_balance === 50000 &&
      (await entries(o12)).some((e) => e.kind === 'UNAPPLIED' && Number(e.amount) === 50000 && e.invoice_id === add12b.data.id),
      `${rev12.status} ${rev12.json?.message ?? ''} ${rev12.data?.amount} credit ${o12c.money.credit_balance}`);
    // Cancelling an order whose unpaid invoice used saldo lebih.
    const o12f = await makeOrder('R12f', { startDay: 9 });
    const dp12f = (await bill(o12f, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o12f, dp12f, 300_000);
    const st12f = await bill(o12f, { invoice_type: 'SETTLEMENT', amount: 700_000 });
    const c12f = await cancel(o12f);
    const o12fa = await order(o12f.id);
    check('R12f cancel (tier 1, fee 200.000, 300.000 kept) voids the settlement that used 100.000 saldo lebih: UNAPPLIED, refund due = saldo lebih 100.000, no fee invoice',
      Number(st12f.data?.credit_applied) === 100000 && c12f.status === 200 && c12f.data.refundDue === 100000 && o12fa.money.credit_balance === 100000 &&
      o12fa.money.covered === 200000 && !o12fa.invoices.some((i) => i.invoice_type === 'CANCELLATION_FEE') &&
      (await entries(o12f)).some((e) => e.kind === 'UNAPPLIED' && Number(e.amount) === 100000),
      `${st12f.data?.credit_applied} ${c12f.status} ${JSON.stringify(c12f.data)} credit ${o12fa.money.credit_balance}`);
    const o12g = await makeOrder('R12g', { startDay: -1 });
    const dp12g = (await bill(o12g, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o12g, dp12g, 300_000);
    await bill(o12g, { invoice_type: 'SETTLEMENT', amount: 700_000 });
    const c12g = await cancel(o12g);
    const o12ga = await order(o12g.id);
    const fee12g = o12ga.invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
    check('R12g cancel at 100% with 300.000 kept and 100.000 saldo lebih: the fee invoice asks 700.000 cash and uses the 100.000 credit; saldo lebih 0',
      c12g.status === 200 && c12g.data.stillOwed === 700000 && Number(fee12g?.amount) === 700000 && Number(fee12g?.credit_applied) === 100000 &&
      o12ga.money.credit_balance === 0 && o12ga.money.covered + o12ga.money.open_billed === o12ga.money.total,
      `${c12g.status} ${JSON.stringify(c12g.data)} fee ${fee12g?.amount}/${fee12g?.credit_applied} money ${JSON.stringify(o12ga.money)}`);

    // R13: apply_credit=false keeps the saldo lebih for a refund.
    const o13 = await makeOrder('R13', { startDay: 7 });
    const dp13 = (await bill(o13, { invoice_type: 'DP', amount: 300_000 })).data;
    await payAck(o13, dp13, 400_000);
    const st13 = await bill(o13, { invoice_type: 'SETTLEMENT', amount: 700_000, apply_credit: false });
    const o13a = await order(o13.id);
    check('R13 apply_credit=false: settlement asks the full 700.000, saldo lebih 100.000 kept, nothing more billable',
      st13.status === 201 && Number(st13.data.amount) === 700000 && Number(st13.data.credit_applied) === 0 &&
      o13a.money.credit_balance === 100000 && o13a.money.billable_remaining === 0,
      `${st13.status} ${st13.json?.message ?? ''} ${st13.data?.amount} credit ${o13a.money.credit_balance} billable ${o13a.money.billable_remaining}`);

    // R14: overpayment needs the acknowledgement.
    const o14 = await makeOrder('R14', { days: 3, price: 1_250_000, startDay: 10 });
    const dp14 = (await bill(o14, { invoice_type: 'DP', amount: 750_000 })).data;
    const noAck = await markPaid(o14.id, dp14.id, { amount_received: 800_000 });
    const dp14a = await prisma.invoice.findUnique({ where: { id: dp14.id } });
    check('R14a 800.000 on a 750.000 DP without the acknowledgement → 409 with both numbers and the effect; nothing recorded',
      noAck.status === 409 && noAck.json?.code === 'AMOUNT_MISMATCH' && noAck.json.invoice_amount === 750000 && noAck.json.amount_received === 800000 &&
      noAck.json.overpayment === 50000 && /Rp 800\.000/.test(noAck.json.message) && /Rp 750\.000/.test(noAck.json.message) && /saldo lebih/.test(noAck.json.message) &&
      dp14a.status === 'ISSUED' && (await prisma.receipt.count({ where: { invoice_id: dp14.id } })) === 0,
      `${noAck.status} ${JSON.stringify(noAck.json).slice(0, 300)}`);
    const ack14 = await markPaid(o14.id, dp14.id, { amount_received: 800_000, amount_mismatch_ack: true });
    const o14a = await order(o14.id);
    check('R14b with the acknowledgement: PAID, OVERPAYMENT 50.000 → saldo lebih 50.000, order DP_PAID; the response carries payment and order_money',
      ack14.status === 200 && ack14.data.status === 'PAID' && ack14.data.payment?.overpayment === 50000 && ack14.data.payment?.credit_added === 50000 &&
      ack14.data.order_money?.credit_balance === 50000 && o14a.payment_status === 'DP_PAID' &&
      (await entries(o14)).filter((e) => e.kind === 'OVERPAYMENT' && Number(e.amount) === 50000).length === 1,
      `${ack14.status} ${JSON.stringify(ack14.data?.payment)} ${o14a.payment_status}`);
    const st14 = await bill(o14, { invoice_type: 'SETTLEMENT', amount: o14a.money.billable_remaining });
    check('R14c the settlement (gross 3.000.000) asks 2.950.000 cash: the 50.000 saldo lebih is taken off by default',
      o14a.money.billable_remaining === 3000000 && st14.status === 201 && Number(st14.data.amount) === 2950000 && Number(st14.data.credit_applied) === 50000,
      `${o14a.money.billable_remaining} ${st14.status} ${st14.data?.amount}/${st14.data?.credit_applied}`);

    // R15: a double click on an overpaid payment.
    const o15 = await makeOrder('R15', { startDay: 7 });
    const full15 = (await bill(o15, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    const [p15a, p15b] = await Promise.all([payAck(o15, full15, 1_100_000), payAck(o15, full15, 1_100_000)]);
    const o15a = await order(o15.id);
    check('R15 overpaid "Tandai terbayar" twice at once: one receipt, one OVERPAYMENT, saldo lebih 100.000, paid_to_date 1.100.000',
      p15a.status === 200 && p15b.status === 200 && (await prisma.receipt.count({ where: { invoice_id: full15.id } })) === 1 &&
      (await entries(o15)).filter((e) => e.kind === 'OVERPAYMENT').length === 1 && o15a.money.credit_balance === 100000 && Number(o15a.paid_to_date) === 1100000,
      `${p15a.status}/${p15b.status} credit ${o15a.money.credit_balance} paid ${o15a.paid_to_date}`);

    // R16: an underpaid DP and its Invoice Penyesuaian.
    const o16 = await makeOrder('R16', { startDay: 8 });
    const dp16 = (await bill(o16, { invoice_type: 'DP', amount: 200_000 })).data;
    const pay16 = await payAck(o16, dp16, 150_000);
    const o16a = await order(o16.id);
    const dp16v = o16a.invoices.find((i) => i.id === dp16.id);
    check('R16a DP 200.000 paid with 150.000: invoice PAID with shortfall 50.000, order UNPAID, 850.000 billable again',
      pay16.data?.payment?.shortfall === 50000 && dp16v?.status === 'PAID' && dp16v.shortfall === 50000 && o16a.payment_status === 'UNPAID' &&
      o16a.money.billable_remaining === 850000,
      `${JSON.stringify(pay16.data?.payment)} ${o16a.payment_status} ${o16a.money.billable_remaining}`);
    const as16 = await putLine(o16.service_items[0].id, { is_external: false, driver_id: d17.id, car_id: car17.id });
    check('R16b driver refused while the DP is short (409, Rp 150.000 received vs Rp 200.000)',
      as16.status === 409 && /Rp 150\.000/.test(as16.json?.message ?? '') && /Rp 200\.000/.test(as16.json?.message ?? ''), as16.json?.message);
    const tooBig16 = await bill(o16, { invoice_type: 'ADJUSTMENT', amount: 60_000, adjusts_invoice_id: dp16.id });
    const noRef16 = await bill(o16, { invoice_type: 'ADJUSTMENT', amount: 50_000 });
    const full16 = await makeOrder('R16c', { startDay: 8 });
    const paid16c = (await bill(full16, { invoice_type: 'DP', amount: 200_000 })).data;
    await markPaid(full16.id, paid16c.id);
    const notShort16 = await bill(full16, { invoice_type: 'ADJUSTMENT', amount: 10_000, adjusts_invoice_id: paid16c.id });
    check('R16c an adjustment above the shortfall (409), without the invoice it adjusts (400), or for an invoice paid in full (409) is refused',
      tooBig16.status === 409 && tooBig16.json?.code === 'ADJUSTMENT_EXCEEDS_SHORTFALL' && tooBig16.json?.shortfall_remaining === 50000 &&
      noRef16.status === 400 && notShort16.status === 409 && notShort16.json?.code === 'NOT_UNDERPAID',
      `${tooBig16.status} ${tooBig16.json?.message ?? ''} | ${noRef16.status} | ${notShort16.status} ${notShort16.json?.message ?? ''}`);
    const adj16 = await bill(o16, { invoice_type: 'ADJUSTMENT', amount: 50_000, adjusts_invoice_id: dp16.id });
    const adj16pdf = adj16.data?.file_url ? await pdfText(adj16.data.file_url) : '';
    check('R16d the Invoice Penyesuaian of 50.000 (below the DP minimum) is accepted and names the DP it adjusts',
      adj16.status === 201 && adj16.data.invoice_type === 'ADJUSTMENT' && adj16.data.adjusts_invoice_id === dp16.id && Number(adj16.data.amount) === 50000 &&
      /Invoice Penyesuaian/.test(adj16pdf) && adj16pdf.includes(dp16.invoice_number),
      `${adj16.status} ${adj16.json?.message ?? ''} pdf ${/Invoice Penyesuaian/.test(adj16pdf)}`);
    await markPaid(o16.id, adj16.data.id);
    const as16b = await putLine(o16.service_items[0].id, { is_external: false, driver_id: d17.id, car_id: car17.id });
    check('R16e once it is paid: 200.000 received, DP_PAID, the driver is accepted',
      (await order(o16.id)).payment_status === 'DP_PAID' && as16b.status === 200, `${as16b.status} ${as16b.json?.message ?? ''}`);
    const rc16 = (await prisma.invoice.findUnique({ where: { id: dp16.id } }))?.receipt_url;
    const rc16t = rc16 ? await pdfText(rc16) : '';
    check('R16f [§8] the DP kwitansi says "Kekurangan Rp 50.000 (ditagih lewat invoice penyesuaian)"',
      /Kekurangan Rp 50\.000 \(ditagih lewat invoice penyesuaian\)/.test(rc16t), `found ${/Kekurangan/.test(rc16t)}`);

    // R17: a FULL invoice paid short keeps "Mulai perjalanan" locked until the adjustment is paid.
    const o17 = await makeOrder('R17', { startDay: 0 });
    const full17 = (await bill(o17, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o17, full17, 950_000);
    const l17 = o17.service_items[0].id;
    await putLine(l17, { is_external: false, driver_id: d17.id, car_id: car17.id, line_status: 'ASSIGNED' });
    await act(d17, l17, 'start');
    await act(d17, l17, 'arrive', { latitude: -6.56, longitude: 106.8, location_accuracy_m: 12, location_mocked: false });
    const board17 = await act(d17, l17, 'board');
    const adj17 = (await bill(o17, { invoice_type: 'ADJUSTMENT', amount: 50_000, adjusts_invoice_id: full17.id })).data;
    await markPaid(o17.id, adj17.id);
    await sleep(800);
    const board17b = await act(d17, l17, 'board');
    const code17 = (await order(o17.id)).order_code;
    const lunas17 = (await pushesTo(d17)).filter((x) => x.title.includes(code17) && /sudah lunas/.test(x.title));
    check('R17 FULL 1.000.000 paid with 950.000: "Mulai perjalanan" 409; after the 50.000 adjustment is paid: 200 and one "sudah lunas" push',
      board17.status === 409 && board17b.status === 200 && lunas17.length === 1, `${board17.status} ${board17b.status} ${board17b.json?.message ?? ''} pushes ${lunas17.length}`);

    // R18: refunds, bounded by the saldo lebih.
    const o18 = await makeOrder('R18', { startDay: 7 });
    const full18 = (await bill(o18, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o18, full18, 1_300_000);
    const cash0 = await dash();
    const ref18 = uuid();
    const r18a = await refundA2(o18, 100_000, ref18);
    const cash1 = await dash();
    check('R18a a refund of 100.000 out of 300.000 saldo lebih → 201 with the refund, order_money and outstanding_after 0',
      r18a.status === 201 && Number(r18a.data.refund.amount) === 100000 && r18a.data.refund.has_proof === true && !('proof_url' in r18a.data.refund) &&
      r18a.data.order_money.credit_balance === 200000 && r18a.data.outstanding_after === 0,
      `${r18a.status} ${r18a.json?.message ?? ''} ${JSON.stringify(r18a.data?.order_money)}`);
    check('R18b Dashboard: cash.refunded +100.000 and net_cash −100.000, collected and piutang unchanged, customer_credit −100.000',
      cash1.cash.refunded - cash0.cash.refunded === 100000 && cash1.cash.net_cash - cash0.cash.net_cash === -100000 &&
      cash1.cash.collected === cash0.cash.collected && cash1.outstanding.ar_outstanding === cash0.outstanding.ar_outstanding &&
      cash1.outstanding.customer_credit - cash0.outstanding.customer_credit === -100000,
      `refunded ${cash1.cash.refunded - cash0.cash.refunded} net ${cash1.cash.net_cash - cash0.cash.net_cash} ar ${cash1.outstanding.ar_outstanding - cash0.outstanding.ar_outstanding} credit ${cash1.outstanding.customer_credit - cash0.outstanding.customer_credit}`);
    const r18c = await refundA2(o18, 50_000);
    const o18c = await order(o18.id);
    check('R18c a second refund (50.000) is its own row: two refunds, refunded_total 150.000, old refund_amount = the total, status PAID',
      r18c.status === 201 && o18c.refunds.length === 2 && Number(o18c.refunded_total) === 150000 && Number(o18c.refund_amount) === 150000 &&
      o18c.money.credit_balance === 150000 && o18c.payment_status === 'PAID',
      `${r18c.status} refunds ${o18c.refunds.length} ${o18c.refunded_total} ${o18c.refund_amount} ${o18c.payment_status}`);
    const r18d = await refundA2(o18, 200_000);
    check('R18d more than the saldo lebih (200.000 > 150.000) → 409 "Saldo lebih tinggal Rp 150.000"',
      r18d.status === 409 && r18d.json?.code === 'REFUND_EXCEEDS_CREDIT' && /Saldo lebih tinggal Rp 150\.000/.test(r18d.json?.message ?? ''), `${r18d.status} ${r18d.json?.message ?? ''}`);
    const r18e = await refundA2(o18, 100_000, ref18);
    check('R18e the same client_ref again → 200 with the first refund, nothing deducted twice',
      r18e.status === 200 && r18e.data.refund.id === r18a.data.refund.id && Number((await order(o18.id)).refunded_total) === 150000, `${r18e.status}`);
    const [r18f1, r18f2] = await Promise.all([refundA2(o18, 100_000), refundA2(o18, 100_000)]);
    const o18f = await order(o18.id);
    check('R18f two refunds of 100.000 at once with 150.000 left: one 201, one 409; saldo lebih 50.000',
      [r18f1.status, r18f2.status].sort().join() === '201,409' && o18f.money.credit_balance === 50000 && o18f.refunds.length === 3,
      `${r18f1.status}/${r18f2.status} credit ${o18f.money.credit_balance}`);
    const proof18 = await call('GET', `/orders/${o18.id}/refunds/${r18a.data.refund.id}/proof`, { token: admin });
    const proofOther = await call('GET', `/orders/${o13.id}/refunds/${r18a.data.refund.id}/proof`, { token: admin });
    check('R18g a refund proof is a fresh 5-minute signed URL; through another order → 404',
      proof18.status === 200 && /token=/.test(proof18.data?.url ?? '') && proof18.data.expires_in === 300 && proofOther.status === 404,
      `${proof18.status} ${proofOther.status}`);
    const st18 = await call('POST', `/orders/${o18.id}/statement`, { token: admin, body: {} });
    const st18t = st18.data?.statement_url ? await pdfText(st18.data.statement_url) : '';
    check('R18h [§8] statement: received 1.300.000, refunded 250.000, saldo lebih 50.000; refund lines "Pengembalian dana tanggal …" and the SALDO LEBIH row',
      st18.status === 200 && st18.data.total_received === 1300000 && st18.data.total_refunded === 250000 && st18.data.credit_balance === 50000 &&
      st18.data.remaining_balance === 0 && (st18t.match(/Pengembalian dana tanggal/g) ?? []).length === 3 && /SALDO LEBIH/.test(st18t) && /DIKEMBALIKAN/.test(st18t),
      `${JSON.stringify(st18.data ?? st18.json).slice(0, 200)} lines ${(st18t.match(/Pengembalian dana tanggal/g) ?? []).length}`);

    // R19 + R21: refunding a prepayment credit raises piutang and closes the trip again.
    const o19 = await makeOrder('R19', { startDay: 7 });
    const dp19 = (await bill(o19, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o19, dp19, 1_000_000);
    const o19a = await order(o19.id);
    const ar0 = (await dash()).outstanding.ar_outstanding;
    const r19 = await refundA2(o19, 800_000);
    const o19b = await order(o19.id);
    const ar1 = (await dash()).outstanding.ar_outstanding;
    check('R19 DP 200.000 paid with 1.000.000 (PAID, start ready), the 800.000 saldo lebih refunded: outstanding_after 800.000, DP_PAID, piutang +800.000',
      o19a.payment_status === 'PAID' && o19a.money.start_ready === true && r19.status === 201 && r19.data.outstanding_after === 800000 &&
      o19b.payment_status === 'DP_PAID' && o19b.money.outstanding === 800000 && ar1 - ar0 === 800000,
      `${o19a.payment_status} ${r19.status} ${r19.data?.outstanding_after} ${o19b.payment_status} ar ${ar1 - ar0}`);
    check('R21a start_ready uses Net: 1.000.000 received but 200.000 kept → start_ready false (start_payment too, paid_to_date = Net)',
      o19b.money.start_ready === false && o19b.start_payment.ready === false && o19b.start_payment.paid_to_date === 200000 && Number(o19b.paid_to_date) === 1000000,
      `${o19b.money.start_ready} ${JSON.stringify(o19b.start_payment)}`);
    const o21 = await makeOrder('R21', { startDay: 7 });
    const full21 = (await bill(o21, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o21, full21, 1_200_000);
    await refundA2(o21, 200_000);
    const o21a = await order(o21.id);
    check('R21b refunding only the excess keeps it ready: Net 1.000.000 = the rental price, PAID, start_ready true',
      o21a.money.net_paid === 1000000 && o21a.payment_status === 'PAID' && o21a.money.start_ready === true && o21a.start_payment.ready === true,
      `${o21a.money.net_paid} ${o21a.payment_status} ${o21a.money.start_ready}`);

    // R20: the old endpoint is a bounded alias.
    const o20 = await makeOrder('R20', { startDay: 7 });
    const full20 = (await bill(o20, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o20, full20, 1_100_000);
    const r20a = await markRefundedOld(o20, 150_000);
    const r20b = await markRefundedOld(o20);
    const r20c = await markRefundedOld(o20);
    const o20a = await order(o20.id);
    check('R20 mark-refunded (alias): 150.000 > saldo lebih 100.000 → 409; without an amount → the whole 100.000 (200, the order as before); again → 400',
      r20a.status === 409 && r20b.status === 200 && Number(r20b.data.refund_amount) === 100000 && r20c.status === 400 &&
      o20a.refunds.length === 1 && o20a.money.credit_balance === 0,
      `${r20a.status} ${r20b.status} ${r20b.data?.refund_amount} ${r20c.status} refunds ${o20a.refunds.length}`);

    // R32 (B6): money.billable_remaining is exactly what an invoice may cover.
    const o32 = await makeOrder('R32', { startDay: 7 });
    const dp32 = (await bill(o32, { invoice_type: 'DP', amount: 300_000 })).data;
    await payAck(o32, dp32, 350_000);
    const m32 = (await order(o32.id)).money;
    const over32 = await bill(o32, { invoice_type: 'SETTLEMENT', amount: m32.billable_remaining + 1 });
    const ok32 = await bill(o32, { invoice_type: 'SETTLEMENT', amount: m32.billable_remaining });
    check('R32 [B6] billable_remaining 700.000: +1 → 409 BILLABLE_EXCEEDED (with billable_remaining), exactly 700.000 → 201 asking 650.000 (50.000 saldo lebih)',
      m32.billable_remaining === 700000 && over32.status === 409 && over32.json?.code === 'BILLABLE_EXCEEDED' && over32.json?.billable_remaining === 700000 &&
      ok32.status === 201 && Number(ok32.data.amount) === 650000 && (await order(o32.id)).money.billable_remaining === 0,
      `${m32.billable_remaining} ${over32.status} ${ok32.status} ${ok32.data?.amount}`);

    // ── Review of PR #8 (S1, S2, nits): reviewer probes P3, P5, P16, P17, P19 ──
    // S1 (P16): revising an invoice that used saldo lebih. `amount` is the
    // gross; an older dashboard sends the cash it shows, so without an
    // explicit apply_credit the API refuses instead of taking the credit twice.
    const o34 = await makeOrder('R34', { startDay: 7 });
    const f34 = (await bill(o34, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o34, f34, 1_100_000);
    await charge(o34, 300_000);
    const a34 = (await bill(o34, { invoice_type: 'ADDITIONAL', amount: 300_000 })).data;
    const old34 = await reviseA2(o34, a34, { amount: Number(a34.amount), note: 'ganti catatan' });
    const a34st = (await prisma.invoice.findUnique({ where: { id: a34.id } })).status;
    check('R34a [S1] revising an invoice that used saldo lebih without apply_credit (older dashboard: amount = the cash shown) → 409, nothing changed',
      Number(a34.amount) === 200000 && Number(a34.credit_applied) === 100000 && old34.status === 409 && old34.json?.code === 'REVISE_NEEDS_APPLY_CREDIT' &&
      old34.json.gross === 300000 && old34.json.credit_applied === 100000 && old34.json.amount === 200000 && a34st === 'ISSUED' &&
      (await order(o34.id)).money.credit_balance === 0,
      `${old34.status} ${JSON.stringify(old34.json).slice(0, 240)} ${a34st}`);
    const keep34 = await reviseA2(o34, a34, { amount: 300_000, apply_credit: true });
    const m34a = (await order(o34.id)).money;
    check('R34b with apply_credit=true and the gross (300.000): the credit comes back and is used again → cash 200.000, saldo lebih 0',
      keep34.status === 201 && Number(keep34.data.amount) === 200000 && Number(keep34.data.credit_applied) === 100000 && keep34.data.gross === 300000 && m34a.credit_balance === 0,
      `${keep34.status} ${keep34.json?.message ?? ''} ${keep34.data?.amount}/${keep34.data?.credit_applied} credit ${m34a.credit_balance}`);
    const drop34 = await reviseA2(o34, keep34.data, { amount: 300_000, apply_credit: false });
    const m34b = (await order(o34.id)).money;
    check('R34c with apply_credit=false: cash 300.000, the 100.000 stays saldo lebih',
      drop34.status === 201 && Number(drop34.data.amount) === 300000 && Number(drop34.data.credit_applied) === 0 && m34b.credit_balance === 100000,
      `${drop34.status} ${drop34.data?.amount}/${drop34.data?.credit_applied} credit ${m34b.credit_balance}`);
    const def34 = await reviseA2(o34, drop34.data, { amount: 300_000 });
    check('R34d an invoice that used no credit is revised as before: without apply_credit the saldo lebih is applied by default (cash 200.000)',
      def34.status === 201 && Number(def34.data.amount) === 200000 && Number(def34.data.credit_applied) === 100000 && (await order(o34.id)).money.credit_balance === 0,
      `${def34.status} ${def34.json?.message ?? ''} ${def34.data?.amount}/${def34.data?.credit_applied}`);

    // Nit 3: a revised fee invoice PDF prints what THIS invoice covers and asks.
    const fee34 = (await order(o12g.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE' && i.status === 'ISSUED');
    const rfee34 = fee34 ? await reviseA2(o12g, fee34, { amount: 800_000, apply_credit: true }) : { status: 0 };
    const rfee34t = rfee34.data?.file_url ? await pdfText(rfee34.data.file_url) : '';
    check('R34e a revised cancellation-fee invoice (gross 800.000, 100.000 saldo lebih) prints SUBTOTAL Rp 800.000, "Dipotong dari saldo lebih" and TOTAL Rp 700.000',
      rfee34.status === 201 && Number(rfee34.data.amount) === 700000 && /Rp 800\.000/.test(rfee34t) && /Dipotong dari saldo lebih/.test(rfee34t) && /Rp 700\.000/.test(rfee34t),
      `${rfee34.status} ${rfee34.json?.message ?? ''} ${rfee34.data?.amount} 800 ${/Rp 800\.000/.test(rfee34t)} credit ${/Dipotong dari saldo lebih/.test(rfee34t)} 700 ${/Rp 700\.000/.test(rfee34t)}`);

    // S2 (P17): the settlement caption quotes the DP actually received.
    const o35 = await makeOrder('R35', { startDay: 7 });
    const dp35 = (await bill(o35, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o35, dp35, 150_000);
    // The settlement bills the rental rest (800.000); the 50.000 short stays billable.
    const st35 = (await bill(o35, { invoice_type: 'SETTLEMENT', amount: 800_000 })).data;
    const wa35 = await call('POST', `/orders/${o35.id}/invoice/${st35.id}/send-whatsapp`, { token: admin, body: { target_phone: '081234567890' } });
    const cap35 = wa35.data?.message_text ?? '';
    const adj35 = (await bill(o35, { invoice_type: 'ADJUSTMENT', amount: 50_000, adjusts_invoice_id: dp35.id })).data;
    await markPaid(o35.id, adj35.id);
    const wa35b = await call('POST', `/orders/${o35.id}/invoice/${st35.id}/send-whatsapp`, { token: admin, body: { target_phone: '081234567890' } });
    const cap35b = wa35b.data?.message_text ?? '';
    check('R35 [S2] settlement caption: "DP senilai Rp 150.000" after a DP paid short; Rp 200.000 once its Invoice Penyesuaian is paid',
      /DP senilai \*Rp 150\.000\*/.test(cap35) && /DP senilai \*Rp 200\.000\*/.test(cap35b),
      `${(/DP senilai[^\n]*/.exec(cap35) ?? [''])[0]} | ${(/DP senilai[^\n]*/.exec(cap35b) ?? [''])[0]}`);

    // Nit 1 (P5): an invoice saldo lebih pays, issued with a back-dated date,
    // is paid now: its kwitansi counts the payments made before it.
    const o36 = await makeOrder('R36', { startDay: 7 });
    const f36 = (await bill(o36, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    await payAck(o36, f36, 1_200_000);
    await charge(o36, 150_000);
    const add36 = await bill(o36, { invoice_type: 'ADDITIONAL', amount: 150_000, issue_date: new Date(Date.now() - 2 * 86400000).toISOString() });
    const inv36 = await prisma.invoice.findUnique({ where: { id: add36.data?.id ?? '' }, include: { receipts: true } });
    const t36 = inv36?.receipt_url ? await pdfText(inv36.receipt_url) : '';
    check('R36 [nit 1] back-dated invoice paid from saldo lebih: paid_at = now (not the issue date), kwitansi counts the 1.200.000 received (no "DP DITERIMA" stamp)',
      add36.status === 201 && inv36?.status === 'PAID' && Math.abs(inv36.paid_at.getTime() - Date.now()) < 120e3 &&
      Math.abs(inv36.receipts[0].payment_date.getTime() - Date.now()) < 120e3 && /1\.200\.000/.test(t36) && !/DP DITERIMA/.test(t36),
      `${add36.status} paid_at ${inv36?.paid_at?.toISOString()} 1.200.000 ${/1\.200\.000/.test(t36)} stamp ${/DP DITERIMA/.test(t36)}`);

    // Nit 4 (P19): SALDO LEBIH on a kwitansi only once nothing is owed.
    const o37 = await makeOrder('R37', { startDay: 7 });
    const dp37 = (await bill(o37, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o37, dp37, 250_000);
    const t37 = await pdfText((await prisma.invoice.findUnique({ where: { id: dp37.id } })).receipt_url);
    check('R37 [nit 4] DP 200.000 paid with 250.000 (750.000 still owed): the kwitansi says "Masuk saldo lebih" but shows no SALDO LEBIH row next to SISA TAGIHAN',
      /SISA TAGIHAN/.test(t37) && /750\.000/.test(t37) && /Masuk saldo lebih/.test(t37) && !/SALDO LEBIH/.test(t37),
      `sisa ${/SISA TAGIHAN/.test(t37)} 750 ${/750\.000/.test(t37)} masuk ${/Masuk saldo lebih/.test(t37)} row ${/SALDO LEBIH/.test(t37)}`);

    // Nit 5: whole rupiah only.
    const o38 = await makeOrder('R38', { startDay: 7 });
    const f38 = (await bill(o38, { invoice_type: 'FULL', amount: 1_000_000 })).data;
    const frac38 = await markPaid(o38.id, f38.id, { amount_received: '1000000.50', amount_mismatch_ack: true });
    await payAck(o38, f38, 1_100_000);
    const frac38r = await refundA2(o38, '50000.5');
    const noRef38 = (() => {
      const f = new FormData();
      f.append('proof', jpeg(), 'r.jpg');
      f.append('amount', '50000');
      return call('POST', `/orders/${o38.id}/refunds`, { token: admin, form: f });
    })();
    const noRef38r = await noRef38;
    check('R38 [nit 5, nit 6] amount_received or a refund with sen (1.000.000,50 / 50.000,5) → 400; /refunds without client_ref → 400; nothing recorded',
      frac38.status === 400 && frac38r.status === 400 && noRef38r.status === 400 && (await order(o38.id)).refunds.length === 0 &&
      (await prisma.receipt.count({ where: { invoice_id: f38.id } })) === 1,
      `${frac38.status} ${frac38r.status} ${noRef38r.status}`);

    // Nit 2: the same refund sent twice at once leaves one refund and one proof file.
    const sameRef39 = uuid();
    const [r39a, r39b] = await Promise.all([refundA2(o38, 40_000, sameRef39), refundA2(o38, 40_000, sameRef39)]);
    await sleep(500);
    const proofs39 = (await (await fetch(`${MOCK}/__objects`)).json()).filter((k) => k.includes(`refunds/${o38.id}/`));
    check('R39 [nit 2] the same refund client_ref twice at once: one refund (201 + 200), one proof file left in storage',
      [r39a.status, r39b.status].sort().join() === '200,201' && (await order(o38.id)).refunds.length === 1 && proofs39.length === 1,
      `${r39a.status}/${r39b.status} proofs ${proofs39.length}`);

    // Nit 6 (P3): cancel where the money kept covers what is owed but part of
    // it is saldo lebih: the credit is used without an invoice.
    // A3: the fee is 20% of the day only (200.000) and the 500.000 charge
    // stays billed, so the total after the cancel is 700.000 (the old
    // whole-order rule: 20% of 1.500.000 = 300.000). The DP is paid with
    // 750.000 (was 350.000) so the money kept still covers it, as before.
    const o40 = await makeOrder('R40', { startDay: 7 });
    await charge(o40, 500_000);
    const dp40 = (await bill(o40, { invoice_type: 'DP', amount: 200_000 })).data;
    await payAck(o40, dp40, 750_000);
    const c40 = await cancel(o40);
    const o40a = await order(o40.id);
    const e40 = await entries(o40);
    check('R40 [P3, A3] day 1.000.000 + charge 500.000; fee 200.000 (the charge stays billed) → total 700.000; 750.000 kept of which 550.000 saldo lebih: APPLIED 500.000 without an invoice, refund due = saldo lebih 50.000, covered = total, PAID',
      c40.status === 200 && c40.data.penalty === 200000 && c40.data.newTotal === 700000 && c40.data.refundDue === 50000 && c40.data.cancellationInvoiceNumber === null &&
      o40a.money.credit_balance === 50000 && o40a.money.covered === 700000 && o40a.money.total === 700000 && o40a.payment_status === 'PAID' &&
      e40.some((e) => e.kind === 'APPLIED' && Number(e.amount) === -500000 && e.invoice_id === null),
      `${c40.status} ${JSON.stringify(c40.data)} ${o40a.money.credit_balance}/${o40a.money.covered} ${e40.map((e) => `${e.kind} ${e.amount}`).join(', ')}`);

    // Nit 6: the B1.3 baseline on an underpaid order and on one with open credit.
    const o41 = await makeOrder('R41', { days: 3, startDay: 12 });
    const f41 = (await bill(o41, { invoice_type: 'FULL', amount: 3_000_000 })).data;
    await payAck(o41, f41, 1_800_000);
    const days41 = [...o41.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date));
    const eh41 = await putLine(days41[2].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'R41' });
    const o41a = await order(o41.id);
    // A3: the cancelled day keeps its 20% fee: total 2.000.000 + 200.000.
    check('R41a [B1.3 v3, A3] FULL 3.000.000 paid with 1.800.000: Edit Hari cancels a day (total 2.200.000 ≥ 1.800.000 covered; the old rule counted the 3.000.000 invoice)',
      eh41.status === 200 && o41a.money.total === 2200000, `${eh41.status} ${eh41.json?.message ?? ''} ${o41a.money.total}`);
    const lower41 = await call('PUT', `/orders/${o41.id}`, { token: admin, body: editBody(o41a, { reason: 'diskon', days: o41a.service_items.map((l) => ({ id: l.id, ...(l.id === days41[1].id ? { unit_price: 500_000 } : {}) })) }) });
    const o41b = await order(o41.id);
    const rel41 = (await entries(o41)).filter((e) => e.kind === 'RELEASE');
    const ok41 = await call('PUT', `/orders/${o41.id}`, { token: admin, body: editBody(o41a, { reason: 'diskon', days: o41a.service_items.map((l) => ({ id: l.id, ...(l.id === days41[1].id ? { unit_price: 900_000 } : {}) })) }) });
    // A3: both totals include the cancelled day's 200.000 fee. Lowering a
    // price on a paid order is no longer refused (design §3.1, INV-6): with
    // no unpaid invoice the money beyond the new total becomes saldo lebih
    // (RELEASE 100.000). The refusal for an unpaid invoice asking more than
    // is owed is checked in R31a, R42 and Q6.
    check('R41b [A3] Edit Order: a price that takes the total to 1.700.000 (< 1.800.000 paid) → 200 and RELEASE 100.000 (saldo lebih); then to 2.100.000 → 200',
      lower41.status === 200 && o41b.money.total === 1700000 && o41b.money.credit_balance === 100000 && rel41.length === 1 && Number(rel41[0].amount) === 100000 &&
      ok41.status === 200 && (await order(o41.id)).money.total === 2100000,
      `${lower41.status} ${lower41.json?.message ?? ''} total ${o41b.money.total} credit ${o41b.money.credit_balance} rel ${rel41.map((e) => e.amount).join(',')} | ${ok41.status} ${ok41.json?.message ?? ''}`);
    const o42 = await makeOrder('R42', { days: 3, startDay: 16 });
    const dp42 = (await bill(o42, { invoice_type: 'DP', amount: 600_000 })).data;
    await payAck(o42, dp42, 1_000_000);
    const st42 = (await bill(o42, { invoice_type: 'SETTLEMENT', amount: 2_400_000 })).data;
    const days42 = [...o42.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date));
    const eh42 = await putLine(days42[2].id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'R42' });
    // A3 (INV-6): the cancelled day keeps its 200.000 fee: total 2.200.000,
    // covered 1.000.000, so the unpaid settlement may ask at most 1.200.000;
    // it asks 2.000.000. The message names the total, the open amount and the
    // most it may ask (was: 2.000.000 total vs covered + open 3.000.000).
    check('R42 [B1.3 v3 → INV-6, A3] DP 600.000 paid with 1.000.000 and the settlement (gross 2.400.000, cash 2.000.000) open: cancelling a day (total 2.200.000, at most 1.200.000 may stay open; the 400.000 credit is now used) → 409 OPEN_INVOICE_EXCEEDS with the amounts',
      Number(st42.amount) === 2000000 && Number(st42.credit_applied) === 400000 && eh42.status === 409 && eh42.json?.code === 'OPEN_INVOICE_EXCEEDS' &&
      eh42.json.new_total === 2200000 && eh42.json.covered === 1000000 && eh42.json.open_billed === 2000000 && eh42.json.max_open_billed === 1200000 &&
      /Rp 2\.200\.000/.test(eh42.json?.message ?? '') && /Rp 2\.000\.000/.test(eh42.json?.message ?? '') && /Rp 1\.200\.000/.test(eh42.json?.message ?? ''),
      `${st42.amount}/${st42.credit_applied} ${eh42.status} ${JSON.stringify(eh42.json).slice(0, 300)}`);

    // The orders list carries the order-level money, so the dashboard shows
    // Diterima / Sisa without summing invoice amounts.
    const code18 = (await order(o18.id)).order_code;
    const list18 = await call('GET', `/orders/search?search=${encodeURIComponent(code18)}&bucket=ALL&page_size=10`, { token: admin });
    const item18 = (list18.json?.data ?? []).find((x) => x.id === o18.id);
    check('R43 /orders/search items carry paid_to_date, refunded_total and credit_balance (R18: 1.300.000 / 250.000 / 50.000)',
      list18.status === 200 && Number(item18?.paid_to_date) === 1300000 && Number(item18?.refunded_total) === 250000 && Number(item18?.credit_balance) === 50000,
      `${list18.status} ${item18 ? `${item18.paid_to_date}/${item18.refunded_total}/${item18.credit_balance}` : 'not found'}`);
  }

  // ── Finance A3 (finance design §3.1, §3.2, §11): the per-day cancellation fee ──
  // Days far ahead (tier 1 for certain), except R6, R7 and R31d, which use
  // today: their expected tier comes from the decision time the API reports
  // (like J7), so they pass at any hour. Inside its own try so the invariant
  // sweep (R33) below still runs when this block stops.
  try {
    const policy = createRequire(import.meta.url)('../../dist/src/modules/orders/cancellation-policy.js');
    const { dayCancellation, pctRupiah, computeCancellationPenalty } = policy;
    const num = (x) => (x == null ? null : Number(x));
    const byDate = (o) => [...o.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date));
    const cancelDay = (id, extra = {}) => putLine(id, { is_external: false, line_status: 'CANCELLED', cancel_reason: 'Pelanggan minta kurangi hari', ...extra });
    const qs = (requestedAt) => (requestedAt ? `?requested_at=${encodeURIComponent(requestedAt)}` : '');
    const lineQuote = (id, requestedAt) => call('GET', `/schedule/lines/${id}/cancel-quote${qs(requestedAt)}`, { token: admin });
    const orderQuote = (o, requestedAt) => call('GET', `/orders/${o.id}/cancel-quote${qs(requestedAt)}`, { token: admin });
    const cancelOrder = (o, body = {}) => call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'R A3 batal', ...body } });
    const day = (id) => prisma.orderServiceItem.findUnique({ where: { id } });
    const entriesOf = (o) => prisma.orderCreditEntry.findMany({ where: { order_id: o.id }, orderBy: { created_at: 'asc' } });
    const logsSince = (o, t) => prisma.orderChangeLog.findMany({ where: { order_id: o.id, created_at: { gte: new Date(t) } } });
    const logText = (logs) => logs.map((l) => [l.field, l.old_value, l.new_value, l.note].join(' ')).join(' || ');
    // Milliseconds since WIB midnight of an instant.
    const wibMsOfDay = (iso) => (new Date(iso).getTime() + 7 * 3600e3) % 86400e3;
    const wibClock = (iso) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(11, 23) : '?');
    const sameDays = (a, b) => {
      const key = (x) => JSON.stringify((x ?? []).map((d) => [d.id, d.tier, d.pct, d.fee]).sort());
      return Array.isArray(a) && Array.isArray(b) && key(a) === key(b);
    };

    // R1: a day cancelled in Edit Hari, 30 days ahead → tier 1.
    const o1 = await makeOrder('RA1', { days: 3, startDay: 30 });
    const [, , c1] = byDate(o1);
    const t1 = Date.now();
    const r1 = await cancelDay(c1.id, { cancel_reason: 'Pelanggan pulang sehari lebih awal' });
    const o1a = await order(o1.id);
    const c1a = o1a.service_items.find((l) => l.id === c1.id);
    check('R1a [A3] Edit Hari cancels day 3 (30 days ahead): tier 1, fee 20% = 200.000; the response carries cancellation and order_money (total 2.200.000)',
      r1.status === 200 && r1.data.cancellation?.tier === 1 && r1.data.cancellation?.pct === 20 && r1.data.cancellation?.fee === 200000 &&
      num(r1.data.cancel_fee) === 200000 && r1.data.cancel_tier === 1 && r1.data.order_money?.total === 2200000 && Number(o1a.final_price) === 2200000,
      `${r1.status} ${r1.json?.message ?? ''} ${JSON.stringify(r1.data?.cancellation)} total ${r1.data?.order_money?.total} / ${o1a.final_price}`);
    check('R1b the day (GET /orders/:id) stores cancel_fee, cancel_tier, cancelled_at (the save time) and cancel_reason; no cancel_requested_at',
      c1a?.line_status === 'CANCELLED' && num(c1a.cancel_fee) === 200000 && c1a.cancel_tier === 1 && c1a.cancel_reason === 'Pelanggan pulang sehari lebih awal' &&
      !!c1a.cancelled_at && Math.abs(new Date(c1a.cancelled_at).getTime() - t1) < 60e3 && c1a.cancel_requested_at == null,
      JSON.stringify({ s: c1a?.line_status, fee: c1a?.cancel_fee, tier: c1a?.cancel_tier, at: c1a?.cancelled_at, why: c1a?.cancel_reason, req: c1a?.cancel_requested_at }));
    const log1 = (await logsSince(o1, t1)).filter((l) => /Pelanggan pulang sehari lebih awal/.test([l.new_value, l.note].join(' ')));
    check('R1c the change log has one entry for the cancellation with the fee and the reason',
      log1.length === 1 && /200[.]?000/.test(logText(log1)), logText(await logsSince(o1, t1)).slice(0, 300));
    const r1d = await cancelDay(c1.id, { cancel_reason: 'kirim ulang' });
    const c1d = await day(c1.id);
    check('R1d a resend on the cancelled day is a no-op: 200, the first fee, reason and time kept, total 2.200.000, no second log',
      r1d.status === 200 && num(c1d.cancel_fee) === 200000 && c1d.cancel_tier === 1 && c1d.cancel_reason === 'Pelanggan pulang sehari lebih awal' &&
      c1d.cancelled_at?.getTime() === new Date(c1a?.cancelled_at).getTime() && Number((await order(o1.id)).final_price) === 2200000 &&
      !(await logsSince(o1, t1)).some((l) => /kirim ulang/.test([l.new_value, l.note].join(' '))),
      `${r1d.status} ${r1d.json?.message ?? ''} fee ${c1d.cancel_fee} why ${c1d.cancel_reason}`);

    // R2: the fee the admin saw differs from the server's → 409, nothing changed.
    const o2 = await makeOrder('RA2', { days: 3, startDay: 31 });
    const [a2, b2, c2] = byDate(o2);
    const t2 = Date.now();
    const r2 = await cancelDay(c2.id, { expected_cancel_fee: 123_456 });
    const c2a = await day(c2.id);
    check('R2 [A3] expected_cancel_fee 123.456 but the fee is 200.000 → 409 CANCEL_FEE_CHANGED with the current quote; day, total and log unchanged',
      r2.status === 409 && r2.json?.code === 'CANCEL_FEE_CHANGED' && r2.json.quote?.fee === 200000 && r2.json.quote?.tier === 1 && r2.json.quote?.new_total === 2200000 &&
      c2a.line_status === 'SCHEDULED' && c2a.cancel_fee == null && c2a.cancel_tier == null && c2a.cancelled_at == null &&
      Number((await order(o2.id)).final_price) === 3000000 && (await logsSince(o2, t2)).length === 0,
      `${r2.status} ${JSON.stringify(r2.json).slice(0, 300)} day ${c2a.line_status}/${c2a.cancel_fee}`);

    // R3: the line quote is what the save charges.
    const q3 = await lineQuote(b2.id);
    const r3 = await cancelDay(b2.id, { expected_cancel_fee: q3.data?.fee });
    const o3a = await order(o2.id);
    check('R3a [A3] line cancel-quote: tier 1, 20% of 1.000.000 = 200.000, not started, not blocked, new total 2.200.000, no credit released, 2.200.000 owed after',
      q3.status === 200 && q3.data.tier === 1 && q3.data.pct === 20 && q3.data.price === 1000000 && q3.data.fee === 200000 && q3.data.started === false &&
      q3.data.blocked === null && q3.data.new_total === 2200000 && q3.data.credit_release === 0 && q3.data.open_billed === 0 && q3.data.owed_after === 2200000 &&
      !Number.isNaN(Date.parse(q3.data.decided_at)), JSON.stringify(q3.data ?? q3.json).slice(0, 400));
    check('R3b saving with expected_cancel_fee = the quoted fee: 200, the same tier and fee, the order total = the quoted new total',
      r3.status === 200 && r3.data.cancellation?.fee === q3.data?.fee && r3.data.cancellation?.tier === q3.data?.tier && num(r3.data.cancel_fee) === q3.data?.fee &&
      Number(o3a.final_price) === q3.data?.new_total && r3.data.order_money?.total === q3.data?.new_total,
      `${r3.status} ${r3.json?.message ?? ''} ${JSON.stringify(r3.data?.cancellation)} ${o3a.final_price}`);
    const one3 = await makeOrder('RA3', { startDay: 32 });
    const [qDone3, qLast3] = [await lineQuote(c1.id), await lineQuote(one3.service_items[0].id)];
    check('R3c the quote of a day already cancelled says ALREADY_CANCELLED (with its fee); of the only open day LAST_OPEN_DAY',
      qDone3.status === 200 && qDone3.data.blocked === 'ALREADY_CANCELLED' && qDone3.data.fee === 200000 && qLast3.status === 200 && qLast3.data.blocked === 'LAST_OPEN_DAY',
      `${qDone3.status} ${qDone3.data?.blocked} ${qDone3.data?.fee} | ${qLast3.status} ${qLast3.data?.blocked}`);

    // R4: the boundaries on the built rule, then the request checks.
    const d10 = '2026-10-10T00:00:00+07:00';
    const at = (iso, started = false, dayDate = d10) => dayCancellation({ price: 1_000_000, dayDate: dayDate ? new Date(dayDate) : null, started, decidedAt: new Date(iso) });
    const t4 = [
      at('2026-10-10T09:59:59.999+07:00'), at('2026-10-10T10:00:00.000+07:00'), at('2026-10-10T10:00:59+07:00'), at('2026-10-09T23:59:00+07:00'),
      at('2026-10-10T08:00:00+07:00', true), at('2026-10-10T08:00:00+07:00', false, null), at('2026-10-11T08:00:00+07:00'),
    ];
    check('R4a [A3, B12] dayCancellation (dist): 09:59:59.999 → 2 (500.000); 10:00:00.000 → 3; 10:00:59 → 3; 23:59 the day before → 1 (200.000); started (08:00) → 3; no date → 1; the day after → 3',
      t4.map((x) => x.tier).join() === '2,3,3,1,3,1,3' && t4.map((x) => x.pct).join() === '50,100,100,20,100,20,100' &&
      t4[0].fee === 500000 && t4[1].fee === 1000000 && t4[3].fee === 200000 && t4[5].fee === 200000,
      t4.map((x) => `${x.tier}/${x.pct}/${x.fee}`).join(' '));
    const o4 = await makeOrder('RA4', { days: 2, startDay: 33 });
    const [a4] = byDate(o4);
    const noReason4 = await putLine(a4.id, { is_external: false, line_status: 'CANCELLED' });
    const longReason4 = await cancelDay(a4.id, { cancel_reason: 'x'.repeat(501) });
    const tooOld4 = await cancelDay(a4.id, { cancel_requested_at: wibIso(-4, '12:00') });
    const future4 = await cancelDay(a4.id, { cancel_requested_at: new Date(Date.now() + 3600e3).toISOString() });
    const qOld4 = await lineQuote(a4.id, wibIso(-4, '12:00'));
    const a4a = await day(a4.id);
    check('R4b [A3] cancelling without cancel_reason (or with 501 characters) → 400; cancel_requested_at older than 3 days or in the future → 400 (the quote too); the day unchanged',
      noReason4.status === 400 && longReason4.status === 400 && tooOld4.status === 400 && future4.status === 400 && qOld4.status === 400 &&
      a4a.line_status === 'SCHEDULED' && a4a.cancel_fee == null && Number((await order(o4.id)).final_price) === 2000000,
      `${noReason4.status} ${longReason4.status} ${tooOld4.status} ${future4.status} quote ${qOld4.status} day ${a4a.line_status}`);

    // R5: rounding, per day then summed.
    const half5 = dayCancellation({ price: 1_234_567, dayDate: new Date(d10), started: false, decidedAt: new Date('2026-10-10T09:00:00+07:00') });
    check('R5a [A3] pctRupiah (dist): 1.234.567 → 20% 246.913, 50% 617.284 (617.283,5 half-up), 100% 1.234.567; two days at 50% = 2 × 617.284 = 1.234.568',
      pctRupiah(1234567, 20) === 246913 && pctRupiah(1234567, 50) === 617284 && pctRupiah(1234567, 100) === 1234567 &&
      half5.tier === 2 && half5.fee === 617284 && half5.fee * 2 === 1234568,
      `${pctRupiah(1234567, 20)} ${pctRupiah(1234567, 50)} ${pctRupiah(1234567, 100)} ${half5.tier}/${half5.fee}`);
    const o5 = await makeOrder('RA5', { days: 3, startDay: 35, price: 1_234_567 });
    const r5 = await cancelDay(byDate(o5)[2].id);
    const total5 = Number((await order(o5.id)).final_price);
    check('R5b through Edit Hari: a 1.234.567 day at tier 1 → fee 246.913; total 2 × 1.234.567 + 246.913 = 2.716.047',
      r5.status === 200 && num(r5.data.cancel_fee) === 246913 && total5 === 2716047, `${r5.status} ${r5.json?.message ?? ''} ${r5.data?.cancel_fee} ${total5}`);

    // R6: day H on the real clock (2 days: today + tomorrow, so it is not the last open day).
    const o6 = await makeOrder('RA6', { days: 2, startDay: 0 });
    const [today6] = byDate(o6);
    const r6 = await cancelDay(today6.id);
    const at6 = r6.data?.cancelled_at;
    const want6 = at6 && wibMsOfDay(at6) < 10 * 3600e3 ? 2 : 3;
    const fee6 = want6 === 2 ? 500000 : 1000000;
    check('R6 [A3] day H on the real clock: the tier follows the WIB time of the save (before 10:00 → 2, 50%; from 10:00 → 3, 100%)',
      r6.status === 200 && !!at6 && r6.data.cancellation?.tier === want6 && num(r6.data.cancel_fee) === fee6 && r6.data.order_money?.total === 1000000 + fee6,
      `saved ${wibClock(at6)} WIB, want tier ${want6}: ${JSON.stringify(r6.data?.cancellation ?? r6.json)} total ${r6.data?.order_money?.total}`);

    // R7 + R8: Batalkan Pesanan on a 3-day order starting today.
    const o7 = await makeOrder('RA7', { days: 3, startDay: 0 });
    const dp7 = await payDp(o7, 600_000);
    let q7 = await orderQuote(o7);
    let c7 = await cancelOrder(o7, { expected_fee_total: q7.data?.fee_total, reason: 'Pelanggan batal semua hari' });
    if (c7.status === 409 && c7.json?.code === 'CANCEL_FEE_CHANGED') {
      // The quote and the save fell on both sides of 10:00 WIB: resend with
      // the new quote, as the dialog does.
      q7 = { status: 200, data: c7.json.quote };
      c7 = await cancelOrder(o7, { expected_fee_total: q7.data?.fee_total, reason: 'Pelanggan batal semua hari' });
    }
    const dec7 = q7.data?.decided_at;
    const tier7 = dec7 && wibMsOfDay(dec7) < 10 * 3600e3 ? 2 : 3;
    const want7 = (tier7 === 2 ? 500000 : 1000000) + 200000 + 200000;
    const old7 = computeCancellationPenalty({ finalPrice: 3_000_000, firstServiceDate: new Date(byDate(o7)[0].service_date), anyLineStarted: false, now: new Date(dec7 ?? Date.now()) });
    const o7a = await order(o7.id);
    check('R7a [A3] Batalkan Pesanan, 3 days from today: each day its own tier (today 2 or 3 by the WIB time, the next two 1); penalty = feeTotal = Σ per-day fees; days[] in the response; rule DAY_V2',
      c7.status === 200 && c7.data.penalty === want7 && c7.data.feeTotal === want7 && c7.data.rule === 'DAY_V2' && c7.data.tier === tier7 &&
      Array.isArray(c7.data.days) && c7.data.days.length === 3 && c7.data.days.map((x) => x.tier).sort().join() === [1, 1, tier7].sort().join() &&
      c7.data.days.reduce((s, x) => s + x.fee, 0) === want7,
      `decided ${wibClock(dec7)} WIB, want ${tier7}/${want7}: ${c7.status} ${JSON.stringify(c7.data ?? c7.json).slice(0, 400)}`);
    check('R7b the per-day penalty is below the old whole-order rule at the same moment', c7.status === 200 && c7.data.penalty < old7.penalty,
      `${c7.data?.penalty} vs old tier ${old7.tier} ${old7.penalty}`);
    const fee7 = o7a.invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
    check('R7c order after: DAY_V2, cancellation_fee = total = Σ fees, every day CANCELLED with its fee, the paid DP stays PAID, fee invoice = total − 600.000 received',
      o7a.cancellation_rule === 'DAY_V2' && Number(o7a.cancellation_fee) === want7 && Number(o7a.final_price) === want7 && o7a.order_status === 'CANCELLED' &&
      o7a.service_items.every((l) => l.line_status === 'CANCELLED' && num(l.cancel_fee) === c7.data?.days?.find((x) => x.id === l.id)?.fee) &&
      o7a.invoices.find((i) => i.id === dp7.id)?.status === 'PAID' && Number(fee7?.amount) === want7 - 600000 && c7.data?.stillOwed === want7 - 600000 &&
      c7.data?.cancellationInvoiceNumber === fee7?.invoice_number && c7.data?.netPaid === 600000 && c7.data?.newTotal === want7 && c7.data?.creditBalance === 0,
      `${o7a.cancellation_rule} ${o7a.cancellation_fee} ${o7a.final_price} DP ${o7a.invoices.find((i) => i.id === dp7.id)?.status} fee inv ${fee7?.amount}`);
    check('R8a [A3] the order cancel-quote equals the result: days, fee_total, new_total, net_paid, fee invoice, nothing voided',
      q7.status === 200 && sameDays(q7.data.days, c7.data?.days) && q7.data.fee_total === c7.data?.penalty && q7.data.new_total === c7.data?.newTotal &&
      q7.data.earlier_fee_total === 0 && q7.data.net_paid === 600000 && q7.data.fee_invoice?.amount === c7.data?.stillOwed &&
      q7.data.voided_invoices?.length === 0 && (c7.data?.voidedInvoices ?? []).length === 0 && q7.data.tier === tier7,
      `${JSON.stringify(q7.data ?? q7.json).slice(0, 400)}`);
    const fee7t = fee7 ? await pdfStrings((await prisma.invoice.findUnique({ where: { id: fee7.id } }))?.file_url) : '';
    // One match per day line: "Biaya pembatalan sewa <date> … N%" or "(Dibatalkan — biaya pembatalan N%)".
    const lines7 = fee7t.match(/(?:Biaya pembatalan sewa|\(Dibatalkan [-—] biaya pembatalan)[^%]{0,90}?\d+%/g) ?? [];
    check('R27b [A3] the fee invoice PDF of Batalkan Pesanan lists one "(Dibatalkan — biaya pembatalan N%)" line per day (20%, 20% and today\'s 50% or 100%)',
      lines7.length === 3 && lines7.filter((x) => x.includes('20%')).length === 2 && lines7.some((x) => x.includes(`${tier7 === 2 ? 50 : 100}%`)),
      `${lines7.join(' | ')} (${fee7t.length} chars)`);
    check('R27c [A3] the fee invoice has its own title and layout: "Invoice Biaya Pembatalan", "Sudah dibayar" for the 600.000 received, not the settlement "DP sudah dibayar"',
      /Invoice Biaya Pembatalan/.test(fee7t) && /Sudah dibayar/.test(fee7t) && !/DP sudah dibayar/.test(fee7t) && /Total setelah pembatalan/.test(fee7t),
      fee7t.slice(0, 300));

    // R7d: Batalkan Pesanan is idempotent on client_ref.
    const o7r = await makeOrder('RA7r', { startDay: 9 });
    const ref7r = uuid();
    const c7r1 = await call('POST', `/orders/${o7r.id}/cancel`, { token: admin, body: { reason: 'R7d', client_ref: ref7r } });
    const inv7r1 = (await order(o7r.id)).invoices.length;
    const c7r2 = await call('POST', `/orders/${o7r.id}/cancel`, { token: admin, body: { reason: 'R7d lagi', client_ref: ref7r } });
    const c7r3 = await call('POST', `/orders/${o7r.id}/cancel`, { token: admin, body: { reason: 'R7d lain', client_ref: uuid() } });
    const o7r2 = await order(o7r.id);
    // Same values; key order is not part of the contract (the stored result is JSONB, which orders keys).
    const canon7 = (v) => (Array.isArray(v) ? v.map(canon7) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon7(v[k])])) : v);
    check('R7d [A3] Batalkan Pesanan with client_ref: a resend with the same ref → 200 with the same result (no second fee invoice, no new number); another ref → 409',
      c7r1.status === 200 && c7r1.data?.penalty === 200000 && c7r2.status === 200 && JSON.stringify(canon7(c7r2.data)) === JSON.stringify(canon7(c7r1.data)) &&
      o7r2.invoices.length === inv7r1 && c7r3.status === 409 && o7r2.cancel_client_ref === ref7r && Number(o7r2.cancellation_fee) === 200000,
      `${c7r1.status}/${c7r2.status}/${c7r3.status} invoices ${inv7r1}→${o7r2.invoices.length} ref ${o7r2.cancel_client_ref === ref7r} fee ${o7r2.cancellation_fee} same ${JSON.stringify(canon7(c7r2.data)) === JSON.stringify(canon7(c7r1.data))}`);

    // R9 (+ R8b): an earlier per-day fee is kept; an unpaid invoice is voided.
    const o9 = await makeOrder('RA9', { days: 3, startDay: 36 });
    const [, , c9] = byDate(o9);
    const r9 = await cancelDay(c9.id);
    const c9a = await day(c9.id);
    const dp9 = (await invoice(o9.id, 'DP', 500_000)).data;
    await markPaid(o9.id, dp9.id);
    const st9 = (await invoice(o9.id, 'SETTLEMENT', 1_700_000)).data;
    const q9 = await orderQuote(o9);
    const c9r = await cancelOrder(o9, { expected_fee_total: q9.data?.fee_total });
    const o9a = await order(o9.id);
    const c9b = await day(c9.id);
    check('R9a [A3] Batalkan Pesanan after day 3 was cancelled in Edit Hari: that day keeps its fee, tier and time; the other two add 200.000 each → fee_total 600.000 (earlier 200.000)',
      r9.status === 200 && c9r.status === 200 && c9r.data.earlierFeeTotal === 200000 && c9r.data.feeTotal === 600000 && c9r.data.penalty === 600000 &&
      c9r.data.days?.length === 2 && !c9r.data.days.some((x) => x.id === c9.id) && num(c9b.cancel_fee) === 200000 && c9b.cancel_tier === 1 &&
      c9b.cancelled_at?.getTime() === c9a.cancelled_at?.getTime() && Number(o9a.cancellation_fee) === 600000 && Number(o9a.final_price) === 600000,
      `${r9.status} ${c9r.status} ${JSON.stringify(c9r.data ?? c9r.json).slice(0, 300)} day3 ${c9b.cancel_fee}`);
    check('R9b the unpaid settlement is voided, the paid DP stays PAID; one fee invoice of 100.000 (600.000 − 500.000 received)',
      st9?.id && o9a.invoices.find((i) => i.id === st9.id)?.status === 'CANCELLED' && o9a.invoices.find((i) => i.id === dp9.id)?.status === 'PAID' &&
      c9r.data?.stillOwed === 100000 && Number(o9a.invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE')?.amount) === 100000,
      o9a.invoices.map((i) => `${i.invoice_type} ${i.status} ${i.amount}`).join(', '));
    check('R8b the quote with an unpaid invoice equals the result too: days, earlier_fee_total, fee_total, new_total, the voided invoice, the fee invoice',
      q9.status === 200 && sameDays(q9.data.days, c9r.data?.days) && q9.data.earlier_fee_total === 200000 && q9.data.fee_total === 600000 && q9.data.new_total === 600000 &&
      (q9.data.voided_invoices ?? []).map((x) => x.id).join() === st9?.id && (c9r.data?.voidedInvoices ?? []).map((x) => x.id ?? x).join() === st9?.id &&
      q9.data.fee_invoice?.gross === 100000 && q9.data.fee_invoice?.amount === 100000 && q9.data.credit_release === 0,
      JSON.stringify(q9.data ?? q9.json).slice(0, 400));

    // R10: day 1 done, then Batalkan Pesanan → the excess becomes saldo lebih.
    const o10 = await makeOrder('RA10', { days: 3, price: 500_000, startDay: 40 });
    await payFull(o10);
    const [a10] = byDate(o10);
    await prisma.orderServiceItem.update({ where: { id: a10.id }, data: { line_status: 'DONE' } });
    const c10 = await cancelOrder(o10);
    const o10a = await order(o10.id);
    const rel10 = (await entriesOf(o10)).filter((e) => e.kind === 'RELEASE');
    check('R10 [A3] day 1 done, then Batalkan Pesanan: days 2–3 at 20% (100.000 each), total 700.000 (500.000 done + fees); 800.000 of the 1.500.000 paid released as saldo lebih; no fee invoice; PAID',
      c10.status === 200 && c10.data.penalty === 200000 && c10.data.newTotal === 700000 && c10.data.creditReleased === 800000 && c10.data.refundDue === 800000 &&
      c10.data.stillOwed === 0 && c10.data.cancellationInvoiceNumber == null && Number(o10a.final_price) === 700000 && o10a.money.credit_balance === 800000 &&
      o10a.payment_status === 'PAID' && rel10.length === 1 && Number(rel10[0].amount) === 800000 && o10a.service_items.find((l) => l.id === a10.id)?.line_status === 'DONE',
      `${c10.status} ${JSON.stringify(c10.data ?? c10.json).slice(0, 300)} total ${o10a.final_price} credit ${o10a.money?.credit_balance} ${rel10.map((e) => e.amount).join(',')}`);

    // R11 + R29: paid in full, a day cancelled in Edit Hari; then reopened.
    const o11 = await makeOrder('RA11', { days: 2, startDay: 42 });
    await payFull(o11);
    const [, b11] = byDate(o11);
    const q11 = await lineQuote(b11.id);
    const r11 = await cancelDay(b11.id, { expected_cancel_fee: 200_000 });
    const o11a = await order(o11.id);
    const rel11 = (await entriesOf(o11)).filter((e) => e.kind === 'RELEASE');
    check('R11a [A3] paid in full: the line quote shows the release (new total 1.200.000, 800.000 to saldo lebih, nothing owed after, not blocked)',
      q11.status === 200 && q11.data.blocked === null && q11.data.new_total === 1200000 && q11.data.credit_release === 800000 && q11.data.owed_after === 0 && q11.data.covered === 2000000,
      JSON.stringify(q11.data ?? q11.json).slice(0, 300));
    check('R11b cancelling a day of an order paid in full is accepted (refused before A3): RELEASE 800.000 → saldo lebih, status stays PAID, no invoice made',
      r11.status === 200 && r11.data.order_money?.credit_balance === 800000 && o11a.payment_status === 'PAID' && Number(o11a.final_price) === 1200000 &&
      rel11.length === 1 && Number(rel11[0].amount) === 800000 && o11a.invoices.length === 1,
      `${r11.status} ${r11.json?.message ?? ''} ${o11a.payment_status} ${o11a.final_price} ${rel11.map((e) => e.amount).join(',')} invoices ${o11a.invoices.length}`);
    const t29 = Date.now();
    const r29 = await putLine(b11.id, { is_external: false, line_status: 'SCHEDULED' });
    const b11r = await day(b11.id);
    const o11r = await order(o11.id);
    check('R29 [A3] reopening the cancelled day (Edit Hari → SCHEDULED) clears its fee, tier, times and reason; total 2.000.000 again; the 800.000 saldo lebih stays (800.000 billable, the credit pays it); logged',
      r29.status === 200 && b11r.line_status === 'SCHEDULED' && b11r.cancel_fee == null && b11r.cancel_tier == null && b11r.cancelled_at == null &&
      b11r.cancel_reason == null && b11r.cancel_requested_at == null && Number(o11r.final_price) === 2000000 && o11r.money.credit_balance === 800000 &&
      o11r.money.billable_remaining === 800000 && (await logsSince(o11, t29)).length >= 1,
      `${r29.status} ${r29.json?.message ?? ''} fee ${b11r.cancel_fee} total ${o11r.final_price} credit ${o11r.money?.credit_balance} billable ${o11r.money?.billable_remaining}`);

    // R26: the fee in the reports, as before/after differences (like group O).
    const ymdA3 = (d) => wibIso(d, '12:00').slice(0, 10);
    const dashA3 = async (from, to) => (await call('GET', `/analytics/dashboard-v2?date_from=${ymdA3(from)}&date_to=${ymdA3(to)}`, { token: admin })).data;
    const revA3 = async () => (await call('GET', `/analytics/revenue?date_from=${ymdA3(-1)}&date_to=${ymdA3(60)}`, { token: admin })).data;
    const pick = (o, path) => Number(path.split('.').reduce((x, k) => x?.[k], o));
    const dA3 = (a, b, path) => pick(b, path) - pick(a, path);
    const o26 = await makeOrder('RA26', { days: 2, startDay: 44 });
    const fin26 = () => prisma.orderFinalFinance.findUnique({ where: { order_id: o26.id } });
    // Work out both days' margins and the order card first (a day save runs
    // recomputeLineMoney + the rollup), so the card has a baseline.
    for (const l of byDate(o26)) await putLine(l.id, { is_external: false, notes: 'R26 baseline' });
    const [all0, later0, rev0, card0] = [await dashA3(-1, 60), await dashA3(40, 60), await revA3(), await fin26()];
    const r26 = await cancelDay(byDate(o26)[1].id);
    const [all1, later1, rev1, card1] = [await dashA3(-1, 60), await dashA3(40, 60), await revA3(), await fin26()];
    const show26 = (a, b, paths) => paths.map((p) => `${p} ${dA3(a, b, p)}`).join(', ');
    check('R26a [A3] Dashboard (yesterday … +60 days): the day fee comes in as cancellation_income (+200.000), the day leaves revenue: revenue and margin −800.000',
      r26.status === 200 && dA3(all0, all1, 'accrual.cancellation_income') === 200000 && dA3(all0, all1, 'accrual.revenue') === -800000 && dA3(all0, all1, 'accrual.margin') === -800000,
      `${r26.status} ${show26(all0, all1, ['accrual.cancellation_income', 'accrual.revenue', 'accrual.margin'])}`);
    check('R26b a range with the day but not today (+40 … +60): the day leaves revenue (−1.000.000), no cancellation income there (it counts on cancelled_at)',
      dA3(later0, later1, 'accrual.cancellation_income') === 0 && dA3(later0, later1, 'accrual.revenue') === -1000000,
      show26(later0, later1, ['accrual.cancellation_income', 'accrual.revenue']));
    check('R26c order card: total 1.200.000; its margin moves like the Dashboard margin (−800.000)',
      Number(card1?.total_user_amount) === 1200000 && card0 != null && Number(card1?.margin_amount) - Number(card0.margin_amount) === dA3(all0, all1, 'accrual.margin'),
      `${card0?.total_user_amount}/${card0?.margin_amount} → ${card1?.total_user_amount}/${card1?.margin_amount}`);
    check('R26d Revenue page: order_level.cancellation_income +200.000', dA3(rev0, rev1, 'order_level.cancellation_income') === 200000,
      show26(rev0, rev1, ['order_level.cancellation_income']));

    // R27a: an invoice of an order with a cancelled day; the policy text.
    const dp27 = await invoice(o1.id, 'DP', 440_000);
    const dp27t = await pdfStrings(dp27.data?.file_url);
    const wa27 = dp27.data?.id
      ? await call('POST', `/orders/${o1.id}/invoice/${dp27.data.id}/send-whatsapp`, { token: admin, body: { target_phone: '081234567890' } })
      : { status: 0 };
    const cap27 = (wa27.data?.message_text ?? '').replace(/\s+/g, ' ');
    const policyHead = String(policy.CANCELLATION_POLICY_TEXT ?? '').split(':')[0];
    check('R27a [A3] DP 440.000 (20% of 2.200.000) accepted; its PDF prints the day as "(Dibatalkan — biaya pembatalan 20%)" and the per-day policy text; the WhatsApp caption carries the policy text',
      dp27.status === 201 && /\(Dibatalkan [-—] biaya pembatalan 20%\)/.test(dp27t) && /Pembatalan dihitung per hari sewa/.test(policyHead) &&
      dp27t.includes(policyHead) && wa27.status === 201 && cap27.includes(policyHead),
      `${dp27.status} ${dp27.json?.message ?? ''} day ${/Dibatalkan [-—] biaya pembatalan 20%/.test(dp27t)} policy pdf ${dp27t.includes(policyHead)} wa ${wa27.status} ${cap27.includes(policyHead)}`);

    // R28: Edit Order removes a day only while the order has no money.
    const del = (o, keep) => call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(o, { reason: 'kurangi hari', days: [{ id: keep }] }) });
    const o28 = await makeOrder('RA28', { days: 2, startDay: 46 });
    await payDp(o28, 400_000);
    const del28 = await del(o28, byDate(o28)[0].id);
    const o28b = await makeOrder('RA28b', { days: 2, startDay: 47 });
    await invoice(o28b.id, 'DP', 400_000);
    const del28b = await del(o28b, byDate(o28b)[0].id);
    const o28c = await makeOrder('RA28c', { days: 2, startDay: 48 });
    const del28c = await del(o28c, byDate(o28c)[0].id);
    const [n28, n28b, o28ca] = [(await order(o28.id)).service_items.length, (await order(o28b.id)).service_items.length, await order(o28c.id)];
    const msg28 = /Batalkan hari itu lewat Edit Hari supaya biaya pembatalan dihitung/;
    check('R28a [A3] Edit Order removing a day of an order with money → 409 DAY_DELETE_NEEDS_CANCEL "Batalkan hari itu lewat Edit Hari supaya biaya pembatalan dihitung"; both days kept',
      del28.status === 409 && del28.json?.code === 'DAY_DELETE_NEEDS_CANCEL' && msg28.test(del28.json?.message ?? '') && n28 === 2,
      `${del28.status} ${del28.json?.code ?? ''} ${del28.json?.message ?? ''} days ${n28}`);
    check('R28b also with only an unpaid invoice (no money yet) → 409 DAY_DELETE_NEEDS_CANCEL',
      del28b.status === 409 && del28b.json?.code === 'DAY_DELETE_NEEDS_CANCEL' && n28b === 2, `${del28b.status} ${del28b.json?.code ?? ''} days ${n28b}`);
    check('R28c without money and invoices the day is removed for free: 200, one day, total 1.000.000',
      del28c.status === 200 && o28ca.service_items.length === 1 && Number(o28ca.final_price) === 1000000, `${del28c.status} ${del28c.json?.message ?? ''} ${o28ca.final_price}`);

    // R30: a DONE day cannot be cancelled.
    const o30 = await makeOrder('RA30', { days: 3, startDay: 49 });
    const [a30] = byDate(o30);
    await prisma.orderServiceItem.update({ where: { id: a30.id }, data: { line_status: 'DONE' } });
    const q30 = await lineQuote(a30.id);
    const r30 = await cancelDay(a30.id);
    const a30a = await day(a30.id);
    check('R30 [A3] a DONE day cannot be cancelled: quote blocked DONE_DAY; save → 409 DONE_DAY; the day still DONE without a fee, total 3.000.000',
      q30.data?.blocked === 'DONE_DAY' && r30.status === 409 && r30.json?.code === 'DONE_DAY' && a30a.line_status === 'DONE' && a30a.cancel_fee == null &&
      Number((await order(o30.id)).final_price) === 3000000,
      `${q30.status} ${q30.data?.blocked} | ${r30.status} ${r30.json?.code ?? ''} ${r30.json?.message ?? ''}`);

    // R31: INV-6 — an unpaid invoice may not ask more than is still owed.
    const o31 = await makeOrder('RA31', { days: 2, startDay: 50 });
    const dp31 = (await invoice(o31.id, 'DP', 400_000)).data;
    await markPaid(o31.id, dp31.id);
    const st31 = (await invoice(o31.id, 'SETTLEMENT', 1_600_000)).data;
    const [, b31] = byDate(o31);
    const q31 = await lineQuote(b31.id);
    const t31 = Date.now();
    const r31 = await cancelDay(b31.id);
    const o31a = await order(o31.id);
    const b31a = await day(b31.id);
    check('R31a [A3, INV-6] unpaid settlement 1.600.000 > what stays owed after the cancel (1.200.000 − 400.000 = 800.000): quote blocked OPEN_INVOICE_EXCEEDS; save → 409 with new_total, covered, open_billed, max_open_billed and the amounts in the message',
      q31.data?.blocked === 'OPEN_INVOICE_EXCEEDS' && q31.data.new_total === 1200000 && q31.data.open_billed === 1600000 && q31.data.max_open_billed === 800000 &&
      r31.status === 409 && r31.json?.code === 'OPEN_INVOICE_EXCEEDS' && r31.json.new_total === 1200000 && r31.json.covered === 400000 &&
      r31.json.open_billed === 1600000 && r31.json.max_open_billed === 800000 &&
      /Rp 1\.200\.000/.test(r31.json.message ?? '') && /Rp 1\.600\.000/.test(r31.json.message ?? '') && /Rp 800\.000/.test(r31.json.message ?? ''),
      `quote ${q31.data?.blocked} | ${r31.status} ${JSON.stringify(r31.json).slice(0, 300)}`);
    check('R31b nothing changed: the day SCHEDULED without a fee, total 2.000.000, the settlement still ISSUED, no saldo lebih entry, no log',
      b31a.line_status === 'SCHEDULED' && b31a.cancel_fee == null && Number(o31a.final_price) === 2000000 && o31a.invoices.find((i) => i.id === st31?.id)?.status === 'ISSUED' &&
      (await entriesOf(o31)).length === 0 && (await logsSince(o31, t31)).length === 0,
      `${b31a.line_status} ${b31a.cancel_fee} ${o31a.final_price} ${o31a.invoices.map((i) => `${i.invoice_type} ${i.status}`).join(',')}`);
    const rv31 = st31?.id ? await call('POST', `/orders/${o31.id}/invoice/${st31.id}/revise`, { token: admin, body: { amount: 800_000 } }) : { status: 0 };
    const r31c = await cancelDay(b31.id);
    check('R31c after revising the settlement to 800.000 (the most still owed) the day is cancelled: 200, total 1.200.000',
      rv31.status === 201 && r31c.status === 200 && r31c.data.order_money?.total === 1200000, `${rv31.status} ${rv31.json?.message ?? ''} | ${r31c.status} ${r31c.json?.message ?? ''}`);
    // The customer asked yesterday: today's day is charged as asked then (tier 1).
    const o31r = await makeOrder('RA31r', { days: 2, startDay: 0 });
    const [today31] = byDate(o31r);
    const req31 = wibIso(-1, '15:00');
    const q31r = await lineQuote(today31.id, req31);
    const r31r = await cancelDay(today31.id, { cancel_requested_at: req31, expected_cancel_fee: 200_000 });
    const d31r = await day(today31.id);
    check('R31d [A3] cancel_requested_at = yesterday 15:00 WIB for today\'s day: tier 1 (200.000) from the customer\'s time, not the save; stored as cancel_requested_at, cancelled_at = the save; the quote with requested_at agrees',
      q31r.status === 200 && q31r.data.tier === 1 && q31r.data.fee === 200000 && r31r.status === 200 && r31r.data.cancellation?.tier === 1 && num(d31r.cancel_fee) === 200000 &&
      d31r.cancel_requested_at?.getTime() === new Date(req31).getTime() && Math.abs((d31r.cancelled_at?.getTime() ?? 0) - Date.now()) < 60e3,
      `quote ${q31r.status} ${q31r.data?.tier}/${q31r.data?.fee} | ${r31r.status} ${r31r.json?.message ?? ''} ${JSON.stringify(r31r.data?.cancellation)} req ${d31r.cancel_requested_at?.toISOString()}`);
  } catch (err) {
    check('R A3 (per-day cancellation) block: stopped by an error', false, String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }

  // Ledger flows: overpayment → saldo lebih, the old refund endpoint (now a
  // bounded alias, finance A2) takes it back; a second refund finds no
  // credit left. (A1 let a re-mark overwrite the one refund instead.)
  const o33 = await makeOrder('R33f');
  const before33 = await order(o33.id);
  const f33 = await invoice(o33.id, 'FULL', 1_000_000);
  await markPaid(o33.id, f33.data.id, { amount_received: 1_150_000, amount_mismatch_ack: true });
  const paid33 = await order(o33.id);
  const refund33 = (amount) => {
    const f = new FormData();
    f.append('proof', jpeg(), 'r.jpg');
    if (amount) f.append('amount', String(amount));
    return call('POST', `/orders/${o33.id}/mark-refunded`, { token: admin, form: f });
  };
  const r33a = await refund33();
  const after33a = await order(o33.id);
  const r33b = await refund33(100_000);
  const after33b = await order(o33.id);
  const entries33 = await prisma.orderCreditEntry.findMany({ where: { order_id: o33.id }, orderBy: { created_at: 'asc' } });
  const kinds33 = entries33.map((e) => `${e.kind} ${Number(e.amount)}`).join(', ');
  check('R33f overpaid 150.000 → OVERPAYMENT entry, saldo lebih 150.000; the old endpoint refunds it → 0; a further 100.000 → 409 (no saldo lebih left), one REFUND entry',
    paid33.money.credit_balance === 150000 && r33a.status === 200 && after33a.money.credit_balance === 0 && r33b.status === 409 && after33b.money.credit_balance === 0 &&
    Number(after33b.refunded_total) === 150000 &&
    entries33.length === 2 && entries33[0].kind === 'OVERPAYMENT' && Number(entries33[0].amount) === 150000 && entries33[1].kind === 'REFUND' && Number(entries33[1].amount) === -150000,
    `${paid33.money.credit_balance} → ${after33a.money.credit_balance} → ${r33b.status} ${after33b.money.credit_balance}; ${kinds33}`);
  const rules33 = (m) => [m.payment_status, m.billable_remaining, m.start_ready, m.rule].join('/');
  check('R33g rule set v3: billing on Covered, status and start_ready on Net (overpaid then refunded: PAID, nothing billable, ready)',
    rules33(before33.money) === 'UNPAID/1000000/false/v3' && rules33(paid33.money) === 'PAID/0/true/v3' && rules33(after33b.money) === 'PAID/0/true/v3',
    `${rules33(before33.money)} | ${rules33(paid33.money)} | ${rules33(after33b.money)}`);

  // R33: invariants over every order this run made (finance design §6), in
  // their full credit-aware form since finance A2 (RELEASE / APPLIED /
  // UNAPPLIED / REFUND move the ledger): INV-5 Covered ≤ T and INV-6
  // Covered + OpenBilled ≤ T on every order, INV-9 payment_status from Net.
  const mine = await prisma.order.findMany({
    where: { customer_name: { contains: tag } },
    include: {
      service_items: { select: { total_price: true, line_status: true, cancel_fee: true, cancel_tier: true } },
      invoices: { include: { receipts: { orderBy: { created_at: 'asc' }, take: 1 } } },
      refunds: true,
      credit_entries: true,
      adjustments: true,
    },
  });
  const v = { inv12: [], inv3: [], inv4: [], money: [], cap: [], ledger: [], status: [], dayFee: [] };
  // A3: pctRupiah from the design (§2), not from dist: integer sen, half-up.
  const pctSen = (price, pct) => Math.floor((sen(price) * pct + 5000) / 10000) * 100;
  const tierPct = { 1: 20, 2: 50, 3: 100 };
  for (const o of mine) {
    const name = o.order_code ?? o.id;
    const credit = o.credit_entries.reduce((s, e) => s + sen(e.amount), 0);
    if (sen(o.credit_balance) < 0 || sen(o.credit_balance) !== credit) v.inv12.push(`${name} ${o.credit_balance}≠${credit / 100}`);
    const refunds = o.refunds.reduce((s, r) => s + sen(r.amount), 0);
    const legacy = o.is_refunded ? sen(o.refund_amount) : 0;
    if (sen(o.refunded_total) !== refunds || refunds !== legacy) v.inv3.push(`${name} ${o.refunded_total}/${refunds / 100}/${legacy / 100}`);
    for (const r of o.refunds) {
      const re = o.credit_entries.filter((e) => e.kind === 'REFUND' && e.refund_id === r.id);
      if (re.length !== 1 || sen(re[0].amount) !== -sen(r.amount)) v.ledger.push(`${name} refund ${r.amount}: REFUND entries ${re.map((e) => e.amount).join(',')}`);
    }
    const paidInv = o.invoices.filter((i) => i.status === 'PAID' || (i.status === 'CANCELLED' && i.paid_at));
    const received = paidInv.reduce((s, i) => s + sen(i.receipts[0]?.amount ?? i.amount), 0);
    if (received !== sen(o.paid_to_date)) v.inv4.push(`${name} paid_to_date ${o.paid_to_date}≠${received / 100}`);
    for (const i of paidInv) if (i.receipts[0] && sen(i.amount_received) !== sen(i.receipts[0].amount)) v.inv4.push(`${i.invoice_number} amount_received ${i.amount_received}`);
    const open = o.invoices.filter((i) => ['DRAFT', 'ISSUED'].includes(i.status)).reduce((s, i) => s + sen(i.amount), 0);
    const T = sen(o.final_price);
    const net = sen(o.paid_to_date) - sen(o.refunded_total);
    const covered = net - sen(o.credit_balance);
    if (covered > T) v.ledger.push(`${name} [INV-5] covered ${covered / 100} > total ${o.final_price}`);
    if (covered + open > T) v.cap.push(`${name} covered ${covered / 100} + open ${open / 100} > total ${o.final_price}`);
    for (const i of paidInv) {
      const over = sen(i.amount_received) - sen(i.amount);
      const entries = o.credit_entries.filter((e) => e.kind === 'OVERPAYMENT' && e.invoice_id === i.id);
      if (over > 0 ? entries.length !== 1 || sen(entries[0].amount) !== over : entries.length !== 0) v.ledger.push(`${i.invoice_number} over ${over / 100}, entries ${entries.length}`);
    }
    // A3: per-day fees on every order that is not a legacy whole-order
    // cancellation: each cancelled day with a tier has fee = pctRupiah(its
    // price, the tier's %); DAY_V2 orders: cancellation_fee = Σ day fees;
    // the total = Σ dayBillable + charges.
    const legacyCancel = o.cancellation_fee != null && o.cancellation_rule !== 'DAY_V2';
    const dayBillable = o.service_items.reduce((s, l) => s + (l.line_status === 'CANCELLED' ? sen(l.cancel_fee) : sen(l.total_price)), 0);
    if (!legacyCancel) {
      for (const l of o.service_items) {
        if (l.line_status !== 'CANCELLED' || l.cancel_tier == null) continue;
        if (!tierPct[l.cancel_tier] || sen(l.cancel_fee) !== pctSen(l.total_price, tierPct[l.cancel_tier]))
          v.dayFee.push(`${name} day ${l.total_price} tier ${l.cancel_tier} fee ${l.cancel_fee} ≠ ${pctSen(l.total_price, tierPct[l.cancel_tier] ?? 0) / 100}`);
      }
      const chargesSen = o.adjustments.filter((a) => a.is_billable).reduce((s, a) => s + sen(a.amount) * (a.quantity ?? 1), 0);
      if (T !== dayBillable + chargesSen) v.dayFee.push(`${name} total ${o.final_price} ≠ Σ dayBillable + charges ${(dayBillable + chargesSen) / 100}`);
    }
    if (o.cancellation_rule === 'DAY_V2') {
      const fees = o.service_items.filter((l) => l.line_status === 'CANCELLED').reduce((s, l) => s + sen(l.cancel_fee), 0);
      if (sen(o.cancellation_fee) !== fees) v.dayFee.push(`${name} DAY_V2 cancellation_fee ${o.cancellation_fee} ≠ Σ day fees ${fees / 100}`);
    }
    // INV-9: payment_status = f(Net, T, base); sheet imports (no paid_to_date) keep theirs.
    // A3: base = Σ dayBillable (a cancelled day counts with its fee); legacy: the fee.
    const base = legacyCancel ? sen(o.cancellation_fee) : dayBillable;
    const minDp = Math.round((base / 100) * 0.2) * 100;
    const rule = T > 0 && net >= T ? 'PAID' : net > 0 && net >= minDp ? 'DP_PAID' : 'UNPAID';
    const imported = sen(o.paid_to_date) === 0 && o.payment_status !== 'UNPAID';
    if (!imported && o.payment_status !== rule) v.status.push(`${name} ${o.payment_status}, rule ${rule} (net ${net / 100}, total ${o.final_price})`);
    const g = await order(o.id);
    const m = g.money;
    // A3 (owner rule 9): "Mulai perjalanan" needs Net ≥ base = Σ dayBillable;
    // legacy cancellations keep the days still billed at their price.
    const rentalBase = legacyCancel
      ? o.service_items.filter((l) => l.line_status !== 'CANCELLED').reduce((s, l) => s + sen(l.total_price), 0)
      : dayBillable;
    const want = {
      total: T, received: sen(o.paid_to_date), refunded: sen(o.refunded_total), net_paid: net, credit_balance: sen(o.credit_balance),
      covered, open_billed: open, billable_remaining: Math.max(0, T - covered - open), outstanding: Math.max(0, T - net),
    };
    const diff = Object.entries(want).filter(([k, x]) => sen(m?.[k]) !== x).map(([k, x]) => `${k} ${m?.[k]}≠${x / 100}`);
    if (m?.payment_status !== o.payment_status) diff.push(`payment_status ${m?.payment_status}`);
    if (m?.start_ready !== net >= rentalBase || g.start_payment?.ready !== m?.start_ready) diff.push(`start_ready ${m?.start_ready} / start_payment ${g.start_payment?.ready}, Net ${net / 100} vs ${rentalBase / 100}`);
    if (m?.rule !== 'v3') diff.push(`rule ${m?.rule}`);
    if (!Array.isArray(g.refunds) || !Array.isArray(g.credit_entries) || g.refunds.some((r) => 'proof_url' in r)) diff.push('refunds / credit_entries shape');
    for (const i of g.invoices) {
      if (sen(i.gross) !== sen(i.amount) + sen(i.credit_applied)) diff.push(`${i.invoice_number} gross ${i.gross}`);
      const short = i.status === 'PAID' && i.amount_received != null ? Math.max(0, sen(i.amount) - sen(i.amount_received)) : 0;
      if (sen(i.shortfall) !== short) diff.push(`${i.invoice_number} shortfall ${i.shortfall}`);
    }
    if (diff.length) v.money.push(`${name}: ${diff.join(', ')}`);
  }
  const head = (a) => `${a.length} of ${mine.length} orders ${a.slice(0, 3).join(' | ')}`;
  check('R33a [INV-1, INV-2] credit_balance ≥ 0 and = Σ credit entries', v.inv12.length === 0, head(v.inv12));
  check('R33b [INV-3] refunded_total = Σ refunds = the old refund columns', v.inv3.length === 0, head(v.inv3));
  check('R33c [INV-4] paid_to_date = Σ receipts; amount_received = the receipt', v.inv4.length === 0, head(v.inv4));
  check('R33d `money` on GET /orders/:id matches the stored money (rule v3, start_ready on Net, invoice gross/shortfall)', v.money.length === 0, head(v.money));
  check('R33e [INV-6] covered + open_billed ≤ total on every order (cancelled ones too)', v.cap.length === 0, head(v.cap));
  check('R33h [INV-5, INV-8] covered ≤ total on every order; one OVERPAYMENT entry per overpaid invoice (= the difference); one REFUND entry per refund (= its amount)', v.ledger.length === 0, head(v.ledger));
  check('R33i [INV-9] payment_status follows Net, the total and the DP base on every order', v.status.length === 0, head(v.status));
  check('R33j [A3] per-day fees: every cancelled day with a tier has fee = pctRupiah(price, 20/50/100); DAY_V2 cancellation_fee = Σ day fees; total = Σ dayBillable + charges (legacy ORDER_V1 excluded)', v.dayFee.length === 0, head(v.dayFee));
});

const failed = summary();
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
