// Local stand-in for Supabase Storage, Expo Push and the GA4 collector, for API e2e checks.
import http from 'node:http';

const pushes = [];
const objects = new Map();
// Website deploy hook (price list publish): calls counted, can be made to fail.
const deployHook = { calls: 0, fail: false };
// GA4 Measurement Protocol sends (GA4_COLLECT_URL points here).
const ga4 = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/push' && req.method === 'POST') {
      const msgs = JSON.parse(body.toString() || '[]');
      for (const m of msgs) pushes.push({ at: new Date().toISOString(), ...m });
      return json(200, { data: msgs.map(() => ({ status: 'ok', id: 'x' })) });
    }
    if (url.pathname === '/deploy-hook' && req.method === 'POST') {
      deployHook.calls++;
      return deployHook.fail ? json(500, { error: 'down' }) : json(201, { job: 'x' });
    }
    // ?fail=1 / ?fail=0 switches it; always answers the current state.
    if (url.pathname === '/__deploy-hook') {
      if (url.searchParams.has('fail')) deployHook.fail = url.searchParams.get('fail') === '1';
      return json(200, deployHook);
    }
    if (url.pathname === '/ga4/collect' && req.method === 'POST') {
      ga4.push({ at: new Date().toISOString(), measurement_id: url.searchParams.get('measurement_id'), ...JSON.parse(body.toString() || '{}') });
      return json(200, {});
    }
    if (url.pathname === '/__ga4') return json(200, ga4);
    if (url.pathname === '/__pushes') return json(200, pushes);
    if (url.pathname === '/__objects') return json(200, [...objects.keys()]);
    // The stored bytes of one upload ("<bucket>/<path>"), e.g. to see a stamp.
    if (url.pathname === '/__object') {
      const b = objects.get(url.searchParams.get('key') ?? '');
      if (!b) return json(404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(b);
    }
    if (url.pathname === '/__reset') {
      pushes.length = 0;
      return json(200, { ok: true });
    }
    const sign = url.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
    if (sign) return json(200, { signedURL: `/object/sign/${sign[1]}?token=t` });
    const obj = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (obj && (req.method === 'POST' || req.method === 'PUT')) {
      objects.set(`${obj[1]}/${obj[2]}`, body);
      return json(200, { Key: `${obj[1]}/${obj[2]}`, Id: 'id' });
    }
    // remove([paths]): DELETE /storage/v1/object/<bucket> { prefixes }.
    const del = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/);
    if (del && req.method === 'DELETE') {
      const { prefixes = [] } = JSON.parse(body.toString() || '{}');
      for (const p of prefixes) objects.delete(`${del[1]}/${p}`);
      return json(200, []);
    }
    if (req.method === 'DELETE') return json(200, []);
    return json(200, {});
  });
});
server.listen(Number(process.env.MOCK_PORT || 4600), () => console.log('mock services up'));
