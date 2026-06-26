-- ============================================================================
-- db/fix/04 — Auto-delete idle game rooms (the room "janitor")
-- ----------------------------------------------------------------------------
-- WHAT THIS DOES
--   Game rooms (hotseat / chameleon / liar / mafia) currently live in the
--   database FOREVER. "Close room" only flags the state; nothing ever removes
--   the row. This adds a small scheduled job that deletes a room once it has
--   gone untouched (no game activity) for a set time — default 12 HOURS.
--
--   Why 12 hours and not less: "who is connected" is tracked live (over the
--   realtime connection), NOT written to the database. A room's row only gets
--   touched when the game actually does something. So a real session that
--   pauses (a long Mafia discussion, a dinner break, switching games and back)
--   can sit for HOURS with everyone still present but no database write. A
--   window comfortably longer than any single sitting guarantees we never
--   delete a game people are still playing. Keeping an abandoned room a few
--   extra hours costs almost nothing (a few KB); deleting a live game is a
--   hard, surprising failure. 12h still clears rooms the same day.
--   --> To tune it, change the ONE number `interval '12 hours'` in both places
--       below (the function default AND the schedule) and re-run.
--
-- TWO PARTS — run PART A first, then PART B:
--   PART A — triggers + cleanup function. Always safe; needs nothing special.
--   PART B — turns on the schedule (needs the pg_cron extension). It is wrapped
--            so that if pg_cron is not enabled yet it prints a friendly message
--            instead of crashing — then enable it ONCE in the Supabase dashboard
--            (Database -> Extensions -> search "pg_cron" -> Enable) and re-run
--            PART B. Run PART B in the SQL editor's DEFAULT "postgres" database;
--            pg_cron only runs jobs there.
--
-- Idempotent: safe to run more than once.
-- ============================================================================


-- =========================== PART A (always safe) ===========================

-- 1) Make `updated_at` mean "last activity" on ALL FOUR room tables.
--    chameleon_rooms and liar_rooms already bump updated_at on every change
--    (triggers in 01_tables.sql). hotseat_rooms and mafia_rooms were MISSING
--    that trigger, so their updated_at never moved past creation time. Without
--    this fix the janitor below would treat those two as "idle since creation"
--    and could delete a still-active session. Adding the triggers makes idle
--    time consistent everywhere. touch_updated_at() lives in 02_helpers.sql.
drop trigger if exists hotseat_rooms_set_updated_at on public.hotseat_rooms;
create trigger hotseat_rooms_set_updated_at
  before update on public.hotseat_rooms
  for each row execute function public.touch_updated_at();

drop trigger if exists mafia_rooms_set_updated_at on public.mafia_rooms;
create trigger mafia_rooms_set_updated_at
  before update on public.mafia_rooms
  for each row execute function public.touch_updated_at();

-- One-time backfill: mafia_rooms.updated_at is the only nullable one; give any
-- legacy NULL rows a real value so the idle check (and its index) work cleanly.
update public.mafia_rooms set updated_at = created_at where updated_at is null;

-- Index for the cleanup scan. mafia_rooms was the ONLY room table missing this;
-- hotseat/chameleon/liar already have updated_at indexes from 01_tables.sql.
create index if not exists mafia_rooms_updated_at_idx on public.mafia_rooms (updated_at desc);


-- 2) The cleanup function. Deletes rooms with no activity for `p_max_idle`.
--    Returns how many rooms were removed (handy for a one-off manual test).
--    mafia_roles rows are removed automatically (FK ON DELETE CASCADE).
--    The 3 NOT NULL tables use a bare `updated_at` predicate so their index is
--    used; mafia keeps coalesce() as belt-and-suspenders for any stray NULL.
create or replace function public.huddle_cleanup_idle_rooms(p_max_idle interval default interval '12 hours')
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_cutoff  timestamptz := now() - p_max_idle;
  v_total   integer := 0;
  v_n       integer;
begin
  delete from public.hotseat_rooms   where updated_at < v_cutoff;
  get diagnostics v_n = row_count;  v_total := v_total + v_n;

  delete from public.chameleon_rooms where updated_at < v_cutoff;
  get diagnostics v_n = row_count;  v_total := v_total + v_n;

  delete from public.liar_rooms      where updated_at < v_cutoff;
  get diagnostics v_n = row_count;  v_total := v_total + v_n;

  delete from public.mafia_rooms     where coalesce(updated_at, created_at) < v_cutoff;
  get diagnostics v_n = row_count;  v_total := v_total + v_n;

  return v_total;
end;
$$;

-- Lock the function down: it must NOT be callable by website visitors. The
-- pg_cron worker and the service role run as the function OWNER (postgres) and
-- keep EXECUTE regardless of this REVOKE; only anon/authenticated PostgREST
-- callers are blocked, so the public web app can never trigger a mass delete.
revoke all on function public.huddle_cleanup_idle_rooms(interval) from public;
revoke all on function public.huddle_cleanup_idle_rooms(interval) from anon, authenticated;

-- OPTIONAL one-off test — uncomment, run, and it returns how many it cleared:
--   select public.huddle_cleanup_idle_rooms(interval '12 hours');


-- ===================== PART B (turn on the schedule) ========================
-- Wrapped so a missing pg_cron prints a clear message instead of crashing.
-- pg_cron schedules are evaluated in UTC (the every-30-min schedule below is
-- unaffected by that; only a fixed time-of-day would need the UTC offset).
do $$
begin
  create extension if not exists pg_cron;

  -- cron.schedule upserts by job name, so re-running just updates the job.
  perform cron.schedule(
    'huddle-cleanup-idle-rooms',
    '*/30 * * * *',                                  -- every 30 minutes
    $job$ select public.huddle_cleanup_idle_rooms(interval '12 hours'); $job$
  );

  raise notice 'Room janitor scheduled: every 30 min, deletes rooms idle > 12h.';
exception
  when insufficient_privilege or undefined_file or undefined_object then
    raise notice 'pg_cron is not enabled yet. In Supabase: Database -> Extensions -> enable "pg_cron", then re-run PART B.';
end $$;

-- ----------------------------------------------------------------------------
-- Handy later:
--   CHANGE the idle window:  edit '12 hours' (both places) and re-run.
--   TURN IT OFF:             select cron.unschedule('huddle-cleanup-idle-rooms');
--   SEE the job:             select * from cron.job where jobname = 'huddle-cleanup-idle-rooms';
--   SEE recent runs:         select * from cron.job_run_details order by start_time desc limit 10;
-- ============================================================================
