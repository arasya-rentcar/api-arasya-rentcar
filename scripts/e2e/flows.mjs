// End-to-end checks of the API: what the dashboard and the driver app do,
// against the real API and a throwaway database. Run through run-local.sh.
// Case ids in the output match dashboard-arasya-rentcar/docs/TEST-PLAN.md.
import { call, check, knownIssue, section, summary, ensureAdmin, prisma, jpeg, wibIso, uuid, sleep, pushes, BASE } from './lib.mjs';

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
const [car1, car2, car3, car4, car5] = [await makeCar('Avanza'), await makeCar('Innova'), await makeCar('Xpander'), await makeCar('Zenix'), await makeCar('Hiace')];

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

// ── B. Assignment paths (T4: current behaviour, update when decided) ───────
await section('B. Assignment paths', async () => {
  const oB1 = await makeOrder('B1', { startDay: 2 });
  const inv = await invoice(oB1.id, 'DP', 200_000);
  const paid = await markPaid(oB1.id, inv.data.id);
  check('B1 DP marked paid', paid.status === 200, `status ${paid.status}`);
  check('B2 payment_status DP_PAID', (await order(oB1.id)).payment_status === 'DP_PAID');
  const r = await putLine(oB1.service_items[0].id, { is_external: false, driver_id: d1.id, car_id: car1.id, line_status: 'SCHEDULED' });
  check('B3 per-day assign accepted', r.status === 200, `status ${r.status}`);
  const o = await order(oB1.id);
  check('B4 [T4] per-day assign keeps the day SCHEDULED and the order CREATED', o.service_items[0].line_status === 'SCHEDULED' && o.order_status === 'CREATED');
  check('B6 default fee from the table (12H = 200.000)', Number(o.service_items[0].driver_fee) === 200000, String(o.service_items[0].driver_fee));
  const pay = await prisma.payable.findUnique({ where: { service_item_id: oB1.service_items[0].id } });
  check('B7 payable created UNPAID for the driver', pay?.status === 'UNPAID' && Number(pay.total_amount) === 200000);
  const t = (await call('GET', '/driver/trips?scope=active', { token: d1.token })).data.find((x) => x.id === oB1.service_items[0].id);
  check('B8 app gets the trip SCHEDULED, not accepted', t?.status === 'SCHEDULED' && !t.accepted_at);
  await sleep(500);
  check('B9 driver got "Tugas baru"', (await pushesTo(d1)).some((x) => x.title === 'Tugas baru'));
  const reassign = await call('POST', `/orders/${oB1.id}/reassign`, { token: admin, body: { driver_id: d2.id, car_id: car2.id } });
  check('B10 [T4] "Ganti Semua" refuses a SCHEDULED day (409)', reassign.status === 409);

  const oB2 = await makeOrder('B2', { days: 2, price: 900_000, startDay: 3 });
  await payDp(oB2, 360_000);
  const bulk = await call('POST', `/orders/${oB2.id}/assign`, { token: admin, body: { driver_id: d2.id, car_id: car2.id } });
  check('B11 "Tetapkan untuk Semua" accepted', bulk.status === 201, `${bulk.status} ${bulk.json?.message ?? ''}`);
  const o2 = await order(oB2.id);
  check('B12 bulk assign: days ASSIGNED, order ASSIGNED', o2.service_items.every((l) => l.line_status === 'ASSIGNED') && o2.order_status === 'ASSIGNED');
  const t2 = (await call('GET', '/driver/trips?scope=active', { token: d2.token })).data.find((x) => x.id === o2.service_items[0].id);
  check('B13 [T4] app gets ASSIGNED with accepted_at null', t2?.status === 'ASSIGNED' && !t2.accepted_at);
  check('B14 [T4] driver ON_DUTY days ahead', (await prisma.driver.findUnique({ where: { id: d2.id } })).status === 'ON_DUTY');
  const oB3 = await makeOrder('B3', { price: 800_000, startDay: 6 });
  await payFull(oB3);
  const bulk3 = await call('POST', `/orders/${oB3.id}/assign`, { token: admin, body: { driver_id: d2.id, car_id: car1.id } });
  check('B15 [T4] bulk assign refuses a driver busy on another date (409)', bulk3.status === 409);
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
  check('D1 accept: accepted_at set, status unchanged', acc.status === 200 && !!acc.data.accepted_at && acc.data.status === 'ASSIGNED');
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
  knownIssue('T5', 'D29 a day of a finalized order cannot be reopened', reopen.status === 409, `status ${reopen.status}`);
  if (reopen.status === 200) await putLine(lineId, { is_external: false, line_status: 'DONE' });
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
  check('E3 cancellation-fee invoice issued, old invoice CANCELLED', after.invoices.some((i) => i.invoice_type === 'CANCELLATION_FEE' && i.status === 'ISSUED') && after.invoices.find((i) => i.id === dp.id).status === 'CANCELLED');
  check('E4 driver action on the cancelled day → 404', (await act(d3, o.service_items[0].id, 'start')).status === 404);
  check('E5 cancelling twice refused (409)', (await call('POST', `/orders/${o.id}/cancel`, { token: admin, body: { reason: 'lagi' } })).status === 409);
  check('E6 driver AVAILABLE again', (await prisma.driver.findUnique({ where: { id: d3.id } })).status === 'AVAILABLE');
  const reopen = await putLine(o.service_items[0].id, { is_external: false, line_status: 'SCHEDULED' });
  knownIssue('T5', 'E7 a day of a cancelled order cannot be reopened', reopen.status === 409, `status ${reopen.status}`);
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
  // Money on an invoice voided by a cancellation still counts.
  const o5 = await makeOrder('G15', { startDay: 4 });
  await payDp(o5, 200_000);
  const c5 = await call('POST', `/orders/${o5.id}/cancel`, { token: admin, body: { reason: 'batal' } });
  const fee = (await order(o5.id)).invoices.find((i) => i.invoice_type === 'CANCELLATION_FEE');
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
  const o2 = await makeOrder('K4', { startDay: 3 });
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
  const d4 = await makeDriver(4, { etoll_card: 'Mandiri 6032 ••••1234' });
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
  check('L6 start, resend, second start → one TRIP_STARTED linked to the order', started.length === 1 && started[0].link === `/dashboard/orders/${o.id}` && started[0].order_code === o.order_code && started[0].driver_id === d4.id && started[0].title.includes(`Driver 4 ${tag}`), started[0]?.title);
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

const failed = summary();
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
