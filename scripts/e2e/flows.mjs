// End-to-end checks of the API: what the dashboard and the driver app do,
// against the real API and a throwaway database. Run through run-local.sh.
// Case ids in the output match dashboard-arasya-rentcar/docs/TEST-PLAN.md.
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
  const removeNew = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(o3, { reason: 'batal tambah', days: [{ id: lineId }] }) });
  const o4 = await order(o.id);
  check('C19 removing the untouched new day works; total back to 1.000.000', removeNew.status === 200 && o4.service_items.length === 1 && Number(o4.final_price) === 1000000, removeNew.json?.message);
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
  const moved = await call('PUT', `/orders/${o.id}`, { token: admin, body: editBody(mv, { days: [{ id: lineId, start_at: wibIso(0, '10:30') }] }) });
  await sleep(600);
  const afterMove = await prisma.orderServiceItem.findUnique({ where: { id: lineId } });
  check('C27 moving a driver\'s day: confirmation reset, driver told "Jadwal tugas diubah"', moved.status === 200 && !!before.confirmation_sent_at && !afterMove.confirmation_sent_at && (await pushesTo(d1)).some((x) => x.title === 'Jadwal tugas diubah'), moved.json?.message);

  // Removing the last open day would cancel the order: use Batalkan Pesanan.
  const lc = await makeOrder('C28', { days: 2, startDay: 11 });
  await putLine(lc.service_items[0].id, { is_external: false, line_status: 'CANCELLED' });
  const lcRes = await call('PUT', `/orders/${lc.id}`, { token: admin, body: editBody(await order(lc.id), { reason: 'hapus', days: [{ id: lc.service_items[0].id }] }) });
  check('C28 removing the last open day refused (409), order not cancelled', lcRes.status === 409 && (await order(lc.id)).order_status !== 'CANCELLED', lcRes.json?.message);

  // A cancelled day that kept its driver stays on the order, with a clear message.
  const cd = await makeOrder('C29', { days: 2, startDay: 12 });
  await payDp(cd, 400_000);
  await putLine(cd.service_items[0].id, { is_external: false, driver_id: d3.id, line_status: 'ASSIGNED' });
  await putLine(cd.service_items[0].id, { is_external: false, line_status: 'CANCELLED' });
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
  check('E3 [A6] DP covers the fee: no cancellation-fee invoice, old invoice CANCELLED, fee stored on the order',
    !after.invoices.some((i) => i.invoice_type === 'CANCELLATION_FEE') && after.invoices.find((i) => i.id === dp.id).status === 'CANCELLED' &&
    Number(after.cancellation_fee) === 200000 && after.cancellation_reason === 'Pelanggan batal' && !!after.cancelled_at);
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
  const p7 = await markPaid(o2.id, inv7.data.id, { amount_received: 1_100_000 });
  const ord7 = await order(o2.id);
  check('G7 overpayment: PAID, paid_to_date 1.100.000', p7.status === 200 && ord7.payment_status === 'PAID' && Number(ord7.paid_to_date) === 1100000);
  check('G8 mark-paid without proof refused (400)', (await call('POST', `/orders/${o2.id}/invoice/${inv7.data.id}/mark-paid`, { token: admin, form: new FormData() })).status === 400);
  const rf = new FormData();
  rf.append('proof', jpeg(), 'r.jpg');
  const ref = await call('POST', `/orders/${o2.id}/mark-refunded`, { token: admin, form: rf });
  check('G9 refund marked with proof (100.000)', ref.status === 200 && Number(ref.data.refund_amount) === 100000);
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
  await markPaid(o5.id, fee.id, { amount_received: 50_000 });
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
  check('O14 [A7] cancel after day 1: tier 3, fee = the paid total 1.000.000, no invoice; order open, awaiting finalization',
    c5.data?.tier === 3 && c5.data.penalty === 1000000 && c5.data.stillOwed === 0 && noFeeInvoice(o5a) &&
    o5a.order_status !== 'CANCELLED' && o5a.awaiting_finalization === true && Number(o5a.cancellation_fee) === 1000000,
    `${JSON.stringify(c5.data ?? c5.json)} ${o5a.order_status}`);
  check('O15 [A7] Dashboard: day 2 leaves revenue, the fee takes its place (revenue and margin unchanged)',
    diff(before, after, 'accrual.revenue') === 0 && diff(before, after, 'accrual.margin') === 0 && diff(before, after, 'accrual.cancellation_income') === 500000,
    show(before, after, ['accrual.revenue', 'accrual.margin', 'accrual.cancellation_income']));
  const fin5 = await prisma.orderFinalFinance.findUnique({ where: { order_id: o5.id } });
  check('O16 order card: total 1.000.000, margin 800.000 (total − day-1 driver fee)', Number(fin5?.total_user_amount) === 1000000 && Number(fin5?.margin_amount) === 800000, `${fin5?.total_user_amount} / ${fin5?.margin_amount}`);
  const resave = await putLine(day1, { is_external: false, driver_fee: 200000 });
  const o5b = await order(o5.id);
  check('O17 re-saving the done day keeps the fee as the order total (no fake refund)',
    resave.status === 200 && Number(o5b.final_price) === 1000000 && o5b.payment_status === 'PAID', `${resave.status} ${o5b.final_price} ${o5b.payment_status}`);
  check('O18 the cancelled day stays closed (409)', (await putLine(day2, { is_external: false, line_status: 'SCHEDULED' })).status === 409);
  const again = await call('POST', `/orders/${o5.id}/cancel`, { token: admin, body: { reason: 'lagi' } });
  const edit = await call('PUT', `/orders/${o5.id}`, { token: admin, body: editBody(o5b, { notes: 'x' }) });
  const charge = await call('POST', `/orders/${o5.id}/adjustments`, { token: admin, body: { type: 'OVERTIME', description: 'OT', amount: 50000 } });
  check('O19 second cancel, Edit Order and new charges refused (409)', again.status === 409 && edit.status === 409 && charge.status === 409, `${again.status} ${edit.status} ${charge.status}`);
  const fz = await call('POST', `/orders/${o5.id}/finalize`, { token: admin });
  const log = await prisma.orderChangeLog.findFirst({ where: { order_id: o5.id, new_value: 'DONE' } });
  check('O20 [A7] finalize closes it as DONE, the cancellation in the note', fz.status === 200 && fz.data?.order_status === 'DONE' && /remaining days were cancelled/.test(log?.note ?? ''), log?.note);
});

