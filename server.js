// AI test serveri: DATABASE_URL (Postgres) bo'lsa o'sha, bo'lmasa JSON fayl ishlatiladi.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const HTML = path.join(__dirname, 'public', 'index.html');
const DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
let store;

const better = (a, b) => a.s > b.s || (a.s === b.s && a.t < b.t);

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'on' ? { rejectUnauthorized: false } : false });
    await pool.query('CREATE TABLE IF NOT EXISTS results(key text PRIMARY KEY, name text, score int, secs int, ts bigint)');
    console.log('Saqlash: PostgreSQL');
    return {
      async add(r) {
        await pool.query(
          `INSERT INTO results(key,name,score,secs,ts) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,score=EXCLUDED.score,secs=EXCLUDED.secs,ts=EXCLUDED.ts
           WHERE EXCLUDED.score>results.score OR (EXCLUDED.score=results.score AND EXCLUDED.secs<results.secs)`,
          [r.key, r.n, r.s, r.t, Date.now()]);
      },
      async all() {
        const q = await pool.query('SELECT key,name,score,secs,ts FROM results LIMIT 20000');
        return q.rows.map(x => ({ key: x.key, n: x.name, s: x.score, t: x.secs, d: Number(x.ts) }));
      }
    };
  }
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, 'results.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  console.log('Saqlash: fayl ->', file);
  return {
    async add(r) {
      const old = map[r.key];
      if (!old || better(r, old)) {
        map[r.key] = { key: r.key, n: r.n, s: r.s, t: r.t, d: Date.now() };
        fs.writeFileSync(file, JSON.stringify(map));
      }
    },
    async all() { return Object.values(map); }
  };
}

function sorted(rows) { return rows.sort((a, b) => b.s - a.s || a.t - b.t || a.d - b.d); }
function pub(r) { return { n: r.n, s: r.s, t: r.t }; }

const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(x => now - x < 60000);
  h.push(now); hits.set(ip, h);
  return h.length > 30;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML));
    }
    if (url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url === '/api/board') {
      const all = sorted(await store.all());
      return send(res, 200, { board: all.slice(0, 30).map(pub), total: all.length });
    }
    if (req.method === 'POST' && url === '/api/result') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return send(res, 429, { error: 'Juda ko‘p so‘rov' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 2000) return send(res, 413, { error: 'Katta' }); }
      const d = JSON.parse(body);
      const n = String(d.n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const s = Math.max(0, Math.min(20, parseInt(d.s, 10) || 0));
      const t = Math.max(5, Math.min(7200, parseInt(d.t, 10) || 5));
      if (n.length < 3) return send(res, 400, { error: 'Ism noto‘g‘ri' });
      const key = n.toLowerCase();
      await store.add({ key, n, s, t });
      const all = sorted(await store.all());
      const rank = all.findIndex(x => x.key === key);
      return send(res, 200, { board: all.slice(0, 30).map(pub), rank, total: all.length, mine: pub(all[rank]) });
    }
    send(res, 404, { error: 'Topilmadi' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server xatosi' });
  }
});

initStore().then(s => { store = s; server.listen(PORT, '0.0.0.0', () => console.log('Port', PORT)); })
  .catch(e => { console.error('Bazaga ulanib bo‘lmadi:', e); process.exit(1); });
