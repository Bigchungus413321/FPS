/* Bunker 9 - shared, deterministic-enough game simulation.
 * No DOM, no three.js. Runs unchanged in Node (authoritative server) and in the browser
 * (offline "loopback" server and client-side movement prediction).
 * The server owns every rule: damage, ammo, respawns, scoring, items, bots. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.B9Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- constants & map ---------------- */
  var S = 2.5, WALL_H = 3.4, EYE = 1.65, EYE_C = 1.1, LEAN_D = 0.45;
  var FRAG_LIMIT = 15, MATCH_TIME = 300, RESPAWN = 2.5, TICK = 1 / 30;
  var RAW = [
    "11111111111111111111", "10000000100000000001", "10222000100003330001", "10200000000000030001",
    "10200000111100000001", "10000000100000000001", "11110111100001111011", "10000000000000000001",
    "10003300000044400001", "10003000000004000001", "10000000220000000001", "10000000200000000001",
    "11011110000111101111", "10000010000100000001", "10000010000100000001", "10444000000000022001",
    "10400000111100020001", "10000000100000000001", "10000000100000000001", "11111111111111111111"
  ];
  var MW = 20, MH = RAW.length;
  var map = RAW.map(function (r) { return r.padEnd(MW, '1').slice(0, MW).split('').map(Number); });
  function cell(x, y) { return (x < 0 || y < 0 || x >= MW || y >= MH) ? 1 : map[y][x]; }
  function open(s) { return cell(Math.floor(s[0]), Math.floor(s[1])) === 0; }
  var SPAWNS = [[1.5, 1.5], [12.5, 1.5], [17.5, 2.5], [5.5, 3.5], [10.5, 7.5], [3.5, 9.5], [15.5, 9.5],
    [4.5, 13.5], [14.5, 13.5], [17.5, 17.5], [5.5, 17.5], [10.5, 10.5], [17.5, 6.5], [1.5, 18.5], [18.5, 1.5]]
    .filter(open).map(function (s) { return { x: s[0], y: s[1] }; });
  var HEALTH_SPAWNS = [[3.5, 3.5], [16.5, 10.5], [9.5, 13.5], [12.5, 17.5], [15.5, 4.5]].filter(open);
  var AMMO_SPAWNS = [[6.5, 1.5], [14.5, 4.5], [2.5, 7.5], [11.5, 15.5], [17.5, 14.5], [8.5, 3.5], [9.5, 17.5]].filter(open);
  var WAYPOINTS = SPAWNS.concat(HEALTH_SPAWNS.concat(AMMO_SPAWNS).map(function (s) { return { x: s[0], y: s[1] }; }));
  var BOTS = [
    { name: 'Vex', color: '#ff6a3c' }, { name: 'Rook', color: '#3cc8ff' }, { name: 'Juno', color: '#7dff6a' },
    { name: 'Kade', color: '#b88cff' }, { name: 'Mira', color: '#ffd23c' }, { name: 'Sable', color: '#ff7ab8' },
    { name: 'Orin', color: '#8affd6' }, { name: 'Tamsin', color: '#ffae5c' }
  ];
  var PLAYER_COLORS = ['#f0a830', '#4da3ff', '#ff5d73', '#5fe3a1', '#c58bff', '#ffe066', '#ff8a4c', '#6ee7f0', '#e879f9', '#a3e635', '#fb7185', '#94a3b8'];
  var HIT_SPHERES = [
    { y: 1.64, r: 0.19, part: 'head' }, { y: 1.28, r: 0.31, part: 'body' },
    { y: 0.92, r: 0.27, part: 'body' }, { y: 0.42, r: 0.25, part: 'leg' }
  ];
  /* gameplay stats only (models, recoil and hand poses live on the client) */
  var WSTATS = [
    { id: 'm4', mag: 30, reserve: 90, max: 150, cd: 0.1, auto: true, reload: 2.0, dmg: { head: 100, body: 28, leg: 18 }, spread: 0.0025, bloom: 0.004 },
    { id: 'rifle', mag: 10, reserve: 40, max: 70, cd: 0.34, auto: false, reload: 2.5, dmg: { head: 100, body: 72, leg: 46 }, spread: 0.0012, bloom: 0.012 },
    { id: 'p88', mag: 15, reserve: 60, max: 105, cd: 0.15, auto: false, reload: 1.5, dmg: { head: 100, body: 26, leg: 16 }, spread: 0.003, bloom: 0.008 },
    { id: 'water', mag: 100, reserve: 300, max: 400, cd: 0.06, auto: true, reload: 1.8, dmg: { head: 12, body: 6, leg: 4 }, spread: 0.006, bloom: 0.002 }
  ];

  /* ---------------- helpers ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function wrapAng(a) { while (a > Math.PI) a -= 6.283185; while (a < -Math.PI) a += 6.283185; return a; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function moveEntity(o, dx, dy, r) {
    if (cell(Math.floor(o.x + dx + Math.sign(dx) * r), Math.floor(o.y)) === 0) o.x += dx;
    if (cell(Math.floor(o.x), Math.floor(o.y + dy + Math.sign(dy) * r)) === 0) o.y += dy;
  }
  function lineClear(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy), n = Math.max(1, Math.ceil(d / 0.15));
    for (var i = 1; i < n; i++) if (cell(Math.floor(x0 + dx * i / n), Math.floor(y0 + dy * i / n)) !== 0) return false;
    return true;
  }
  function castWall(gx, gy, ang) {
    var rdx = Math.cos(ang), rdy = Math.sin(ang), mx = Math.floor(gx), my = Math.floor(gy);
    var ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9)), stx, sty, sdx, sdy;
    if (rdx < 0) { stx = -1; sdx = (gx - mx) * ddx; } else { stx = 1; sdx = (mx + 1 - gx) * ddx; }
    if (rdy < 0) { sty = -1; sdy = (gy - my) * ddy; } else { sty = 1; sdy = (my + 1 - gy) * ddy; }
    var side = 0, guard = 0, dist = 60;
    while (guard++ < 80) {
      if (sdx < sdy) { dist = sdx; sdx += ddx; mx += stx; side = 0; } else { dist = sdy; sdy += ddy; my += sty; side = 1; }
      if (cell(mx, my) > 0) break;
    }
    return { d: dist, nx: side === 0 ? -stx : 0, nz: side === 1 ? -sty : 0 };
  }
  /* how far (m) a head can lean to one side (sign +1 right, -1 left) before it nears a wall */
  function leanLimit(x, y, yaw, sign) {
    var rx = -Math.sin(yaw) * sign, rz = Math.cos(yaw) * sign, d = 0;
    while (d < LEAN_D + 0.1) {
      if (cell(Math.floor(x + rx * (d + 0.05) / S), Math.floor(y + rz * (d + 0.05) / S)) !== 0) break;
      d += 0.05;
    }
    return Math.max(0, Math.min(LEAN_D, d - 0.2));
  }
  /* Movement shared by the server and by client-side prediction.
   * st needs x, y, moveAmt, sprintAmt, aimAmt. c = {fwd, str, yaw, cr, sp, fr, aim}. Returns whether sprinting. */
  function moveStep(st, c, dt, reloading) {
    var fwd = clamp(num(c.fwd, 0), -1, 1), str = clamp(num(c.str, 0), -1, 1), yaw = num(c.yaw, 0);
    var crouch = !!c.cr, aiming = !!c.aim;
    var sprint = !!c.sp && fwd > 0 && !crouch && !c.fr && !aiming;
    st.aimAmt += ((aiming && !reloading && !sprint ? 1 : 0) - st.aimAmt) * Math.min(1, dt * 11);
    var dX = Math.cos(yaw), dY = Math.sin(yaw);
    var mx = dX * fwd - dY * str, my = dY * fwd + dX * str, len = Math.hypot(mx, my);
    st.moveAmt += ((len > 0 ? 1 : 0) - st.moveAmt) * Math.min(1, dt * 10);
    st.sprintAmt += ((sprint ? 1 : 0) - st.sprintAmt) * Math.min(1, dt * 8);
    if (len > 0) {
      var sp = (crouch ? 1.2 : (sprint ? 3.0 : 2.2)) * (1 - 0.4 * st.aimAmt) * dt / Math.max(1, len);
      moveEntity(st, mx * sp, my * sp, 0.22);
    }
    return sprint;
  }

  /* ---------------- world ---------------- */
  function World(opt) {
    opt = opt || {};
    this.cfg = {
      bots: opt.bots == null ? 5 : clamp(opt.bots | 0, 0, BOTS.length),
      snapEvery: Math.max(1, opt.snapEvery | 0 || 2), maxPlayers: opt.maxPlayers || 12,
      intermission: num(opt.intermission, 10)
    };
    this.fighters = []; this.nextId = 1; this.items = []; this.events = [];
    this.t = 0; this.tick = 0; this.state = 'playing'; this.winner = 0; this.overT = 0; this.boardV = 1;
    this.rand = Math.random;
    var self = this;
    for (var i = 0; i < this.cfg.bots; i++) {
      var f = this.mk(BOTS[i].name, BOTS[i].color, true); f.speed = 0.9 + (i % 3) * 0.1;
    }
    this.buildItems();
    this.fighters.forEach(function (f) { self.spawn(f, true); });
  }
  World.prototype.mk = function (name, color, isBot) {
    var f = {
      id: this.nextId++, name: name, color: color, bot: !!isBot, 
      x: 0, y: 0, hx: 0, hy: 0, yaw: 0, pitch: 0, face: 0, lean: 0, eye: EYE, crouch: false,
      hp: 100, alive: false, frags: 0, deaths: 0, deadT: 0, hitT: 0, protT: 0,
      killedBy: '', killedHS: false, spawnN: 0, sy: 0,
      moveAmt: 0, sprintAmt: 0, aimAmt: 0, bloom: 0, cur: 0, cd: 0, reloadT: 0, wp: [], moving: 0, walkPh: 0,
      flash: 0, shotAgo: 99, lastSeq: -1, tokens: 0.25, lastSnapSeq: -1,
      boardSeen: 0,
      cool: 1, strafeDir: 1, strafeT: 0, goal: null, stuck: 0, speed: 1
    };
    this.fighters.push(f); this.boardV++;
    return f;
  };
  World.prototype.get = function (id) { for (var i = 0; i < this.fighters.length; i++) if (this.fighters[i].id === id) return this.fighters[i]; return null; };
  World.prototype.humans = function () { return this.fighters.filter(function (f) { return !f.bot; }); };
  World.prototype.emit = function (e) { this.events.push(e); };
  World.prototype.buildItems = function () {
    this.items = [];
    var it = this.items;
    HEALTH_SPAWNS.forEach(function (s) { it.push({ x: s[0], y: s[1], type: 'health', taken: false, rt: 0 }); });
    AMMO_SPAWNS.forEach(function (s) { it.push({ x: s[0], y: s[1], type: 'ammo', taken: false, rt: 0 }); });
  };
  World.prototype.addPlayer = function (name) {
    var humans = this.humans().length;
    if (humans >= this.cfg.maxPlayers) return null;
    name = String(name || '').replace(/[^\w \-.]/g, '').trim().slice(0, 14) || ('Player' + this.nextId);
    var f = this.mk(name, PLAYER_COLORS[(this.nextId) % PLAYER_COLORS.length], false);
    this.resetWeapons(f); this.spawn(f, true);
    return f;
  };
  World.prototype.removePlayer = function (id) {
    var f = this.get(id); if (!f) return;
    this.fighters.splice(this.fighters.indexOf(f), 1); this.boardV++;
    this.emit({ e: 'leave', id: id });
  };
  World.prototype.resetWeapons = function (f) { f.cur = 0; f.reloadT = 0; f.wp = WSTATS.map(function (w) { return { ammo: w.mag, reserve: w.reserve }; }); };
  World.prototype.refill = function (f) {
    f.wp.forEach(function (s, i) { s.ammo = WSTATS[i].mag; s.reserve = Math.max(s.reserve, Math.round(WSTATS[i].reserve * 0.5)); });
  };
  World.prototype.spawn = function (f, fresh) {
    var scored = SPAWNS.map(function (s) {
      var m = 1e9;
      this.fighters.forEach(function (o) { if (o !== f && o.alive) m = Math.min(m, Math.hypot(o.x - s.x, o.y - s.y)); });
      return { s: s, m: m };
    }, this).sort(function (a, b) { return b.m - a.m; });
    var pick = scored[Math.floor(this.rand() * Math.min(3, scored.length))].s;
    f.x = pick.x; f.y = pick.y; f.hx = f.x; f.hy = f.y; f.lean = 0; f.hp = 100; f.alive = true; f.deadT = 0; f.protT = 2; f.hitT = 0;
    f.goal = null; f.stuck = 0; f.cool = 0.8 + this.rand(); f.moving = 0; f.eye = EYE; f.crouch = false;
    f.moveAmt = 0; f.sprintAmt = 0; f.aimAmt = 0; f.bloom = 0; f.cd = 0; f.reloadT = 0;
    f.sy = Math.atan2(MH / 2 - f.y, MW / 2 - f.x); f.face = f.sy; f.yaw = f.sy; f.pitch = 0;
    if (!fresh) this.refill(f); else if (!f.wp.length) this.resetWeapons(f);
    f.cur = 0; f.spawnN++;
    this.emit({ e: 'spawn', id: f.id });
  };
  World.prototype.restart = function () {
    var self = this;
    this.fighters.forEach(function (f) { f.frags = 0; f.deaths = 0; f.killedBy = ''; self.resetWeapons(f); });
    this.buildItems(); this.t = 0; this.state = 'playing'; this.winner = 0; this.overT = 0; this.boardV++;
    this.fighters.forEach(function (f) { f.alive = false; });
    this.fighters.forEach(function (f) { self.spawn(f, true); });
    this.emit({ e: 'start' });
  };
  World.prototype.endMatch = function (winner) {
    if (this.state !== 'playing') return;
    var self = this;
    var st = this.fighters.slice().sort(function (a, b) { return (b.frags - a.frags) || (a.deaths - b.deaths); });
    this.state = 'over'; this.overT = 0; this.winner = (winner || st[0] || { id: 0 }).id;
    this.emit({ e: 'over', winner: this.winner });
  };

  /* ---------- combat ---------- */
  World.prototype.hurt = function (f, dmg, by, hs) {
    if (!f.alive || f.protT > 0 || this.state !== 'playing') return false;
    f.hp -= dmg; f.hitT = 0.12;
    if (!f.bot) this.emit({ e: 'hurt', to: f.id, by: by.id, ax: r3(by.x), ay: r3(by.y), hs: !!hs });
    if (f.hp <= 0) this.kill(f, by, hs);
    return true;
  };
  World.prototype.kill = function (f, by, hs) {
    f.hp = 0; f.alive = false; f.deadT = 0; f.deaths++; f.killedBy = by.name; f.killedHS = !!hs;
    if (by !== f) by.frags++;
    this.boardV++;
    this.emit({ e: 'kill', a: by.id, b: f.id, hs: !!hs });
    if (by.frags >= FRAG_LIMIT) this.endMatch(by);
  };
  World.prototype.startReload = function (f) {
    var s = f.wp[f.cur];
    if (!f.alive || this.state !== 'playing' || f.reloadT > 0 || s.ammo >= WSTATS[f.cur].mag || s.reserve <= 0) return;
    f.reloadT = WSTATS[f.cur].reload;
  };
  /* spread uses only server-known state, so clients can't remove it */
  World.prototype.spreadOf = function (f) {
    var W = WSTATS[f.cur];
    var s = W.spread + 0.01 * f.moveAmt + 0.012 * f.sprintAmt + f.bloom;
    if (f.crouch) s *= 0.55;
    return s * (1 - 0.55 * f.aimAmt);
  };
  World.prototype.fire = function (f, a) {
    var W = WSTATS[f.cur], s = f.wp[f.cur];
    if (!f.alive || this.state !== 'playing' || f.reloadT > 0 || f.cd > 0.02) return;
    if (s.ammo <= 0) { f.cd = 0.3; if (s.reserve > 0) this.startReload(f); return; }
    s.ammo--; f.cd = W.cd; f.protT = 0;
    var sp = this.spreadOf(f);
    f.bloom = Math.min(0.03, f.bloom + W.bloom);
    var ang = num(a.yaw, f.yaw) + (this.rand() - 0.5) * 2 * sp;
    var pit = clamp(num(a.pitch, f.pitch) + (this.rand() - 0.5) * 2 * sp, -1.45, 1.45);
    var cp = Math.cos(pit), dx = Math.cos(ang) * cp, dy = Math.sin(pit), dz = Math.sin(ang) * cp;
    var ox = f.hx * S, oy = f.eye - Math.abs(f.lean) * 0.1, oz = f.hy * S;
    var cw = castWall(f.hx, f.hy, ang);
    var tWall = cp > 0.02 ? cw.d * S / cp : 1e9;
    var tF = dy < -1e-4 ? oy / (-dy) : 1e9, tC = dy > 1e-4 ? (WALL_H - oy) / dy : 1e9;
    var tEnv = Math.min(tWall, tF, tC);
    var best = null, bt = 1e9, part = '';
    this.fighters.forEach(function (o) {
      if (o === f) return;
      var px = o.x, py = o.y;
      if (!o.alive) return;
      HIT_SPHERES.forEach(function (hs) {
        var cx = px * S - ox, cy = hs.y - oy, cz = py * S - oz;
        var b = -(cx * dx + cy * dy + cz * dz), c2 = cx * cx + cy * cy + cz * cz - hs.r * hs.r, disc = b * b - c2;
        if (disc < 0) return;
        var tt = -b - Math.sqrt(disc);
        if (tt > 0.1 && tt < bt) { bt = tt; best = o; part = hs.part; }
      });
    });
    var ev = { e: 'shot', s: f.id, w: f.cur, ox: r3(ox), oy: r3(oy), oz: r3(oz), h: 0 };
    if (best && bt < tEnv) {
      ev.ex = r3(ox + dx * bt); ev.ey = r3(oy + dy * bt); ev.ez = r3(oz + dz * bt); ev.h = 1; ev.v = best.id; ev.part = part;
      var hs2 = part === 'head';
      this.emit({ e: 'hit', to: f.id, part: part, hs: hs2 });
      this.hurt(best, W.dmg[part] || W.dmg.body, f, hs2);
    } else {
      var te = Math.min(tEnv, 60);
      ev.ex = r3(ox + dx * te); ev.ey = r3(oy + dy * te); ev.ez = r3(oz + dz * te);
      ev.nx = cw.nx; ev.nz = cw.nz; ev.nt = te === tF ? 1 : (te === tC ? 2 : 0);
    }
    f.flash = 0.07; f.shotAgo = 0;
    this.emit(ev);
    if (s.ammo === 0 && s.reserve > 0) this.startReload(f);
  };

  /* ---------- player commands ---------- */
  /* One input command from a client: {seq, dt, fwd, str, yaw, pitch, ln, cr, sp, fr, aim, wep, rl, fire:{yaw,pitch}} */
  World.prototype.input = function (id, c) {
    var f = this.get(id);
    if (!f || f.bot || !c || typeof c !== 'object') return;
    var seq = c.seq | 0;
    if (seq <= f.lastSeq) return;
    f.lastSeq = seq;
    var dt = clamp(num(c.dt, 0), 0, 0.05);
    dt = Math.min(dt, f.tokens); f.tokens -= dt;     /* a client cannot move faster than real time */
    if (!f.alive || this.state !== 'playing') return;
    f.yaw = num(c.yaw, f.yaw); f.pitch = clamp(num(c.pitch, f.pitch), -1.45, 1.45); f.face = f.yaw;
    f.cd = Math.max(0, f.cd - dt); f.bloom = Math.max(0, f.bloom - dt * 0.05);
    if (f.reloadT > 0) {
      f.reloadT -= dt;
      if (f.reloadT <= 0) { var s0 = f.wp[f.cur], take = Math.min(WSTATS[f.cur].mag - s0.ammo, s0.reserve); s0.ammo += take; s0.reserve -= take; f.reloadT = 0; }
    }
    f.crouch = !!c.cr;
    var ox = f.x, oy = f.y;
    moveStep(f, { fwd: c.fwd, str: c.str, yaw: f.yaw, cr: c.cr, sp: c.sp, fr: c.fr, aim: c.aim }, dt, f.reloadT > 0);
    var moved = Math.hypot(f.x - ox, f.y - oy);
    f.moving += ((moved > 0 ? 1 : 0) - f.moving) * Math.min(1, dt * 8); f.walkPh += dt * 12 * f.moving;
    f.eye += ((f.crouch ? EYE_C : EYE) - f.eye) * Math.min(1, dt * 9);
    var want = clamp(num(c.ln, 0), -LEAN_D, LEAN_D), sign = want > 0 ? 1 : -1;
    if (want !== 0) want = sign * Math.min(Math.abs(want), leanLimit(f.x, f.y, f.yaw, sign));
    f.lean = want;
    f.hx = f.x + (-Math.sin(f.yaw)) * f.lean / S; f.hy = f.y + Math.cos(f.yaw) * f.lean / S;
    if (c.wep != null && (c.wep | 0) !== f.cur && (c.wep | 0) >= 0 && (c.wep | 0) < WSTATS.length) { f.cur = c.wep | 0; f.reloadT = 0; f.cd = Math.max(f.cd, 0.3); }
    if (c.rl) this.startReload(f);
    if (c.fire && typeof c.fire === 'object') this.fire(f, c.fire);
  };

  /* ---------- bots ---------- */
  World.prototype.pickWaypoint = function (b) {
    var best = null;
    for (var i = 0; i < 8; i++) {
      var s = WAYPOINTS[Math.floor(this.rand() * WAYPOINTS.length)];
      if (Math.hypot(s.x - b.x, s.y - b.y) < 2) continue;
      if (lineClear(b.x, b.y, s.x, s.y)) { best = s; break; }
      if (!best) best = s;
    }
    b.goal = best || WAYPOINTS[0]; b.stuck = 0;
  };
  World.prototype.botShoot = function (b, tgt, d) {
    b.flash = 0.07; b.shotAgo = 0;
    var chance = Math.max(0.12, 0.62 - d * 0.04);
    if (tgt.crouch) chance *= 0.85;
    var hit = tgt.protT <= 0 && this.rand() < chance;
    var ty = tgt.bot ? 1.3 : Math.max(0.5, tgt.eye * 0.85), j = hit ? 0.1 : 1.1, r = this.rand.bind(this);
    this.emit({ e: 'shot', s: b.id, w: 0, ox: r3(b.x * S), oy: 1.3, oz: r3(b.y * S),
      ex: r3(tgt.x * S + (r() - 0.5) * j), ey: r3(ty + (r() - 0.5) * j), ez: r3(tgt.y * S + (r() - 0.5) * j), h: hit ? 1 : 0, v: tgt.id, bot: 1, nt: -1 });
    if (hit) this.hurt(tgt, 9, b, false);
  };
  World.prototype.botThink = function (b, dt) {
    if (!b.alive) { b.deadT += dt; if (b.deadT > RESPAWN && this.state === 'playing') this.spawn(b); return; }
    b.hitT = Math.max(0, b.hitT - dt); b.protT = Math.max(0, b.protT - dt); b.cool -= dt; b.strafeT -= dt;
    b.flash = Math.max(0, b.flash - dt); b.shotAgo += dt;
    if (this.state !== 'playing') return;
    if (b.strafeT <= 0) { b.strafeDir = this.rand() < 0.5 ? -1 : 1; b.strafeT = 0.8 + this.rand() * 1.2; }
    var tgt = null, td = 1e9;
    for (var i = 0; i < this.fighters.length; i++) {
      var f = this.fighters[i];
      if (f === b || !f.alive) continue;
      var d = Math.hypot(f.x - b.x, f.y - b.y);
      var seen = lineClear(b.x, b.y, f.x, f.y) || (!f.bot && Math.abs(f.lean) > 0.06 && lineClear(b.x, b.y, f.hx, f.hy));
      if (d < 14 && d < td && seen) { tgt = f; td = d; }
    }
    var mx = 0, my = 0;
    if (tgt) {
      var dx = tgt.x - b.x, dy = tgt.y - b.y, tw = td > 5 ? 1 : (td < 3 ? -1 : 0);
      mx = dx / td * tw - dy / td * b.strafeDir * 0.8; my = dy / td * tw + dx / td * b.strafeDir * 0.8;
      b.face += wrapAng(Math.atan2(dy, dx) - b.face) * Math.min(1, dt * 9);
      if (b.cool <= 0 && td < 11) { b.cool = 0.4 + this.rand() * 0.4; this.botShoot(b, tgt, td); }
    } else {
      if (b.hp < 45) {
        var best = null, bd = 1e9;
        this.items.forEach(function (it) { if (it.taken || it.type !== 'health') return; var dd = Math.hypot(it.x - b.x, it.y - b.y); if (dd < bd) { bd = dd; best = it; } });
        if (best) b.goal = { x: best.x, y: best.y };
      }
      if (!b.goal || Math.hypot(b.goal.x - b.x, b.goal.y - b.y) < 0.6 || b.stuck > 0.8) this.pickWaypoint(b);
      var wx = b.goal.x - b.x, wy = b.goal.y - b.y, wd = Math.hypot(wx, wy) || 1;
      mx = wx / wd; my = wy / wd;
      b.face += wrapAng(Math.atan2(my, mx) - b.face) * Math.min(1, dt * 6);
    }
    var l = Math.hypot(mx, my), moved = 0;
    if (l > 0.01) {
      var sp = 1.8 * b.speed * dt / Math.max(1, l), ox = b.x, oy = b.y;
      moveEntity(b, mx * sp, my * sp, 0.25);
      moved = Math.hypot(b.x - ox, b.y - oy);
      if (moved < sp * 0.3) b.stuck += dt; else b.stuck = 0;
    }
    b.moving += ((moved > 0 ? 1 : 0) - b.moving) * Math.min(1, dt * 8);
    b.walkPh += dt * 12 * b.moving;
    b.hx = b.x; b.hy = b.y;
    if (b.stuck > 0.8 && tgt) { b.strafeDir *= -1; b.stuck = 0; }
  };

  /* ---------- tick ---------- */
  World.prototype.step = function (dt) {
    var self = this;
    this.tick++;
    this.fighters.forEach(function (f) { if (!f.bot) f.tokens = Math.min(0.25, f.tokens + dt); });
    if (this.state === 'over') {
      this.overT += dt;
      if (this.overT >= this.cfg.intermission) this.restart();
    } else {
      this.t += dt;
    }
    this.fighters.slice().forEach(function (f) {
      if (f.bot) { self.botThink(f, dt); return; }
      f.hitT = Math.max(0, f.hitT - dt); f.protT = Math.max(0, f.protT - dt); f.flash = Math.max(0, f.flash - dt); f.shotAgo += dt;
      if (!f.alive) { f.deadT += dt; if (f.deadT > RESPAWN && self.state === 'playing') self.spawn(f); }
    });
    this.items.forEach(function (it) {
      if (it.taken) { it.rt -= dt; if (it.rt <= 0) it.taken = false; return; }
      if (self.state !== 'playing') return;
      for (var j = 0; j < self.fighters.length; j++) {
        var f = self.fighters[j];
        if (!f.alive || Math.hypot(it.x - f.x, it.y - f.y) >= 0.6) continue;
        if (it.type === 'health') {
          if (f.hp >= 100) continue;
          f.hp = Math.min(100, f.hp + 35); if (!f.bot) self.emit({ e: 'pick', to: f.id, type: 'health' });
          it.taken = true; it.rt = 20; return;
        }
        if (f.bot) continue;
        var full = true;
        f.wp.forEach(function (s, i) { if (s.reserve < WSTATS[i].max) full = false; });
        if (full) continue;
        f.wp.forEach(function (s, i) { s.reserve = Math.min(WSTATS[i].max, s.reserve + Math.round(WSTATS[i].mag * 1.2)); });
        self.emit({ e: 'pick', to: f.id, type: 'ammo' });
        it.taken = true; it.rt = 15; return;
      }
    });
    if (this.state === 'playing' && this.t >= MATCH_TIME) this.endMatch(null);
  };

  /* ---------- snapshots ---------- */
  World.prototype.board = function () {
    return this.fighters.map(function (f) { return [f.id, f.name, f.color, f.frags, f.deaths, f.bot ? 1 : 0]; });
  };
  World.prototype.takeEvents = function () { var e = this.events; this.events = []; return e; };
  /* the state one player is allowed to know */
  World.prototype.snapshot = function (id, events) {
    var f = this.get(id); if (!f) return null;
    var w = f.wp[f.cur] || { ammo: 0, reserve: 0 };
    var you = {
      x: r3(f.x), y: r3(f.y), hp: Math.max(0, Math.ceil(f.hp)), al: f.alive ? 1 : 0, cur: f.cur,
      wp: [].concat.apply([], f.wp.map(function (s) { return [s.ammo, s.reserve]; })), rl: r3(f.reloadT), pt: r3(f.protT),
      kb: f.killedBy, kh: f.killedHS ? 1 : 0, dd: r3(f.deadT), sn: f.spawnN, sy: r3(f.sy),
    };
    var ents = [];
    this.fighters.forEach(function (o) {
      if (o === f) return;
      ents.push([o.id, r3(o.x), r3(o.y), r3(o.face), r3(o.moving), r3(o.flash), o.alive ? 1 : 0, r3(o.protT), r3(o.deadT), r3(o.hitT)]);
    });
    var evs = (events || []).filter(function (ev) {
      if (ev.to !== undefined) return ev.to === id;
      return true;
    });
    var snap = {
      t: 's', k: this.tick, ack: f.lastSeq, you: you, p: ents, ev: evs,
      it: this.items.map(function (it) { return it.taken ? 1 : 0; }).join(''),
      m: { t: r3(this.t), st: this.state === 'playing' ? 0 : 1, w: this.winner, ov: r3(Math.max(0, this.cfg.intermission - this.overT)) }
    };
    if (f.boardSeen !== this.boardV) { snap.b = this.board(); f.boardSeen = this.boardV; }
    return snap;
  };

  return {
    S: S, WALL_H: WALL_H, EYE: EYE, EYE_C: EYE_C, LEAN_D: LEAN_D, FRAG_LIMIT: FRAG_LIMIT, MATCH_TIME: MATCH_TIME, RESPAWN: RESPAWN, TICK: TICK,
    MW: MW, MH: MH, map: map, cell: cell, open: open, SPAWNS: SPAWNS, HEALTH_SPAWNS: HEALTH_SPAWNS, AMMO_SPAWNS: AMMO_SPAWNS, BOTS: BOTS,
    WSTATS: WSTATS, HIT_SPHERES: HIT_SPHERES, moveEntity: moveEntity, lineClear: lineClear, castWall: castWall, leanLimit: leanLimit,
    moveStep: moveStep, wrapAng: wrapAng, World: World
  };
});
