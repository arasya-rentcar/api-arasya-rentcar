// Local stand-in for Supabase Storage + Expo Push, for API e2e checks.
import http from 'node:http';

const pushes = [];
const objects = new Map();

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
    if (url.pathname === '/__pushes') return json(200, pushes);
    if (url.pathname === '/__objects') return json(200, [...objects.keys()]);
    if (url.pathname === '/__reset') {
      pushes.length = 0;
      return json(200, { ok: true });
    }
    const sign = url.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
    if (sign) return json(200, { signedURL: `/object/sign/${sign[1]}?token=t` });
    const obj = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (obj && (req.method === 'POST' || req.method === 'PUT')) {
      objects.set(`${obj[1]}/${obj[2]}`, body.length);
      return json(200, { Key: `${obj[1]}/${obj[2]}`, Id: 'id' });
    }
    if (req.method === 'DELETE') return json(200, []);
    return json(200, {});
  });
});
server.listen(Number(process.env.MOCK_PORT || 4600), () => console.log('mock services up'));
