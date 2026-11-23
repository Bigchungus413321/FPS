'use strict';
/* Self test: sim rules + a real WebSocket round trip. Run: npm test */
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const os = require('os'), fs = require('fs');
const tmpData = (n) => path.join(os.tmpdir(), 'b9-test-' + process.pid + '-' + n + '.json');
const Sim = require('../shared/sim.js');
let n = 0; const ok = (m) => console.log('  ok', ++n, m);

/* ---- 1. world rules ---- */
{
  const w = new Sim.World({ bots: 2 });
  const a = w.addPlayer('Ace'), pl = w.addPlayer('Pawn');
  w.step(0.1);
  assert(!('ts' in a) && !('admin' in a)); ok('there is no Time Stop or admin state in the game any more');
  const s = w.snapshot(pl.id, w.takeEvents());
  assert(s.p.some(e => e[0] === a.id) && s.you.ts === undefined && s.you.adm === undefined); ok('everybody sees everybody; snapshots carry no admin fields');
  w.input(pl.id, { seq: 1, dt: 0.033, k: ['KeyZ', 'KeyX', 'KeyZ', 'KeyX', 'KeyX', 'KeyZ'] }); w.step(0.033);
  assert(w.snapshot(a.id, []).p.some(e => e[0] === pl.id)); ok('stray key lists in a command do nothing');
  w.removePlayer(a.id); assert(!w.get(a.id)); ok('disconnect removes player cleanly');
  const p2 = w.addPlayer('Flood'); w.step(0.033);
  const x0 = p2.x, y0 = p2.y; p2.protT = 0;
  for (let i = 0; i < 200; i++) w.input(p2.id, { seq: 1000 + i, dt: 0.05, fwd: 1, yaw: 0, pitch: 0 });
  assert(Math.hypot(p2.x - x0, p2.y - y0) < 2.3 * 0.3); ok('flooded input commands are limited to real time');
  assert(w.input(999, { seq: 1 }) === undefined); ok('unknown id ignored');
  const w2 = new Sim.World({ bots: 1 });
  const a2 = w2.addPlayer('A'); a2.protT = 0; w2.step(0.1);
  const b2 = w2.fighters.find(f => f.bot); b2.protT = 0;
  a2.x = a2.hx = 4.5; a2.y = a2.hy = 7.5; b2.x = 9.5; b2.y = 7.5; a2.tokens = 0.25;
  w2.input(a2.id, { seq: 1, dt: 0.0, yaw: 0, pitch: 0, fire: { yaw: 0, pitch: 0.0 } });
  assert(w2.takeEvents().find(e => e.e === 'hit')); ok('a shot at an enemy in line of sight hits');
}

