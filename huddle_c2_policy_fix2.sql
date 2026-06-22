-- ============================================================================
-- Huddle / Roundlly — C2 Policy Correction (part 2: hotseat_rooms extras)
-- ============================================================================
--
-- huddle_c2_policy_fix.sql cleaned up policies named `<table>_*_all`. Turns
-- out hotseat_rooms also has additional permissive policies named with
-- SPACES (not underscores): `hotseat insert`, `hotseat read`, `hotseat update`.
-- Drop these so Turn 1's restrictive policies actually take effect.
--
-- After this runs:
--   hotseat_rooms policies:
--     • Anyone can read   (SELECT) — open read for join flow
--     • Claimant can insert (INSERT) — auth.uid() must be in NEW.claimedBy
--     • Claimant can update (UPDATE) — existing claimants can update
--     [No DELETE policy = denied]
--
-- Run AFTER huddle_c2_policy_fix.sql.
-- ============================================================================

DROP POLICY IF EXISTS "hotseat insert" ON public.hotseat_rooms;
DROP POLICY IF EXISTS "hotseat read"   ON public.hotseat_rooms;
DROP POLICY IF EXISTS "hotseat update" ON public.hotseat_rooms;

-- Defensive: also drop any cham/liar variants with the same space-naming
-- convention in case they exist (no-op if absent).
DROP POLICY IF EXISTS "chameleon insert" ON public.chameleon_rooms;
DROP POLICY IF EXISTS "chameleon read"   ON public.chameleon_rooms;
DROP POLICY IF EXISTS "chameleon update" ON public.chameleon_rooms;
DROP POLICY IF EXISTS "liar insert"      ON public.liar_rooms;
DROP POLICY IF EXISTS "liar read"        ON public.liar_rooms;
DROP POLICY IF EXISTS "liar update"      ON public.liar_rooms;


-- ----------------------------------------------------------------------------
-- Verification — paste in a separate query AFTER running the drops
-- ----------------------------------------------------------------------------
-- Expected: 8 rows total across the three tables:
--
--   chameleon_rooms: Anyone can read (SELECT), Claimant can insert (INSERT),
--                    Claimant can update (UPDATE)
--   hotseat_rooms:   Anyone can read (SELECT), Claimant can insert (INSERT),
--                    Claimant can update (UPDATE)
--   liar_rooms:      Anyone can read (SELECT), Claimant can insert (INSERT)
--                    [NO UPDATE — locked down by Turn 3c]

-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE schemaname='public'
--   AND tablename IN ('liar_rooms','hotseat_rooms','chameleon_rooms')
-- ORDER BY tablename, cmd, policyname;
