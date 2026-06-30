-- 08 — Enable Realtime for the social subsystem (friends / requests / profiles)
-- =============================================================================
-- WHAT THIS DOES (plain language):
--   Makes the Friends screen update LIVE — when someone sends you a friend
--   request, accepts yours, or changes their name/avatar, it appears on your
--   screen within a second WITHOUT anyone tapping refresh. The app already has
--   the live-update code; this just flips the database switch it needs.
--
-- WHEN TO RUN IT:
--   Only if the two-phone test shows requests do NOT appear live (i.e. the
--   other phone has to refresh to see a new request). If they already appear
--   live, your tables are already enabled and you don't need this.
--
-- IS IT SAFE?
--   Yes. It changes nothing about your data — it only turns on live broadcast
--   for three tables. It's idempotent: running it twice does no harm (each step
--   checks first and skips if already done).
--
-- HOW TO RUN:
--   Supabase dashboard → SQL Editor → paste this whole file → Run.
-- =============================================================================

-- Tables the Friends screen subscribes to from the app:
--   friendships  -> friend requests add / accept / decline / remove
--   profiles     -> a friend editing their display name or avatar (live)
--   room_invites -> game-invite banners (usually already enabled)

-- ---- 1. Add the tables to the realtime publication --------------------------
-- (supabase_realtime is the channel Supabase broadcasts row changes on.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'friendships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'room_invites'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_invites;
  END IF;
END $$;

-- ---- 2. REPLICA IDENTITY FULL ------------------------------------------------
-- WHY THIS MATTERS: these tables have Row Level Security (each person only sees
-- their own rows). For UPDATE and DELETE events (accept / decline / cancel /
-- remove), Postgres by default only ships the row's id — which isn't enough for
-- Supabase to prove the event belongs to you, so it may silently drop it.
-- REPLICA IDENTITY FULL ships the whole row so accept/decline/remove also arrive
-- live, not just brand-new requests. Cheap at this scale.
ALTER TABLE public.friendships  REPLICA IDENTITY FULL;
ALTER TABLE public.profiles     REPLICA IDENTITY FULL;
ALTER TABLE public.room_invites REPLICA IDENTITY FULL;

-- ---- 3. Confirm it worked ----------------------------------------------------
-- This last query just shows you the result. You should see all three rows:
--   friendships | t
--   profiles    | t
--   room_invites| t
SELECT tablename,
       TRUE AS in_realtime_publication
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND schemaname = 'public'
  AND tablename IN ('friendships', 'profiles', 'room_invites')
ORDER BY tablename;