/* ---- 1b. persistence tracker ---- */
{
  const { createTracker } = require('./persist.js');
  const calls = [];
  const db = { recordMatch: async (p) => { calls.push(['match', p]); } };
  const w = new Sim.World({ bots: 1 });
  const tr = createTracker(w, db, () => {});
  const a = w.addPlayer('Ace'); a.dbId = 'uuid-ace'; a.protT = 0; w.step(0.1);
  const bot = w.fighters.find(f => f.bot); bot.protT = 0;
  a.x = a.hx = 4.5; a.y = a.hy = 7.5; bot.x = 9.5; bot.y = 7.5; a.tokens = 0.25; a.frags = 14;
  w.hurt(bot, 1000, a, true); tr.handle(w.takeEvents());
  const m = calls.find(c => c[0] === 'match'); assert(m && m[1].players[0].player_id === 'uuid-ace' && m[1].winner_player_id === 'uuid-ace' && m[1].players[0].frags >= 15); ok('finished match is recorded with winner, frags and player ids');
  assert(m[1].players.some(p => p.is_bot && p.player_id === null)); ok('bots are recorded without player ids');
}
/* ---- 2. real server ---- */
function client(port, name, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://localhost:' + port + '/ws'); const st = { ws, snaps: [], seq: 1 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, token })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'w') { st.id = m.id; res(st); } else if (m.t === 's') st.snaps.push(m); });
    ws.on('error', rej);
    st.cmd = (extra) => ws.send(JSON.stringify({ t: 'in', c: [Object.assign({ seq: st.seq++, dt: 0.033, fwd: 0, str: 0, yaw: 0, pitch: 0, ln: 0 }, extra)] }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const port = 18080 + Math.floor(Math.random() * 500);
  const srv = spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: port, B9_DATA: tmpData('a') }), stdio: 'pipe' });
  await sleep(800);
  try {
    const a = await client(port, 'One', ''), b = await client(port, 'Two', ''); await sleep(500);
    const sb = b.snaps[b.snaps.length - 1]; assert(sb && sb.p.some(e => e[0] === a.id)); ok('two clients join the one server and see each other');
    a.ws.close(); await sleep(400); const sb3 = b.snaps[b.snaps.length - 1]; assert(!sb3.p.some(e => e[0] === a.id)); ok('disconnect cleans up');
    const bytes = JSON.stringify(sb3).length; console.log('  snapshot size', bytes, 'bytes');
    /* ---- 3. database wiring against a mock Supabase ---- */
    const http = require('http'); const crypto = require('crypto');
    const seen = [];
    const mock = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen.push([req.method, req.url, req.headers.apikey, b]);
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/rest/v1/rpc/b9_identify')) { const j = JSON.parse(b); const boss = j.p_key_hash === crypto.createHash('sha256').update('boss-browser-key-0001').digest('hex'); const ban = j.p_key_hash === crypto.createHash('sha256').update('banned-browser-key-0001').digest('hex');
        res.end(JSON.stringify({ id: boss ? 'id-boss' : 'id-other', name: j.p_name, is_admin: boss, banned: ban })); }
      else if (req.url.startsWith('/rest/v1/b9_player_stats')) res.end(JSON.stringify([{ name: 'Top', wins: 3, matches: 4, frags: 50, deaths: 20, headshots: 9 }]));
      else res.end('null'); }); });
    await new Promise(r => mock.listen(0, r)); const mport = mock.address().port;
    const port2 = port + 1;
    const srv2 = spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: port2, B9_DATA: tmpData('b'), SUPABASE_URL: 'http://localhost:' + mport, SUPABASE_SERVICE_KEY: 'service-secret' }), stdio: 'pipe' });
    await sleep(800);
    const join2 = (name, key) => new Promise((res) => { const ws = new WebSocket('ws://localhost:' + port2 + '/ws'); const st = { ws };
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, key })));
      ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'w' || m.t === 'err') { st.m = m; res(st); } }); ws.on('close', () => { if (!st.m) res(st); }); });
    const boss = await join2('Boss', 'boss-browser-key-0001'), plain = await join2('Plain', 'plain-browser-key-0001'), ban = await join2('Bad', 'banned-browser-key-0001'), guest = await join2('Guest', '');
    assert(boss.m.t === 'w' && plain.m.t === 'w' && boss.m.admin === undefined); ok('identified players join; nobody gets admin rights');
    assert(ban.m.t === 'err'); ok('banned players are refused');
    assert(guest.m.t === 'w'); ok('players without a key still join as guests');
    assert(seen.filter(x => x[1].includes('b9_identify')).length === 3 && seen.every(x => x[2] === 'service-secret')); ok('server talks to Supabase with the service key, only for identified players');
    const lb = await new Promise((res, rej) => http.get('http://localhost:' + port2 + '/api/leaderboard', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
    assert(lb[0].name === 'Top'); ok('leaderboard endpoint serves database rows');
    srv2.kill(); mock.close();
    /* database down: players still get in */
    const port3 = port + 2;
    const srv3 = spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: port3, B9_DATA: tmpData('c'), SUPABASE_URL: 'http://localhost:1', SUPABASE_SERVICE_KEY: 'x' }), stdio: 'pipe' });
    await sleep(800);
    const ws3 = await new Promise((res) => { const ws = new WebSocket('ws://localhost:' + port3 + '/ws'); ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Solo', key: 'some-browser-key-00001' }))); ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'w') res(m); }); });
    assert(ws3.t === 'w'); ok('game keeps working when the database is unreachable');
    srv3.kill();
    console.log('ALL PASSED (' + n + ')');
  } catch (e) { console.error('FAILED', e); process.exitCode = 1; }
  srv.kill(); process.exit(process.exitCode || 0);
})();
