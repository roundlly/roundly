-- ============================================================================
-- Huddle / Roundlly — C2 Security Fix (Phase 1)
-- ============================================================================
--
-- WHAT THIS DOES
-- --------------
--   1. Enables RLS on the three game-room tables.
--   2. Drops the existing "anyone can do anything" policies.
--   3. Replaces them with claimant-only policies:
--        SELECT  — open (anyone with code can read; needed for join flow)
--        INSERT  — auth.uid() must be in NEW.state->'claimedBy' values
--        UPDATE  — auth.uid() must be in OLD.state->'claimedBy' values
--        DELETE  — denied
--   4. Defines four universal RPC functions for use by the client in
--      subsequent turns (turns 2-4 of the per-action migration):
--        huddle_create_room, huddle_claim_seat, huddle_leave_seat,
--        huddle_close_room
--
-- HOW TO RUN
-- ----------
--   Supabase Dashboard -> SQL Editor -> New query -> paste this entire file ->
--   Run. Read each comment block — some statements warn before destructive
--   action.
--
-- PRE-REQUISITES
-- --------------
--   • Anonymous sign-in is enabled (Dashboard -> Authentication -> Providers
--     -> Anonymous Sign-Ins -> Enable). [User confirmed.]
--   • Existing rows in the room tables may become orphaned (see "DECISION"
--     block below).
--
-- ROLLBACK
-- --------
--   See companion file huddle_c2_rollback.sql to restore the old open policies.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- DECISION: existing rows
-- ----------------------------------------------------------------------------
-- Existing rooms whose `claimedBy` values are random "tab_*" strings (written
-- when anon-sign-in was disabled) will become orphaned — no one's auth.uid()
-- matches, so no one can update them. Rooms with real UUIDs in `claimedBy`
-- (written after anon-sign-in was enabled) keep working for their original
-- claimants.
--
-- Recommended: truncate before applying (prototype phase, no production data
-- at risk). Uncomment the three TRUNCATE lines if you want a clean slate.
-- ----------------------------------------------------------------------------

-- TRUNCATE TABLE public.hotseat_rooms;
-- TRUNCATE TABLE public.chameleon_rooms;
-- TRUNCATE TABLE public.liar_rooms;


-- ============================================================================
-- 1. Enable RLS
-- ============================================================================

ALTER TABLE public.hotseat_rooms   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chameleon_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liar_rooms      ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 2. Drop existing open policies
-- ============================================================================
-- Names may vary depending on how the original bootstrap SQL was written.
-- Adjust the names if these DROP statements report "policy does not exist".

DROP POLICY IF EXISTS "Public read"   ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Public insert" ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Public update" ON public.hotseat_rooms;
DROP POLICY IF EXISTS "Public delete" ON public.hotseat_rooms;

DROP POLICY IF EXISTS "Public read"   ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Public insert" ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Public update" ON public.chameleon_rooms;
DROP POLICY IF EXISTS "Public delete" ON public.chameleon_rooms;

DROP POLICY IF EXISTS "Public read"   ON public.liar_rooms;
DROP POLICY IF EXISTS "Public insert" ON public.liar_rooms;
DROP POLICY IF EXISTS "Public update" ON public.liar_rooms;
DROP POLICY IF EXISTS "Public delete" ON public.liar_rooms;


-- ============================================================================
-- 3. Helper: claimant predicate
-- ============================================================================
-- Returns TRUE if `p_uid` appears as a value in the JSONB object
-- `p_claimed_by` (i.e. someone holds a seat under that auth.uid()).
--
-- Marked IMMUTABLE PARALLEL SAFE so RLS can inline the check efficiently.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_is_claimant(p_claimed_by JSONB, p_uid TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_each_text(COALESCE(p_claimed_by, '{}'::jsonb))
    WHERE value = p_uid
  );
$$;


-- ============================================================================
-- 4. New policies — claimant-only
-- ============================================================================

-- SELECT: open. Anyone with the code can read the room. This is the
-- intentional join model — a QR/link scanner reads the room state, sees the
-- open seats, then claims one.
CREATE POLICY "Anyone can read"
  ON public.hotseat_rooms FOR SELECT
  USING (true);
CREATE POLICY "Anyone can read"
  ON public.chameleon_rooms FOR SELECT
  USING (true);
CREATE POLICY "Anyone can read"
  ON public.liar_rooms FOR SELECT
  USING (true);

-- INSERT: caller's auth.uid() must appear in NEW.state->'claimedBy' values
-- (room creator must include themselves as a claimant on creation).
CREATE POLICY "Claimant can insert"
  ON public.hotseat_rooms FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );
