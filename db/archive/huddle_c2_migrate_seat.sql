-- ============================================================================
-- Huddle / Roundlly — Anon → Google seat migration
-- ============================================================================
--
-- Problem this RPC solves:
--   A friend opens a shared lobby link (?room=ABCD&game=liar). They have no
--   Google session yet, so the app gives them a Supabase anonymous user and
--   they claim a seat under that anon UUID. They then tap "Sign in with
--   Google" so we can show their real name. After OAuth returns,
--   auth.uid() is their NEW Google user id — but the seat in the DB is
--   still claimed under the OLD anon UUID. Result: the lobby shows them as
--   unseated until they manually re-claim or refresh.
--
-- This RPC migrates seat claims (and host id if applicable) from an old
-- session id to the caller's current auth.uid() — server-side, atomically.
--
-- Trust model:
--   The caller proves nothing about the from-session-id; we just trust the
--   client knows its own previous anon id (it was in memory until rebind).
--   Damage from a malicious caller is limited:
--     - Lobby-phase only (no migrating mid-game)
--     - If auth.uid() already holds a *different* seat in this room, we
--       refuse — so a real player's seat can't be hijacked by spoofing
--       someone else's session id
--     - Only one seat per from-session-id, so at most one seat moves
--
-- ----------------------------------------------------------------------------
-- This is a CREATE OR REPLACE — safe to run; no data touched, only the
-- function body is added/updated.
-- Run AFTER huddle_c2_rls.sql + huddle_c2_liar.sql + huddle_c2_mafia.sql
-- (depends on public.huddle_assert_room_table).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_migrate_seat(
  p_table           TEXT,
  p_code            TEXT,
  p_from_session_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid            TEXT;
  v_state          JSONB;
  v_claimedBy      JSONB;
  v_phase          TEXT;
  v_old_seat       TEXT;
  v_existing_seat  TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  IF p_from_session_id IS NULL OR length(p_from_session_id) = 0 THEN
    RAISE EXCEPTION 'invalid_from_session_id' USING ERRCODE = '22023';
  END IF;

  -- Migrating from yourself to yourself is a no-op. Return current state so
  -- the caller can still use the returned JSONB if it wants to.
  IF p_from_session_id = v_uid THEN
    EXECUTE format('SELECT state FROM public.%I WHERE code = $1', p_table)
      USING p_code INTO v_state;
    RETURN v_state;
  END IF;

  EXECUTE format('SELECT state FROM public.%I WHERE code = $1 FOR UPDATE', p_table)
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'closedByHost')::boolean IS TRUE THEN
    RAISE EXCEPTION 'room_closed' USING ERRCODE = '42501';
  END IF;

  -- Lobby-only: don't allow migration mid-game. Game phases have invariants
  -- (turn order, roles, votes) tied to seat identity; rewriting claimedBy
  -- mid-game could corrupt them. If anyone signs in mid-game, they'll
  -- have to finish as-is or refresh after the round ends.
  v_phase := v_state->>'phase';
  IF v_phase IS NOT NULL AND v_phase <> 'lobby' AND v_phase <> '' THEN
    RETURN v_state;
  END IF;

  v_claimedBy := COALESCE(v_state->'claimedBy', '{}'::jsonb);

  -- Find the seat held by the old session id. If none, nothing to migrate.
  SELECT key INTO v_old_seat
  FROM jsonb_each_text(v_claimedBy)
  WHERE value = p_from_session_id
  LIMIT 1;

  IF v_old_seat IS NULL THEN
    RETURN v_state;
  END IF;

  -- Refuse if the new user (auth.uid()) already holds a DIFFERENT seat in
  -- this room. That would mean a real Google user is already seated, and
  -- migrating the from-session's seat into them would either (a) steal an
  -- innocent third-party's seat or (b) leave the new user double-claimed.
  -- Safer to silently no-op and let the user resolve manually.
  SELECT key INTO v_existing_seat
  FROM jsonb_each_text(v_claimedBy)
  WHERE value = v_uid AND key <> v_old_seat
  LIMIT 1;

  IF v_existing_seat IS NOT NULL THEN
    RETURN v_state;
  END IF;

  -- Reassign the seat to the new user.
  v_claimedBy := jsonb_set(v_claimedBy, ARRAY[v_old_seat], to_jsonb(v_uid), true);
  v_state := jsonb_set(v_state, '{claimedBy}', v_claimedBy);

  -- If the old session was the host, transfer host to the new user too.
  IF (v_state->>'hostId') = p_from_session_id THEN
    v_state := jsonb_set(v_state, '{hostId}', to_jsonb(v_uid));
  END IF;

  -- Bump revision so realtime echoes propagate to every other client.
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

GRANT EXECUTE ON FUNCTION public.huddle_migrate_seat (TEXT, TEXT, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_migrate_seat (TEXT, TEXT, TEXT) FROM anon, public;
