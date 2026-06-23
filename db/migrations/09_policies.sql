-- ============================================================================
-- 09 — Row-Level Security: enable + policies
-- ----------------------------------------------------------------------------
-- Reconstructed verbatim from the LIVE pg_policies snapshot (2026-06-23).
-- Runs LAST: the policies reference functions defined in 02_helpers.sql
-- (huddle_is_claimant, is_admin), which must already exist.
--
-- Lockdown model (as observed live), per game table:
--   hotseat_rooms   : SELECT(all), INSERT(claimant), UPDATE(claimant)   [direct upsert allowed]
--   chameleon_rooms : SELECT(all), INSERT(claimant)                     [UPDATE/DELETE via RPC only]
--   liar_rooms      : SELECT(all)                                       [INSERT/UPDATE/DELETE via RPC only]
--   mafia_rooms     : SELECT(all), INSERT(claimant)                     [UPDATE/DELETE via RPC only]
-- DELETE is denied on every room table (no DELETE policy) — confirmed by probe.
-- All writes that have no direct policy go through SECURITY DEFINER RPCs.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
-- ============================================================================

ALTER TABLE public.hotseat_rooms   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chameleon_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liar_rooms      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mafia_rooms     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_posts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_votes  ENABLE ROW LEVEL SECURITY;

-- ---------- Game rooms ----------
DROP POLICY IF EXISTS "Anyone can read"     ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Claimant can insert" ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Claimant can update" ON public.hotseat_rooms;
CREATE POLICY "Anyone can read"     ON public.hotseat_rooms FOR SELECT USING (true);
CREATE POLICY "Claimant can insert" ON public.hotseat_rooms FOR INSERT
  WITH CHECK ((auth.uid() IS NOT NULL) AND huddle_is_claimant((state -> 'claimedBy'::text), (auth.uid())::text));
CREATE POLICY "Claimant can update" ON public.hotseat_rooms FOR UPDATE
  USING ((auth.uid() IS NOT NULL) AND huddle_is_claimant((state -> 'claimedBy'::text), (auth.uid())::text));

DROP POLICY IF EXISTS "Anyone can read"     ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Claimant can insert" ON public.chameleon_rooms;
CREATE POLICY "Anyone can read"     ON public.chameleon_rooms FOR SELECT USING (true);
CREATE POLICY "Claimant can insert" ON public.chameleon_rooms FOR INSERT
  WITH CHECK ((auth.uid() IS NOT NULL) AND huddle_is_claimant((state -> 'claimedBy'::text), (auth.uid())::text));

DROP POLICY IF EXISTS "Anyone can read" ON public.liar_rooms;
CREATE POLICY "Anyone can read" ON public.liar_rooms FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anyone can read"     ON public.mafia_rooms;
DROP POLICY IF EXISTS "Claimant can insert" ON public.mafia_rooms;
CREATE POLICY "Anyone can read"     ON public.mafia_rooms FOR SELECT USING (true);
CREATE POLICY "Claimant can insert" ON public.mafia_rooms FOR INSERT
  WITH CHECK ((auth.uid() IS NOT NULL) AND huddle_is_claimant((state -> 'claimedBy'::text), (auth.uid())::text));

-- ---------- Feedback ----------
DROP POLICY IF EXISTS feedback_posts_select_all   ON public.feedback_posts;
DROP POLICY IF EXISTS feedback_posts_insert_own   ON public.feedback_posts;
DROP POLICY IF EXISTS feedback_posts_update_own   ON public.feedback_posts;
DROP POLICY IF EXISTS feedback_posts_admin_update ON public.feedback_posts;
DROP POLICY IF EXISTS feedback_posts_delete_own   ON public.feedback_posts;
DROP POLICY IF EXISTS feedback_posts_admin_delete ON public.feedback_posts;
CREATE POLICY feedback_posts_select_all   ON public.feedback_posts FOR SELECT USING (true);
CREATE POLICY feedback_posts_insert_own   ON public.feedback_posts FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY feedback_posts_update_own   ON public.feedback_posts FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY feedback_posts_admin_update ON public.feedback_posts FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY feedback_posts_delete_own   ON public.feedback_posts FOR DELETE USING (user_id = auth.uid());
CREATE POLICY feedback_posts_admin_delete ON public.feedback_posts FOR DELETE USING (is_admin());

DROP POLICY IF EXISTS feedback_votes_select_all ON public.feedback_votes;
DROP POLICY IF EXISTS feedback_votes_insert_own ON public.feedback_votes;
DROP POLICY IF EXISTS feedback_votes_delete_own ON public.feedback_votes;
CREATE POLICY feedback_votes_select_all ON public.feedback_votes FOR SELECT USING (true);
CREATE POLICY feedback_votes_insert_own ON public.feedback_votes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY feedback_votes_delete_own ON public.feedback_votes FOR DELETE USING (user_id = auth.uid());

-- NOTE: the social subsystem (profiles, friendships, room_invites) has its own
-- RLS policies (present live) but its table DDL is not captured in this repo.
-- It is out of scope for the Phase 4 game-SQL consolidation; manage separately.
