-- ============================================================================
-- Huddle / Roundlly — C2 Policy Correction (apply on top of Turns 1-3c)
-- ============================================================================
--
-- WHAT THIS FIXES
-- ---------------
-- Turn 1's huddle_c2_rls.sql tried to drop the existing permissive policies
-- with names like "Public read" / "Public insert" / "Public update". The
-- actual names in your project are `<table>_select_all` / `_insert_all` /
-- `_update_all` / `_delete_all`. So those DROPs were no-ops and the original
-- permissive policies are still in effect today.
--
-- Result before this fix: turns 1-3 added restrictive policies + RPCs, but
-- the broader permissive policies still let direct REST writes through.
-- RPCs worked (they use SECURITY DEFINER and bypass RLS), but the policy
-- floor was open. The "outsider can't write" guarantee was not actually
-- enforced.
--
-- AFTER YOU RUN THIS
-- ------------------
-- All three game tables (liar_rooms, hotseat_rooms, chameleon_rooms) will
-- have the *actual* enforced policies that Turns 1-3 intended:
--   • SELECT: open (anyone can read by code — needed for join)
--   • INSERT: restricted to authenticated callers who include themselves
--             in NEW.state->'claimedBy' (Turn 1 INSERT policy)
--   • UPDATE: denied for direct client REST. Only RPCs (SECURITY DEFINER)
--             can mutate (Turn 3c lockdown — applies to liar_rooms only;
--             hotseat_rooms and chameleon_rooms keep claimant-only UPDATE
--             until Turns 4 & 5 migrate them to RPC).
--   • DELETE: denied for everyone.
--
-- Run after all previous Huddle C2 migrations.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Drop the actual permissive policies on all three game tables
-- ----------------------------------------------------------------------------
-- Note: liar_rooms_select_all is dropped because we already have "Anyone can
-- read" doing the same thing. Same for the others — Turn 1's restrictive
-- policies replace them.

DROP POLICY IF EXISTS liar_rooms_select_all   ON public.liar_rooms;
DROP POLICY IF EXISTS liar_rooms_insert_all   ON public.liar_rooms;
DROP POLICY IF EXISTS liar_rooms_update_all   ON public.liar_rooms;
DROP POLICY IF EXISTS liar_rooms_delete_all   ON public.liar_rooms;

DROP POLICY IF EXISTS hotseat_rooms_select_all   ON public.hotseat_rooms;
DROP POLICY IF EXISTS hotseat_rooms_insert_all   ON public.hotseat_rooms;
DROP POLICY IF EXISTS hotseat_rooms_update_all   ON public.hotseat_rooms;
DROP POLICY IF EXISTS hotseat_rooms_delete_all   ON public.hotseat_rooms;

DROP POLICY IF EXISTS chameleon_rooms_select_all   ON public.chameleon_rooms;
DROP POLICY IF EXISTS chameleon_rooms_insert_all   ON public.chameleon_rooms;
DROP POLICY IF EXISTS chameleon_rooms_update_all   ON public.chameleon_rooms;
DROP POLICY IF EXISTS chameleon_rooms_delete_all   ON public.chameleon_rooms;


-- ----------------------------------------------------------------------------
-- 2. Verification
-- ----------------------------------------------------------------------------
-- Run this in a separate SQL Editor query AFTER the drops above succeed.
-- Expected output for each table:
--
--   liar_rooms:        Anyone can read (SELECT), Claimant can insert (INSERT)
--                      [NO update policy = denied]
--   hotseat_rooms:     Anyone can read (SELECT), Claimant can insert (INSERT),
--                      Claimant can update (UPDATE)
--   chameleon_rooms:   Anyone can read (SELECT), Claimant can insert (INSERT),
--                      Claimant can update (UPDATE)
--
-- If you still see a `*_all` policy after running the drops, paste me the
-- exact name and I'll add the matching DROP statement.

-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE schemaname='public'
--   AND tablename IN ('liar_rooms','hotseat_rooms','chameleon_rooms')
-- ORDER BY tablename, cmd, policyname;
