'use strict';
/* Thin Supabase (PostgREST) client for the game server. Uses the SERVICE ROLE key, which must only ever live in
 * this server's environment: it bypasses row level security. Returns null when not configured (game runs without persistence). */
function createDb(url, serviceKey) {
  if (!url || !serviceKey) return null;
  const base = url.replace(/\/+$/, '') + '/rest/v1';
  const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  async function call(path, opt) {
    const r = await fetch(base + path, Object.assign({}, opt, { headers: Object.assign({}, headers, opt && opt.headers), signal: AbortSignal.timeout(8000) }));
    const text = await r.text();
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }
  const post = (path, body, extra) => call(path, { method: 'POST', body: JSON.stringify(body), headers: extra });
  return {
    identify: (keyHash, name) => post('/rpc/b9_identify', { p_key_hash: keyHash, p_name: name }),
    recordMatch: (payload) => post('/rpc/b9_record_match', { p: payload }),
    leaderboard: () => call('/b9_player_stats?select=name,wins,matches,frags,deaths,headshots&order=wins.desc,frags.desc&limit=10')
  };
}
module.exports = { createDb };
