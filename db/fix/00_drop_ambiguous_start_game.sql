-- ============================================================================
-- FIX — resolve the huddle_mafia_start_game overload ambiguity (PGRST203)
-- ----------------------------------------------------------------------------
-- This is the ONE change Phase 4 applies to the existing LIVE database.
--
-- WHY: the live DB has TWO overloads of huddle_mafia_start_game:
--   (a) huddle_mafia_start_game(text)                                  <-- stray
--   (b) huddle_mafia_start_game(text, boolean, boolean, boolean, text) <-- canonical
-- A call with only {p_code} matches BOTH (b's extra args all have DEFAULTs), so
-- PostgREST returns PGRST203 "Could not choose the best candidate function".
-- It is currently LATENT (the client forces cards-mode and always sends all 5
-- args), but it is a trap and breaks any bare {p_code} call.
--
-- WHY THIS IS SAFE: the canonical 5-arg form (b) reproduces (a)'s behavior — both
-- land the game in the rules gate (phase='rules', beatId='rules-gate', readyBy={}).
-- (b) is a strict superset: 5-player minimum (vs 6), detective on by default,
-- child/mafia_leader supported. A bare {p_code} call falls through to (b) via its
-- defaults and still lands in the rules gate. `optional_roles_v2.sql` already
-- intended exactly this (it dropped the 1-arg form); the stray (a) was
-- re-introduced later by re-running rules_gate.sql / detective_return.sql.
--
-- No client change, no redeploy. Verified against the live function source dump
-- (2026-06-23). See PHASE4_FINDINGS.md.
-- ============================================================================

DROP FUNCTION IF EXISTS public.huddle_mafia_start_game(text);

-- Sanity check — should now report exactly ONE overload (the 5-arg form):
--   SELECT oid::regprocedure::text FROM pg_proc
--   WHERE proname = 'huddle_mafia_start_game';
