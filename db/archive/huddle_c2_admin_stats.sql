-- ============================================================
-- Admin stats — single RPC that returns the whole dashboard.
-- ============================================================
-- Run this once in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/dpgexpaqjrgzbwmuohcp/sql/new
-- All statements are idempotent — safe to re-run.
-- ============================================================

-- ---------- 1. Schema gap fix — make sure every room table has created_at ----------
-- The 4 game-room tables were created at different times in this project's
-- history; some already have created_at, some don't. ADD COLUMN IF NOT EXISTS
-- is a no-op when the column is present, so this is safe for all 4 — only
-- the missing ones get it.
--
-- Backfill: when the column was just added, every existing row gets
-- created_at = now() (the column DEFAULT). For historical rows, that's a
-- lie — they really existed earlier. We fix it by copying updated_at down
-- to created_at where created_at > updated_at (only possible if it was just
-- defaulted, since for real rows created_at <= updated_at).
-- Tables that already had created_at are untouched (the WHERE clause has
-- no matches there).

alter table public.hotseat_rooms   add column if not exists created_at timestamptz not null default now();
alter table public.chameleon_rooms add column if not exists created_at timestamptz not null default now();
alter table public.liar_rooms      add column if not exists created_at timestamptz not null default now();
alter table public.mafia_rooms     add column if not exists created_at timestamptz not null default now();

update public.hotseat_rooms   set created_at = updated_at where created_at > updated_at;
update public.chameleon_rooms set created_at = updated_at where created_at > updated_at;
update public.liar_rooms      set created_at = updated_at where created_at > updated_at;
update public.mafia_rooms     set created_at = updated_at where created_at > updated_at;

-- Indexes — every stats query filters by created_at.
create index if not exists hotseat_rooms_created_at_idx   on public.hotseat_rooms   (created_at);
create index if not exists chameleon_rooms_created_at_idx on public.chameleon_rooms (created_at);
create index if not exists liar_rooms_created_at_idx      on public.liar_rooms      (created_at);
create index if not exists mafia_rooms_created_at_idx     on public.mafia_rooms     (created_at);


-- ---------- 2. admin_stats(period) RPC ----------
-- One call, one round-trip. Returns JSONB with every metric the dashboard
-- needs: current count, previous-period count (for the delta), and a
-- 7-point trend array (for the sparkline). Plus a per-game breakdown.
--
-- Period rules:
--   '24h' → last 24h.  Previous = the 24h before that.  7 buckets ~3.4h each.
--   '7d'  → last 7d.   Previous = the 7d before that.   7 buckets of 1 day.
--   '30d' → last 30d.  Previous = the 30d before that.  7 buckets ~4.3d each.
--   'all' → since the very first row.  Previous = empty (delta is N/A —
--           "All time" is shown instead of a percent).  Trend buckets span
--           the full data history (7 even slices).
--
-- "Active players" = distinct hostId across all 4 game room tables, so the
-- same person opening many lobbies still counts as 1 — the user's explicit
-- ask ("not the same person again and again").

create or replace function public.admin_stats(p_period text default '7d')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_now           timestamptz := now();
  v_period_secs   bigint;
  v_cur_start     timestamptz;
  v_prev_start    timestamptz;
  v_bucket_secs   numeric;

  v_active_cur    integer;
  v_active_prev   integer;
  v_active_trend  integer[];

  v_signups_cur   integer;
  v_signups_prev  integer;
  v_signups_trend integer[];

  v_lobbies_cur   integer;
  v_lobbies_prev  integer;
  v_lobbies_trend integer[];

  v_played_cur    integer;
  v_played_prev   integer;
  v_played_trend  integer[];

  v_fb_cur        integer;
  v_fb_prev       integer;
  v_fb_trend      integer[];

  v_by_game       jsonb;
