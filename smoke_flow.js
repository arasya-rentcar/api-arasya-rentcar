const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const BASE = 'http://127.0.0.1:3001/api/v1';
const BOT = process.env.BOT_INTERNAL_TOKEN;
const SECRET = process.env.JWT_SECRET;
const ADMIN_ID = '9609d943-4118-4bd5-b654-a9e94a8f4ba3';
const DRIVER_ID = '98625352-f841-41b9-b485-c4623e8e414f';
const DRIVER_PHONE = '081234567890';
const CAR_ID = '3abd058d-a865-4aa3-b8cc-acc613a9c727';

const adminToken = jwt.sign({ user_id: ADMIN_ID, role: 'ADMIN' }, SECRET, { expiresIn: '1h' });

async function call(method, path, body, token, isBot) {
  const headers = { 'Content-Type': 'application/json' };
  if (isBot) headers['x-bot-token'] = BOT;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function showOrder(id, label) {
  const o = await p.order.findUnique({ where: { id }, select: { order_code:true, order_status:true, awaiting_finalization:true } });
  const lines = await p.orderServiceItem.findMany({ where: { order_id: id }, select: { line_status:true, actual_start_at:true, actual_pickup_at:true, trip_finished_at:true, finish_reported_at:true } });
  console.log(`\n--- ${label} ---`);
  console.log(`order: status=${o.order_status} awaiting_finalization=${o.awaiting_finalization}`);
  lines.forEach((l,i)=>console.log(`  line[${i}]: ${l.line_status} | start=${l.actual_start_at?'Y':'-'} pickup=${l.actual_pickup_at?'Y':'-'} dropoff=${l.trip_finished_at?'Y':'-'} finishRep=${l.finish_reported_at?'Y':'-'}`));
  return { o, lines };
}

(async () => {
  console.log('=== bot header check: trying x-bot-token ===');
  // 1) create order
  const create = await call('POST','/bot/orders',{
    customer_name:'SMOKE TEST CUSTOMER', customer_phone:'080000000000',
    pickup_location:'Garage A', dropoff_location:'Airport',
    order_date: new Date().toISOString(), final_price: 500000,
    service_type:'Drop', raw_order_text:'SMOKE TEST',
  }, null, true);
  console.log('create:', create.status, JSON.stringify(create.json).slice(0,300));
  if (create.status >= 300) { await p.$disconnect(); process.exit(1); }
  const order = create.json.data || create.json;
  const orderId = order.id; const code = order.order_code;
  console.log('orderId=', orderId, 'code=', code);
  await showOrder(orderId, 'AFTER CREATE');

  // 2) assign driver+car
  const assign = await call('POST',`/bot/orders/${orderId}/assign`,{ driver_id: DRIVER_ID, car_id: CAR_ID, driver_phone: DRIVER_PHONE, driver_type:'INTERNAL' }, null, true);
  console.log('\nassign:', assign.status, JSON.stringify(assign.json).slice(0,200));
  await showOrder(orderId, 'AFTER ASSIGN');

  // 3) #start
  const start = await call('POST',`/bot/orders/${orderId}/start`,{ driver_phone: DRIVER_PHONE, report_type:'START', input_type:'TEXT', notes:'depart garage', status:'MATCHED' }, null, true);
  console.log('\nstart:', start.status, JSON.stringify(start.json).slice(0,120));
  await showOrder(orderId, 'AFTER #start (expect line IN_PROGRESS, actual_start_at)');

  // 4) #arrive -> ARRIVE_CUSTOMER report
  const arrive = await call('POST',`/bot/orders/${orderId}/reports`,{ driver_phone: DRIVER_PHONE, report_type:'ARRIVE_CUSTOMER', input_type:'TEXT', notes:'arrived at customer', status:'MATCHED' }, null, true);
  console.log('\narrive:', arrive.status, JSON.stringify(arrive.json).slice(0,120));
  await showOrder(orderId, 'AFTER #arrive (expect actual_pickup_at)');

  // 5) #finish
  const finish = await call('POST',`/bot/orders/${orderId}/finish`,{ driver_phone: DRIVER_PHONE, notes:'dropped off' }, null, true);
  console.log('\nfinish:', finish.status, JSON.stringify(finish.json).slice(0,120));
  const afterFinish = await showOrder(orderId, 'AFTER #finish (expect line DONE, order IN_PROGRESS, awaiting=TRUE)');

  // 6) admin finalize
  const fin = await call('POST',`/orders/${orderId}/finalize`, {}, adminToken, false);
  console.log('\nfinalize:', fin.status, JSON.stringify(fin.json).slice(0,160));
  await showOrder(orderId, 'AFTER FINALIZE (expect order DONE, awaiting=FALSE)');

  // 7) double-finalize should 409
  const fin2 = await call('POST',`/orders/${orderId}/finalize`, {}, adminToken, false);
  console.log('\nfinalize-again (expect 409):', fin2.status, JSON.stringify(fin2.json).slice(0,160));

  console.log('\nTEST_ORDER_ID=' + orderId);
  await p.$disconnect();
})().catch(e=>{console.error('ERR', e.message); process.exit(1)});
