-- ============================================================================
-- FIX — allow 'child' and 'mafia_leader' in mafia_roles (PGRST/23514 on Child)
-- ----------------------------------------------------------------------------
-- SYMPTOM (reproduced live, 2026-06-27): starting a Mafia Cards game with the
-- optional **Child** (or **Mafia Leader**) role enabled fails server-side. The
-- host sees "start failed"; players get no role card (blank). Under the hood
-- huddle_mafia_start_game tries to INSERT a 'child' (or 'mafia_leader') row into
-- public.mafia_roles and Postgres rejects it:
--
--     ERROR 23514: new row for relation "mafia_roles" violates check
--                  constraint "mafia_roles_role_check"
--
-- The whole start transaction rolls back → phase stays 'lobby', mafia_roles
-- stays empty, every huddle_mafia_get_my_role returns role=null.
--
-- WHY: the LIVE mafia_roles table still carries the ORIGINAL role CHECK from
-- db/archive/huddle_c2_mafia.sql (role IN ('mafia','detective','doctor',
-- 'villager')) — created before the Child / Mafia Leader optional roles existed.
-- The function was later updated to DEAL those roles (see the live source in
-- tmp/live-functions.csv and db/migrations/07_mafia_rpcs.sql), but the table
-- constraint was never widened on live. db/migrations/01_tables.sql:52 already
-- has the corrected constraint; it simply was never applied to the live DB.
--
-- WHY THIS IS SAFE: this only WIDENS the allowed set (adds 'child' and
-- 'mafia_leader'). Every existing row already holds one of the original four
-- values, all still permitted, so no existing row can be invalidated. Idempotent
-- (DROP ... IF EXISTS + re-ADD); safe to run more than once. No client change,
-- no redeploy needed — purely a live-DB constraint fix.
--
-- HOW TO APPLY: paste into the Supabase SQL editor and run (read-write).
-- ============================================================================

ALTER TABLE public.mafia_roles
  DROP CONSTRAINT IF EXISTS mafia_roles_role_check;

ALTER TABLE public.mafia_roles
  ADD CONSTRAINT mafia_roles_role_check
  CHECK (role IN ('mafia','mafia_leader','detective','doctor','child','villager'));

-- Sanity check — should list all SIX allowed values in the constraint body:
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.mafia_roles'::regclass
--     AND conname = 'mafia_roles_role_check';