CREATE POLICY "Claimant can insert"
  ON public.chameleon_rooms FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );
CREATE POLICY "Claimant can insert"
  ON public.liar_rooms FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );

-- UPDATE: caller's auth.uid() must be in the *existing* row's claimedBy.
-- This stops outsiders cold but does NOT stop a fellow claimant from
-- modifying any field. Insider attacks are mitigated by turns 2-4 (per-
-- action RPC migration).
CREATE POLICY "Claimant can update"
  ON public.hotseat_rooms FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );
CREATE POLICY "Claimant can update"
  ON public.chameleon_rooms FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );
CREATE POLICY "Claimant can update"
  ON public.liar_rooms FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );

-- DELETE: blanket-denied. There is no policy allowing DELETE, so it is
-- implicitly forbidden. The host's "close room" operation does NOT delete
-- the row — it sets state.closedByHost = true and clears hostId.


-- ============================================================================
-- 5. Universal RPC functions
-- ============================================================================
-- All four RPCs:
--   • are SECURITY DEFINER so they can bypass RLS to write
--   • validate p_table against an allowlist (prevents SQL injection via
--     identifier substitution)
--   • require auth.uid() to be non-null
--   • bump state.revision so the realtime echo flow keeps working
--   • return the new state JSONB so the client can update local cache
-- ============================================================================

