# Bunker 9: the official server

One big authoritative server. Up to 32 players plus a few bots, one continuous match loop.

## Run it
```
npm install
SUPABASE_URL=https://ssgtseqlfvekqehuvxrb.supabase.co SUPABASE_SERVICE_KEY=... \
npm start
```
Open http://localhost:8080 (put it behind HTTPS so the page uses `wss://`; Caddy, nginx or a Cloudflare Tunnel all work). Players just open your address and press Deploy.
`npm test` runs the rules and a real WebSocket round trip.

| env var | default | meaning |
|---|---|---|
| MAX_PLAYERS | 32 | human slots |
| BOTS | 3 | bots filling the match |
| PORT | 8080 | HTTP + WebSocket (`/ws`) |
| SNAP_EVERY | 2 | snapshot every N ticks (30 Hz tick) |
| SUPABASE_URL / SUPABASE_SERVICE_KEY | none | optional: saves matches, stats and the leaderboard. The service key is a server secret, never put it in the page |

Players open your address and press Deploy. There are no admins and no special abilities; everyone is equal.

## Database (Supabase)
`supabase/schema.sql` is already applied to your project "Bomb": players (by hashed browser key), lifetime stats, matches,. Row level security is on; browsers can read scores only, all writes go through the server. The menu shows a Top players list from `/api/leaderboard`. To ban someone: set `banned = true` on their row in `b9_players`.

## How it is built
- `shared/sim.js`: the whole game simulation, run by the Node server and, for offline play, inside the page.
- `server/server.js` ticks it at 30 Hz, takes input commands, sends each player only what they may know, serves `public/`; `db.js`, `persist.js` write to Supabase.
- `public/index.html` is the client (`client/` + `build.py` rebuild it). Movement is predicted with the server's own `moveStep` and reconciled.

## Known limits
- No lag compensation for hits yet; fine at low ping.
- One match room.
- A player who leaves before the final whistle doesn't get that match counted.

## Deploy on Koyeb (free)
1. Put this folder in a GitHub repo (new repo, upload the files; `node_modules` is not needed).
2. Koyeb dashboard: Create service, GitHub, pick the repo. Builder: Buildpack (it detects Node and runs `npm start`). Instance: Free.
3. Exposed port: 8000, protocol HTTP, path `/`. Koyeb sets `PORT` for you.
4. Environment variables (all optional): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (as a Secret), `MAX_PLAYERS` (try 8 to 12 on the free instance), `BOTS` (try 2).
5. Deploy. Your game is at `https://<app>.koyeb.app`; players open it and press Deploy. The page connects to `wss://` on the same address automatically.