// ── P. Cancelled days, billed totals and the DP minimum (B1, B2, B7, B12) ──
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
  const p1 = await putLine(o1.service_items[0].id, { is_external: false, line_status: 'CANCELLED' });
  check('Q1 [B1.1] cancelling the only day in Edit Hari refused (409, points to Batalkan Pesanan), day and order unchanged',
    p1.status === 409 && /hari terakhir yang masih aktif/.test(p1.json?.message ?? '') && /Batalkan Pesanan/.test(p1.json?.message ?? '') &&
    (await line(o1.service_items[0].id)).line_status === 'SCHEDULED' && (await order(o1.id)).order_status !== 'CANCELLED', p1.json?.message);
  const o2 = await makeOrder('Q2', { days: 2, startDay: 21 });
  const p2a = await putLine(o2.service_items[0].id, { is_external: false, line_status: 'CANCELLED' });
  const o2a = await order(o2.id);
  check('Q2 [B1.1] one day of a two-day order can be cancelled; total 1.000.000', p2a.status === 200 && Number(o2a.final_price) === 1000000, `${p2a.status} ${p2a.json?.message ?? ''} ${o2a.final_price}`);
  const p2b = await putLine(o2.service_items[1].id, { is_external: false, line_status: 'CANCELLED' });
  check('Q3 [B1.1] the remaining day then refused (409), order not cancelled',
    p2b.status === 409 && /hari terakhir/.test(p2b.json?.message ?? '') && (await order(o2.id)).order_status !== 'CANCELLED', p2b.json?.message);
  // Day 1 done, day 2 still to run: cancelling or removing day 2 would end the order.
  const o3 = await makeOrder('Q4', { days: 2, startDay: 22 });
  const [d1st, d2nd] = [...o3.service_items].sort((a, b) => a.service_date.localeCompare(b.service_date)).map((l) => l.id);
  await prisma.orderServiceItem.update({ where: { id: d1st }, data: { line_status: 'DONE' } });
  const p4 = await putLine(d2nd, { is_external: false, line_status: 'CANCELLED' });
  check('Q4 [B1.1] day 1 done: cancelling day 2 in Edit Hari refused (409)', p4.status === 409 && /hari terakhir/.test(p4.json?.message ?? '') && (await line(d2nd)).line_status === 'SCHEDULED', p4.json?.message);
  const p5 = await call('PUT', `/orders/${o3.id}`, { token: admin, body: editBody(await order(o3.id), { reason: 'hapus hari', days: [{ id: d1st }] }) });
  check('Q5 [B1.1] nor removed in Edit Order (409), day kept', p5.status === 409 && /hari terakhir/.test(p5.json?.message ?? '') && (await order(o3.id)).service_items.length === 2, p5.json?.message);

  // B1.3: Edit Hari does not push the total below what is billed.
  const o4 = await makeOrder('Q6', { days: 2, startDay: 23 });
  const full4 = (await invoice(o4.id, 'FULL', 2_000_000)).data;
  const p6 = await putLine(o4.service_items[1].id, { is_external: false, line_status: 'CANCELLED' });
  const o4a = await order(o4.id);
  check('Q6 [B1.3] cancelling a day below the issued invoice refused (409, both amounts), day and total unchanged',
    p6.status === 409 && /Rp 1\.000\.000/.test(p6.json?.message ?? '') && /Rp 2\.000\.000/.test(p6.json?.message ?? '') && /Revisi atau batalkan invoice/.test(p6.json?.message ?? '') &&
    o4a.service_items.every((l) => l.line_status === 'SCHEDULED') && Number(o4a.final_price) === 2000000, p6.json?.message);
  const rv4 = await revise(o4, full4, 1_000_000);
  const p7 = await putLine(o4.service_items[1].id, { is_external: false, line_status: 'CANCELLED' });
  check('Q7 [B1.3] after revising the invoice to 1.000.000 the day can be cancelled; total 1.000.000',
    rv4.status === 201 && p7.status === 200 && Number((await order(o4.id)).final_price) === 1000000, `${rv4.status} ${p7.status} ${p7.json?.message ?? ''}`);

  // B2: DP_PAID needs 20% of the rental base actually received.
  const o5 = await makeOrder('Q8', { startDay: 24 });
  const dp5 = (await invoice(o5.id, 'DP', 200_000)).data;
  await markPaid(o5.id, dp5.id, { amount_received: 50_000 });
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
  await putLine(o8.service_items[1].id, { is_external: false, line_status: 'CANCELLED' });
  const dp8 = await invoice(o8.id, 'DP', 200_000);
  check('Q13 [B7] DP base without the cancelled day: 200.000 (20% of 1.000.000) accepted', dp8.status === 201, `${dp8.status} ${dp8.json?.message ?? ''}`);
  const dpPdf = dp8.data?.file_url ? await pdfText(dp8.data.file_url) : '';
  const stmt8 = await call('POST', `/orders/${o8.id}/statement`, { token: admin, body: {} });
  const stPdf = stmt8.data?.statement_url ? await pdfText(stmt8.data.statement_url) : '';
  check('Q14 [B7] invoice and statement PDFs print the cancelled day as "(Dibatalkan)"; statement total 1.000.000',
    /\(Dibatalkan\)/.test(dpPdf) && /\(Dibatalkan\)/.test(stPdf) && Number(stmt8.data?.final_price) === 1000000,
    `dp ${/Dibatalkan/.test(dpPdf)} statement ${/Dibatalkan/.test(stPdf)} ${stmt8.data?.final_price}`);
  const o9 = await makeOrder('Q15', { days: 2, startDay: 29 });
  const dp9 = (await invoice(o9.id, 'DP', 400_000)).data;
  await markPaid(o9.id, dp9.id, { amount_received: 300_000 });
  const before9 = (await order(o9.id)).payment_status;
  await putLine(o9.service_items[1].id, { is_external: false, line_status: 'CANCELLED' });
  check('Q15 [B2/B7] 300.000 received: UNPAID on 2 days (min 400.000), DP_PAID once a day is cancelled (min 200.000)',
    before9 === 'UNPAID' && (await order(o9.id)).payment_status === 'DP_PAID', `${before9} → ${(await order(o9.id)).payment_status}`);

  // B12: cancellation fees in whole rupiah.
  const o10 = await makeOrder('Q16', { price: 1_000_003, startDay: 30 });
  const c10 = await call('POST', `/orders/${o10.id}/cancel`, { token: admin, body: { reason: 'tes pembulatan' } });
  const fee10 = (await order(o10.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
  check('Q16 [B12] 20% of 1.000.003 billed as 200.001 (whole rupiah), fee invoice the same',
    c10.status === 200 && c10.data.penalty === 200001 && c10.data.stillOwed === 200001 && Number(fee10?.amount) === 200001 && Number((await order(o10.id)).cancellation_fee) === 200001,
    `${JSON.stringify(c10.data ?? c10.json)} ${fee10?.amount}`);
});

const failed = summary();
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
