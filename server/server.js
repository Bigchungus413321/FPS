'use strict';
/* Bunker 9 authoritative server.
 *   - runs the shared simulation (shared/sim.js) at 30 Hz
 *   - receives input commands, sends per-player snapshots (default 15 Hz)
 *   - serves the game client from ./public */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Sim = require('../shared/sim.js');
const { createDb } = require('./db.js');
const { createTracker } = require('./persist.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const world = new Sim.World({
  bots: process.env.BOTS === undefined ? 3 : parseInt(process.env.BOTS, 10),
  snapEvery: parseInt(process.env.SNAP_EVERY || '2', 10),
  maxPlayers: parseInt(process.env.MAX_PLAYERS || '32', 10),
  intermission: parseFloat(process.env.INTERMISSION || '10')
});

const db = createDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const tracker = createTracker(world, db);
let lbCache = { at: 0, rows: [] };


/* ---------- static files ---------- */
const PUB = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.obj': 'text/plain', '.fbx': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/api/leaderboard') {
    const send = (rows) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(rows)); };
    if (!db) return send([]);
    if (Date.now() - lbCache.at < 30000) return send(lbCache.rows);
    return db.leaderboard().then((rows) => { lbCache = { at: Date.now(), rows: rows || [] }; send(lbCache.rows); }, () => send(lbCache.rows));
  }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    if (file.endsWith('index.html')) buf = Buffer.from(buf.toString('utf8').replace('<!--B9-CONFIG-->', '<script>window.B9={online:true,server:true}</script>'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
const clients = new Map();  // ws -> { id, bucket, last }

function send(ws, obj) {
  if (ws.readyState !== 1 || ws.bufferedAmount > 256 * 1024) return;   // drop instead of queueing for a slow client
  ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const c = { id: 0, bucket: 60, last: Date.now(), alive: true };
  clients.set(ws, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    c.bucket = Math.min(120, c.bucket + (now - c.last) / 1000 * 90); c.last = now;
    if (--c.bucket < 0) { ws.close(1008, 'rate limit'); return; }
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      if (c.id || c.joining) return;
      c.joining = true;
      (async () => {
        /* who is this? A private per-browser key (hashed) identifies a persistent player when a database is configured */
        let ident = null;
        if (db && typeof m.key === 'string' && m.key.length >= 16 && m.key.length <= 128) {
          try { ident = await db.identify(crypto.createHash('sha256').update(m.key).digest('hex'), m.name); }
          catch (e) { console.log('identify failed: ' + e.message); }
        }
        if (ws.readyState !== 1) return;
        if (ident && ident.banned) { send(ws, { t: 'err', msg: 'You are banned from this server.' }); return ws.close(); }
        const f = world.addPlayer(ident ? ident.name : m.name);
        if (!f) { send(ws, { t: 'err', msg: 'Server full' }); return ws.close(); }
        if (ident) f.dbId = ident.id;
        c.id = f.id;
        send(ws, { t: 'w', id: f.id, cfg: { snapEvery: world.cfg.snapEvery } });
        console.log('join', f.name, ident ? '(saved)' : '');
      })();
    } else if (m.t === 'in' && c.id && Array.isArray(m.c)) {
      for (let i = 0; i < Math.min(m.c.length, 8); i++) world.input(c.id, m.c[i]);
    } else if (m.t === 'restart' && world.state === 'over') {
      world.restart();
    }
  });
  ws.on('close', () => { if (c.id) { const f = world.get(c.id); console.log('leave', f && f.name); world.removePlayer(c.id); } clients.delete(ws); });
  ws.on('error', () => {});
});
setInterval(() => { wss.clients.forEach(ws => { const c = clients.get(ws); if (!c) return; if (!c.alive) return ws.terminate(); c.alive = false; try { ws.ping(); } catch (e) {} }); }, 15000);

/* ---------- main loop ---------- */
let prev = process.hrtime.bigint(), acc = 0, pending = [];
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Math.min(0.25, Number(now - prev) / 1e9); prev = now;
  while (acc >= Sim.TICK) {
    acc -= Sim.TICK;
    world.step(Sim.TICK);
    const evs0 = world.takeEvents(); tracker.handle(evs0); pending = pending.concat(evs0);
    if (world.tick % world.cfg.snapEvery === 0) {
      const evs = pending; pending = [];
      clients.forEach((c, ws) => { if (c.id) { const s = world.snapshot(c.id, evs); if (s) send(ws, s); } });
    }
  }
}, 1000 / 60);

const SERVER_NAME = (process.env.SERVER_NAME || 'Bunker 9').slice(0, 32);
server.listen(PORT, () => {
  console.log('Bunker 9 "' + SERVER_NAME + '" on http://localhost:' + PORT + '  (ws path /ws), up to ' + world.cfg.maxPlayers + ' players');
  console.log(db ? 'Database: Supabase connected (matches, stats, leaderboard)' : 'Database: off (set SUPABASE_URL and SUPABASE_SERVICE_KEY to save stats)');
});