begin
  -- HARD GATE — only admins can run this. Returns a SQL error that the
  -- client surfaces; the data never reaches a non-admin.
  if not public.is_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  -- Resolve period
  if p_period = 'all' then
    -- Find the earliest record across every table the stats query touches,
    -- so the trend buckets span the entire data history (not just a fixed
    -- window). coalesce + a fallback ensures the function never divides by
    -- zero on an empty database.
    select coalesce(
      least(
        (select min(created_at) from public.hotseat_rooms),
        (select min(created_at) from public.chameleon_rooms),
        (select min(created_at) from public.liar_rooms),
        (select min(created_at) from public.mafia_rooms),
        (select min(created_at) from public.feedback_posts),
        (select min(created_at) from auth.users where email is not null)
      ),
      v_now - make_interval(days => 7)
    )
    into v_cur_start;
    -- Previous-period filter `created_at < v_cur_start` returns 0 rows.
    -- That's intentional — for "all time" there is no previous to compare to.
    v_prev_start  := v_cur_start;
    v_bucket_secs := greatest(extract(epoch from (v_now - v_cur_start))::numeric / 7, 1);
  else
    v_period_secs := case p_period
      when '24h' then 24 * 3600
      when '7d'  then 7 * 86400
      when '30d' then 30 * 86400
      else 7 * 86400
    end;
    v_cur_start   := v_now - make_interval(secs => v_period_secs);
    v_prev_start  := v_cur_start - make_interval(secs => v_period_secs);
    v_bucket_secs := v_period_secs::numeric / 7;
  end if;

  -- ====================================================================
  -- Metric 1 — Active players (distinct host_id across 4 game tables)
  -- ====================================================================
  with all_hosts as (
    select state->>'hostId' as host_id, created_at from public.hotseat_rooms
      where created_at >= v_prev_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.chameleon_rooms
      where created_at >= v_prev_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.liar_rooms
      where created_at >= v_prev_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.mafia_rooms
      where created_at >= v_prev_start and state->>'hostId' is not null
  )
  select
    count(distinct host_id) filter (where created_at >= v_cur_start),
    count(distinct host_id) filter (where created_at <  v_cur_start)
  into v_active_cur, v_active_prev
  from all_hosts;

  with all_hosts_cur as (
    select state->>'hostId' as host_id, created_at from public.hotseat_rooms
      where created_at >= v_cur_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.chameleon_rooms
      where created_at >= v_cur_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.liar_rooms
      where created_at >= v_cur_start and state->>'hostId' is not null
    union all
    select state->>'hostId',             created_at from public.mafia_rooms
      where created_at >= v_cur_start and state->>'hostId' is not null
  ),
  bucketed as (
    select least(6, floor(extract(epoch from (created_at - v_cur_start)) / v_bucket_secs)::int) as idx,
           host_id
    from all_hosts_cur
  )
  select array_agg(coalesce(c.c, 0) order by b.idx)
  into v_active_trend
  from generate_series(0, 6) as b(idx)
  left join (
    select idx, count(distinct host_id) as c from bucketed group by idx
  ) c using (idx);

  -- ====================================================================
  -- Metric 2 — Signups (real users only; anonymous sessions excluded
  -- by filtering email IS NOT NULL — works across all Supabase versions)
  -- ====================================================================
  select
    count(*) filter (where created_at >= v_cur_start),
    count(*) filter (where created_at <  v_cur_start)
  into v_signups_cur, v_signups_prev
  from auth.users
  where created_at >= v_prev_start
    and email is not null;

  with signups_cur as (
    select created_at from auth.users
    where created_at >= v_cur_start and email is not null
  )
  select array_agg(coalesce(c.c, 0) order by b.idx)
  into v_signups_trend
  from generate_series(0, 6) as b(idx)
  left join (
    select least(6, floor(extract(epoch from (created_at - v_cur_start)) / v_bucket_secs)::int) as idx,
           count(*) as c
    from signups_cur group by 1
  ) c using (idx);

  -- ====================================================================
  -- Metric 3 — Lobbies created (sum across 4 game tables)
  -- ====================================================================
  with all_lobbies as (
    select created_at from public.hotseat_rooms   where created_at >= v_prev_start
    union all
    select created_at from public.chameleon_rooms where created_at >= v_prev_start
    union all
    select created_at from public.liar_rooms      where created_at >= v_prev_start
    union all
    select created_at from public.mafia_rooms     where created_at >= v_prev_start
  )
  select
    count(*) filter (where created_at >= v_cur_start),
    count(*) filter (where created_at <  v_cur_start)
  into v_lobbies_cur, v_lobbies_prev
  from all_lobbies;

  with lobbies_cur as (
    select created_at from public.hotseat_rooms   where created_at >= v_cur_start
    union all
    select created_at from public.chameleon_rooms where created_at >= v_cur_start
    union all
    select created_at from public.liar_rooms      where created_at >= v_cur_start
    union all
    select created_at from public.mafia_rooms     where created_at >= v_cur_start
  )
  select array_agg(coalesce(c.c, 0) order by b.idx)
  into v_lobbies_trend
  from generate_series(0, 6) as b(idx)
  left join (
    select least(6, floor(extract(epoch from (created_at - v_cur_start)) / v_bucket_secs)::int) as idx,
           count(*) as c
    from lobbies_cur group by 1
  ) c using (idx);

  -- ====================================================================
  -- Metric 4 — Games actually played
  --   (lobbies where the JSONB flag _gamesPlayedCounted is true —
  --    means at least one round was played, not just lobby-then-abandon)
  -- ====================================================================
  with all_played as (
    select created_at from public.hotseat_rooms
      where created_at >= v_prev_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.chameleon_rooms
      where created_at >= v_prev_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.liar_rooms
      where created_at >= v_prev_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.mafia_rooms
      where created_at >= v_prev_start and (state->>'_gamesPlayedCounted')::boolean is true
  )
  select
    count(*) filter (where created_at >= v_cur_start),
    count(*) filter (where created_at <  v_cur_start)
  into v_played_cur, v_played_prev
  from all_played;

  with played_cur as (
    select created_at from public.hotseat_rooms
      where created_at >= v_cur_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.chameleon_rooms
      where created_at >= v_cur_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.liar_rooms
      where created_at >= v_cur_start and (state->>'_gamesPlayedCounted')::boolean is true
    union all
    select created_at from public.mafia_rooms
      where created_at >= v_cur_start and (state->>'_gamesPlayedCounted')::boolean is true
  )
  select array_agg(coalesce(c.c, 0) order by b.idx)
  into v_played_trend
  from generate_series(0, 6) as b(idx)
  left join (
    select least(6, floor(extract(epoch from (created_at - v_cur_start)) / v_bucket_secs)::int) as idx,
           count(*) as c
    from played_cur group by 1
  ) c using (idx);

  -- ====================================================================
  -- Metric 5 — Feedback received
  -- ====================================================================
  select
    count(*) filter (where created_at >= v_cur_start),
    count(*) filter (where created_at <  v_cur_start)
  into v_fb_cur, v_fb_prev
  from public.feedback_posts
  where created_at >= v_prev_start;

  with fb_cur as (
    select created_at from public.feedback_posts where created_at >= v_cur_start
  )
  select array_agg(coalesce(c.c, 0) order by b.idx)
  into v_fb_trend
  from generate_series(0, 6) as b(idx)
  left join (
    select least(6, floor(extract(epoch from (created_at - v_cur_start)) / v_bucket_secs)::int) as idx,
           count(*) as c
    from fb_cur group by 1
  ) c using (idx);

  -- ====================================================================
  -- Per-game breakdown (current period only — share of total lobbies)
  -- ====================================================================
  v_by_game := jsonb_build_object(
    'hotseat',   (select count(*) from public.hotseat_rooms   where created_at >= v_cur_start),
    'chameleon', (select count(*) from public.chameleon_rooms where created_at >= v_cur_start),
    'liar',      (select count(*) from public.liar_rooms      where created_at >= v_cur_start),
    'mafia',     (select count(*) from public.mafia_rooms     where created_at >= v_cur_start)
  );

  -- ====================================================================
  -- Assemble + return
  -- ====================================================================
  return jsonb_build_object(
    'period',          p_period,
    'generated_at',    v_now,
    'current_start',   v_cur_start,
    'previous_start',  v_prev_start,
    'active_players',  jsonb_build_object('current', v_active_cur,  'previous', v_active_prev,  'trend', coalesce(v_active_trend,  array[0,0,0,0,0,0,0])),
    'signups',         jsonb_build_object('current', v_signups_cur, 'previous', v_signups_prev, 'trend', coalesce(v_signups_trend, array[0,0,0,0,0,0,0])),
    'lobbies',         jsonb_build_object('current', v_lobbies_cur, 'previous', v_lobbies_prev, 'trend', coalesce(v_lobbies_trend, array[0,0,0,0,0,0,0])),
    'games_played',    jsonb_build_object('current', v_played_cur,  'previous', v_played_prev,  'trend', coalesce(v_played_trend,  array[0,0,0,0,0,0,0])),
    'feedback',        jsonb_build_object('current', v_fb_cur,      'previous', v_fb_prev,      'trend', coalesce(v_fb_trend,      array[0,0,0,0,0,0,0])),
    'by_game',         v_by_game
  );
end;
$$;

revoke all on function public.admin_stats(text) from public;
grant execute on function public.admin_stats(text) to authenticated;

-- ---------- 3. Sanity check (uncomment + run separately to verify) ----------
-- After signing in as saeedabdulaziz132@gmail.com:
--
--   select public.admin_stats('7d');
--
-- Should return JSON with active_players / signups / lobbies / games_played /
-- feedback / by_game. Anyone else gets "Not authorised".