-- Allowlist check used by every RPC.
CREATE OR REPLACE FUNCTION public.huddle_assert_room_table(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  IF p_table NOT IN ('hotseat_rooms', 'chameleon_rooms', 'liar_rooms') THEN
    RAISE EXCEPTION 'invalid_table: %', p_table USING ERRCODE = '22023';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_create_room
-- ----------------------------------------------------------------------------
-- Inserts a new room row. Strict insert (fails if room with this code already
-- exists). Caller MUST include themselves in p_initial_state.claimedBy and
-- as state.hostId.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_create_room(
  p_table         TEXT,
  p_code          TEXT,
  p_initial_state JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_new_state JSONB;
  v_inserted  JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  IF p_code IS NULL OR length(p_code) = 0 THEN
    RAISE EXCEPTION 'invalid_code' USING ERRCODE = '22023';
  END IF;
  IF p_initial_state IS NULL OR jsonb_typeof(p_initial_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023';
  END IF;
  IF NOT public.huddle_is_claimant(p_initial_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'creator_must_be_claimant' USING ERRCODE = '42501';
  END IF;
  IF (p_initial_state->>'hostId') IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'creator_must_be_host' USING ERRCODE = '42501';
  END IF;

  v_new_state := jsonb_set(
    p_initial_state,
    '{revision}',
    to_jsonb(COALESCE((p_initial_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format(
    'INSERT INTO public.%I (code, state) VALUES ($1, $2) RETURNING state',
    p_table
  ) USING p_code, v_new_state INTO v_inserted;

  RETURN v_inserted;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_claim_seat
-- ----------------------------------------------------------------------------
-- Claims an unowned seat (or idempotently re-claims own seat). Solves the
-- chicken-and-egg: a non-claimant can call this even though they're not yet
-- in claimedBy.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_claim_seat(
  p_table     TEXT,
  p_code      TEXT,
  p_player_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_existing  TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  IF p_player_id IS NULL OR length(p_player_id) = 0 THEN
    RAISE EXCEPTION 'invalid_player_id' USING ERRCODE = '22023';
  END IF;

  EXECUTE format('SELECT state FROM public.%I WHERE code = $1 FOR UPDATE', p_table)
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'closedByHost')::boolean IS TRUE THEN
    RAISE EXCEPTION 'room_closed' USING ERRCODE = '42501';
  END IF;

  v_existing := v_state->'claimedBy'->>p_player_id;
  IF v_existing IS NOT NULL AND v_existing <> v_uid THEN
    RAISE EXCEPTION 'seat_already_claimed' USING ERRCODE = '42501';
  END IF;

  -- Set claim. jsonb_set with create_missing=true initializes claimedBy if absent.
  v_state := jsonb_set(
    COALESCE(v_state, '{}'::jsonb),
    ARRAY['claimedBy', p_player_id],
    to_jsonb(v_uid),
    true
  );

  -- If host is unset, claim it.
  IF (v_state->>'hostId') IS NULL THEN
    v_state := jsonb_set(v_state, '{hostId}', to_jsonb(v_uid));
  END IF;

  -- Bump revision.
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format('UPDATE public.%I SET state = $1 WHERE code = $2', p_table)
    USING v_state, p_code;

  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_leave_seat
-- ----------------------------------------------------------------------------
-- Removes the caller from claimedBy. If caller was hostId, transfers to the
-- lexicographically-lowest remaining claimant (matches the client's existing
-- transfer rule).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_leave_seat(
  p_table TEXT,
  p_code  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_claimedBy JSONB;
  v_my_seat   TEXT;
  v_next_host TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  EXECUTE format('SELECT state FROM public.%I WHERE code = $1 FOR UPDATE', p_table)
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;

  v_claimedBy := COALESCE(v_state->'claimedBy', '{}'::jsonb);

  -- Find the caller's seat id (the key whose value equals my uid).
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_claimedBy)
  WHERE value = v_uid
  LIMIT 1;

  IF v_my_seat IS NULL THEN
    -- Not seated; nothing to do. Idempotent return.
    RETURN v_state;
  END IF;

  v_claimedBy := v_claimedBy - v_my_seat;
  v_state := jsonb_set(v_state, '{claimedBy}', v_claimedBy);

  -- Host transfer: if caller was host, pick the next-lowest-seat-id holder
  -- (the client's existing rule).
  IF (v_state->>'hostId') = v_uid THEN
    SELECT value INTO v_next_host
    FROM jsonb_each_text(v_claimedBy)
    ORDER BY key
    LIMIT 1;

    IF v_next_host IS NOT NULL THEN
      v_state := jsonb_set(v_state, '{hostId}', to_jsonb(v_next_host));
    ELSE
      v_state := jsonb_set(v_state, '{hostId}', 'null'::jsonb);
    END IF;
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format('UPDATE public.%I SET state = $1 WHERE code = $2', p_table)
    USING v_state, p_code;

  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_close_room
-- ----------------------------------------------------------------------------
-- Host-only. Sets closedByHost=true and hostId=null. Players are still in
-- claimedBy so they can still update (e.g. their own leave) — the client
-- listens for closedByHost and auto-leaves all peers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_close_room(
  p_table TEXT,
  p_code  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   TEXT;
  v_state JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  EXECUTE format('SELECT state FROM public.%I WHERE code = $1 FOR UPDATE', p_table)
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'hostId') IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_host' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{closedByHost}', 'true'::jsonb);
  v_state := jsonb_set(v_state, '{hostId}',       'null'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format('UPDATE public.%I SET state = $1 WHERE code = $2', p_table)
    USING v_state, p_code;

  RETURN v_state;
END;
$$;


-- ============================================================================
-- 6. Grant EXECUTE on RPCs to authenticated and anon roles
-- ============================================================================
-- Anonymous-signed-in users have role `authenticated` (their JWT carries an
-- auth.uid()). Non-signed-in users have role `anon` — they should not be
-- able to call these RPCs (validation would reject them anyway since
-- auth.uid() is null, but explicit grant is clearer).

GRANT EXECUTE ON FUNCTION public.huddle_create_room(TEXT, TEXT, JSONB)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_claim_seat (TEXT, TEXT, TEXT)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_leave_seat (TEXT, TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_close_room (TEXT, TEXT)                TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_create_room(TEXT, TEXT, JSONB)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_claim_seat (TEXT, TEXT, TEXT)         FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_leave_seat (TEXT, TEXT)               FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_close_room (TEXT, TEXT)               FROM anon, public;


-- ============================================================================
-- 7. Smoke tests (run after applying)
-- ============================================================================
-- Paste each block into the SQL Editor as a separate query to verify.
-- All blocks should succeed silently (no rows returned, no error) UNLESS
-- explicitly marked otherwise.
-- ============================================================================

-- Test 1: As anon user (no auth), INSERT should FAIL.
-- Run from a client that is NOT signed in via Supabase, or comment out and
-- skip if running in SQL editor (where auth.uid() is null and policies are
-- bypassed by superuser).

-- Test 2: Verify RLS is enabled.
-- SELECT tablename, rowsecurity
-- FROM pg_tables WHERE schemaname='public'
-- AND tablename IN ('hotseat_rooms','chameleon_rooms','liar_rooms');
-- Expected: rowsecurity = true for all three.

-- Test 3: Verify policies exist.
-- SELECT tablename, policyname, cmd
-- FROM pg_policies WHERE schemaname='public'
-- AND tablename IN ('hotseat_rooms','chameleon_rooms','liar_rooms')
-- ORDER BY tablename, cmd;
-- Expected: 4 policies per table (SELECT/INSERT/UPDATE x 3 tables = 9 rows
-- if you count rooms separately; 4 = SELECT+INSERT+UPDATE plus an implicit
-- nothing-for-DELETE).
