-- ============================================================================
-- 01 — Tables, indexes, realtime publication
-- ----------------------------------------------------------------------------
-- Carried from the original foundation files (rls / rooms-fix / feedback / mafia)
-- and reconciled with the live schema observed during the Phase 4 audit
-- (2026-06-23). Unlike the function files (02–08), this was NOT produced from a
-- live DDL dump — if you do a true from-scratch restore, verify column types,
-- constraints and indexes against the live DB first.
--
-- Idempotent (IF NOT EXISTS). Safe to run on the existing prod DB (no-ops).
-- ============================================================================

-- ---- Game room tables (one row per room; full game state lives in `state`) ----
-- NOTE: hotseat_rooms predates the repo SQL (it was created by hand before the
-- C2 migrations); included here for completeness with the same shape.
CREATE TABLE IF NOT EXISTS public.hotseat_rooms (
  code        text PRIMARY KEY,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chameleon_rooms (
  code        text PRIMARY KEY,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liar_rooms (
  code        text PRIMARY KEY,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mafia_rooms (
  code        text PRIMARY KEY,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Private role table — never SELECTable from the client; read only by the
-- SECURITY DEFINER mafia RPCs. The role CHECK MUST allow the full Cards-mode
-- role set: the canonical start_game inserts 'mafia_leader' and 'child' too.
-- (The original foundation file's CHECK only allowed the base 4 — that was
-- widened in the live DB; this reflects the live, working set.)
CREATE TABLE IF NOT EXISTS public.mafia_roles (
  code        text NOT NULL,
  player_id   text NOT NULL,
  role        text NOT NULL CHECK (role IN ('mafia','mafia_leader','detective','doctor','child','villager')),
  PRIMARY KEY (code, player_id),
  FOREIGN KEY (code) REFERENCES public.mafia_rooms(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hotseat_rooms_updated_at_idx   ON public.hotseat_rooms   (updated_at DESC);
CREATE INDEX IF NOT EXISTS chameleon_rooms_updated_at_idx ON public.chameleon_rooms (updated_at DESC);
CREATE INDEX IF NOT EXISTS liar_rooms_updated_at_idx      ON public.liar_rooms      (updated_at DESC);

-- ---- Feedback ----
CREATE TABLE IF NOT EXISTS public.feedback_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('bug','idea','word','other')),
  text        text NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= 500),
  lang        text NOT NULL DEFAULT 'en',
  edited      boolean NOT NULL DEFAULT false,
  -- admin-moderation columns (added by admin_stats / feedback_admin):
  status            text DEFAULT 'new',
  admin_actioned_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_posts_category_created_idx ON public.feedback_posts (category, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_posts_user_id_idx          ON public.feedback_posts (user_id);

CREATE TABLE IF NOT EXISTS public.feedback_votes (
  post_id     uuid NOT NULL REFERENCES public.feedback_posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS feedback_votes_user_id_idx ON public.feedback_votes (user_id);

-- ---- Admins (read only by the is_admin() SECURITY DEFINER fn) ----
CREATE TABLE IF NOT EXISTS public.admins (
  email      text PRIMARY KEY,
  added_at   timestamptz NOT NULL DEFAULT now()
);
-- Seed your admin account(s) here, e.g.:
--   INSERT INTO public.admins(email) VALUES ('you@example.com') ON CONFLICT DO NOTHING;

-- ---- updated_at triggers (functions defined in 02_helpers.sql) ----
DROP TRIGGER IF EXISTS feedback_posts_set_updated_at ON public.feedback_posts;
CREATE TRIGGER feedback_posts_set_updated_at
  BEFORE UPDATE ON public.feedback_posts
  FOR EACH ROW EXECUTE FUNCTION public.feedback_posts_touch();

DROP TRIGGER IF EXISTS chameleon_rooms_set_updated_at ON public.chameleon_rooms;
CREATE TRIGGER chameleon_rooms_set_updated_at
  BEFORE UPDATE ON public.chameleon_rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS liar_rooms_set_updated_at ON public.liar_rooms;
CREATE TRIGGER liar_rooms_set_updated_at
  BEFORE UPDATE ON public.liar_rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---- Realtime publication (clients subscribe to room-state changes) ----
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hotseat_rooms;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.chameleon_rooms;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.liar_rooms;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mafia_rooms;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.feedback_posts;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.feedback_votes;
EXCEPTION WHEN duplicate_object THEN NULL; -- already published
END $$;
