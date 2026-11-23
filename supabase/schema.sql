-- Bunker 9 multiplayer persistence (already applied to the Supabase project "Bomb" as migration bunker9_multiplayer_schema).
-- The game server writes with the service role; browsers can only read the public score tables.

create table public.b9_players (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,                       -- sha256 of the player's private key (kept in their browser)
  display_name text not null check (char_length(display_name) between 1 and 14),
  is_admin boolean not null default false,             -- the server grants Time Stop only when true
  banned boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.b9_matches (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  duration_s integer not null check (duration_s >= 0),
  frag_limit integer not null,
  winner_name text,
  winner_player_id uuid references public.b9_players(id) on delete set null,
  human_count integer not null default 0,
  bot_count integer not null default 0
);
create index b9_matches_ended_idx on public.b9_matches (ended_at desc);
create index b9_matches_winner_idx on public.b9_matches (winner_player_id);
create table public.b9_match_players (
  match_id uuid not null references public.b9_matches(id) on delete cascade,
  slot integer not null,                               -- final placement, 1 = first
  player_id uuid references public.b9_players(id) on delete set null,
  name text not null,
  is_bot boolean not null default false,
  frags integer not null default 0, deaths integer not null default 0, headshots integer not null default 0,
  shots integer not null default 0, hits integer not null default 0,
  primary key (match_id, slot)
);
create index b9_match_players_player_idx on public.b9_match_players (player_id);
create table public.b9_player_stats (
  player_id uuid primary key references public.b9_players(id) on delete cascade,
  name text not null,
  matches integer not null default 0, wins integer not null default 0, frags integer not null default 0,
  deaths integer not null default 0, headshots integer not null default 0, shots integer not null default 0, hits integer not null default 0,
  updated_at timestamptz not null default now()
);
create index b9_player_stats_rank_idx on public.b9_player_stats (wins desc, frags desc);
create table public.b9_admin_log (
  id bigint generated always as identity primary key,
  player_id uuid references public.b9_players(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index b9_admin_log_time_idx on public.b9_admin_log (created_at desc);
create index b9_admin_log_player_idx on public.b9_admin_log (player_id);

alter table public.b9_players enable row level security;
alter table public.b9_matches enable row level security;
alter table public.b9_match_players enable row level security;
alter table public.b9_player_stats enable row level security;
alter table public.b9_admin_log enable row level security;
create policy "scores are public" on public.b9_matches for select to anon, authenticated using (true);
create policy "scores are public" on public.b9_match_players for select to anon, authenticated using (true);
create policy "leaderboard is public" on public.b9_player_stats for select to anon, authenticated using (true);
revoke all on public.b9_players, public.b9_admin_log from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.b9_matches, public.b9_match_players, public.b9_player_stats from anon, authenticated;

create or replace function public.b9_identify(p_key_hash text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9 _.-]', '', 'g'), 14));
  v_row public.b9_players;
begin
  if p_key_hash is null or length(p_key_hash) < 32 then raise exception 'invalid key'; end if;
  if v_name = '' then v_name := 'Player'; end if;
  insert into public.b9_players (key_hash, display_name) values (p_key_hash, v_name)
  on conflict (key_hash) do update set last_seen_at = now(), display_name = excluded.display_name
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.display_name, 'is_admin', v_row.is_admin, 'banned', v_row.banned);
end;
$$;

create or replace function public.b9_record_match(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_winner uuid := nullif(p->>'winner_player_id', '')::uuid; r record; v_pid uuid; v_bot boolean;
begin
  insert into public.b9_matches (started_at, duration_s, frag_limit, winner_name, winner_player_id, human_count, bot_count)
  select (p->>'started_at')::timestamptz, greatest(0, (p->>'duration_s')::int), (p->>'frag_limit')::int, left(p->>'winner_name', 14), v_winner,
         count(*) filter (where not coalesce((x->>'is_bot')::boolean, false)), count(*) filter (where coalesce((x->>'is_bot')::boolean, false))
  from jsonb_array_elements(p->'players') x returning id into v_id;
  for r in select t.x, t.ord from jsonb_array_elements(p->'players') with ordinality as t(x, ord) loop
    v_pid := nullif(r.x->>'player_id', '')::uuid; v_bot := coalesce((r.x->>'is_bot')::boolean, false);
    insert into public.b9_match_players (match_id, slot, player_id, name, is_bot, frags, deaths, headshots, shots, hits)
    values (v_id, r.ord::int, v_pid, left(r.x->>'name', 14), v_bot, coalesce((r.x->>'frags')::int, 0), coalesce((r.x->>'deaths')::int, 0),
            coalesce((r.x->>'headshots')::int, 0), coalesce((r.x->>'shots')::int, 0), coalesce((r.x->>'hits')::int, 0));
    if v_pid is not null and not v_bot then
      insert into public.b9_player_stats (player_id, name, matches, wins, frags, deaths, headshots, shots, hits)
      values (v_pid, left(r.x->>'name', 14), 1, case when v_pid = v_winner then 1 else 0 end, coalesce((r.x->>'frags')::int, 0),
              coalesce((r.x->>'deaths')::int, 0), coalesce((r.x->>'headshots')::int, 0), coalesce((r.x->>'shots')::int, 0), coalesce((r.x->>'hits')::int, 0))
      on conflict (player_id) do update set
        name = excluded.name, matches = public.b9_player_stats.matches + 1, wins = public.b9_player_stats.wins + excluded.wins,
        frags = public.b9_player_stats.frags + excluded.frags, deaths = public.b9_player_stats.deaths + excluded.deaths,
        headshots = public.b9_player_stats.headshots + excluded.headshots, shots = public.b9_player_stats.shots + excluded.shots,
        hits = public.b9_player_stats.hits + excluded.hits, updated_at = now();
    end if;
  end loop;
  return v_id;
end;
$$;
revoke execute on function public.b9_identify(text, text) from public, anon, authenticated;
revoke execute on function public.b9_record_match(jsonb) from public, anon, authenticated;
grant execute on function public.b9_identify(text, text) to service_role;
grant execute on function public.b9_record_match(jsonb) to service_role;

-- Make yourself admin (Time Stop): join once, then run this with the name you used:
--   update public.b9_players set is_admin = true where display_name = 'YourName';

