'use strict';
/* Turns the world's event stream into database writes: finished matches (with per-player stats). */
function createTracker(world, db, log) {
  log = log || console.log;
  let startedAt = Date.now();
  const tally = new Map();
  const T = (id) => { let t = tally.get(id); if (!t) { t = { shots: 0, hits: 0, hs: 0 }; tally.set(id, t); } return t; };
  function finish(winnerId) {
    const humans = world.fighters.filter(f => !f.bot);
    if (!humans.length) return;
    const sorted = world.fighters.slice().sort((a, b) => (b.frags - a.frags) || (a.deaths - b.deaths));
    const win = world.get(winnerId);
    const payload = {
      started_at: new Date(startedAt).toISOString(),
      duration_s: Math.round(world.t), frag_limit: 15,
      winner_name: win ? win.name : null, winner_player_id: win && win.dbId ? win.dbId : null,
      players: sorted.map(f => { const t = tally.get(f.id) || { shots: 0, hits: 0, hs: 0 };
        return { player_id: f.dbId || null, name: f.name, is_bot: f.bot, frags: f.frags, deaths: f.deaths, headshots: t.hs, shots: t.shots, hits: t.hits }; })
    };
    if (db) db.recordMatch(payload).then(() => log('match recorded'), (e) => log('record failed: ' + e.message));
    return payload;
  }
  return {
    handle(events) {
      for (const e of events) {
        if (e.e === 'shot') { const f = world.get(e.s); if (f && !f.bot) T(e.s).shots++; }
        else if (e.e === 'hit' && e.to) { const t = T(e.to); t.hits++; if (e.hs) t.hs++; }
        else if (e.e === 'start') { tally.clear(); startedAt = Date.now(); }
        else if (e.e === 'over') finish(e.winner);
      }
    }
  };
}
module.exports = { createTracker };
