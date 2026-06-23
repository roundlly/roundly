-- ============================================================================
-- Huddle / Roundlly — C2 Security Fix ROLLBACK
-- ============================================================================
--
-- Restores the pre-C2 open RLS policies. Run if the C2 migration broke the
-- app and you need to revert quickly.
--
-- This drops the new claimant policies, drops the RPC functions, and
-- recreates the "anyone can do anything" policies.
-- ============================================================================

-- Drop new policies
DROP POLICY IF EXISTS "Anyone can read"      ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Claimant can insert"  ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Claimant can update"  ON public.hotseat_rooms;

DROP POLICY IF EXISTS "Anyone can read"      ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Claimant can insert"  ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Claimant can update"  ON public.chameleon_rooms;

DROP POLICY IF EXISTS "Anyone can read"      ON public.liar_rooms;
DROP POLICY IF EXISTS "Claimant can insert"  ON public.liar_rooms;
DROP POLICY IF EXISTS "Claimant can update"  ON public.liar_rooms;

-- Drop RPC functions
DROP FUNCTION IF EXISTS public.huddle_create_room(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.huddle_claim_seat (TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.huddle_leave_seat (TEXT, TEXT);
DROP FUNCTION IF EXISTS public.huddle_close_room (TEXT, TEXT);
DROP FUNCTION IF EXISTS public.huddle_assert_room_table(TEXT);
DROP FUNCTION IF EXISTS public.huddle_is_claimant(JSONB, TEXT);

-- Recreate open policies (matches the original prototype bootstrap)
CREATE POLICY "Public read"   ON public.hotseat_rooms   FOR SELECT USING (true);
CREATE POLICY "Public insert" ON public.hotseat_rooms   FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update" ON public.hotseat_rooms   FOR UPDATE USING (true);

CREATE POLICY "Public read"   ON public.chameleon_rooms FOR SELECT USING (true);
CREATE POLICY "Public insert" ON public.chameleon_rooms FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update" ON public.chameleon_rooms FOR UPDATE USING (true);

CREATE POLICY "Public read"   ON public.liar_rooms      FOR SELECT USING (true);
CREATE POLICY "Public insert" ON public.liar_rooms      FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update" ON public.liar_rooms      FOR UPDATE USING (true);

-- NOTE: RLS stays enabled but with permissive policies, matching the pre-C2
-- state. If you want to disable RLS entirely, run:
--   ALTER TABLE public.hotseat_rooms   DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.chameleon_rooms DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.liar_rooms      DISABLE ROW LEVEL SECURITY;
