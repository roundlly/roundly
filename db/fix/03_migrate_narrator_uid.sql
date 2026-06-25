-- ============================================================================
-- fix/03 — Seat migration must also move narratorUid (Mafia narrator survives
--          an anon -> Google sign-in mid-lobby)
-- ----------------------------------------------------------------------------
-- Apply to the LIVE Supabase DB (SQL editor). Idempotent (CREATE OR REPLACE),
-- server-only, no app redeploy required.
--
-- BUG: huddle_migrate_seat (called on the client when a player signs in with
-- Google mid-lobby) reassigned the seat in claimedBy and transferred hostId to
-- the new auth.uid(), but NEVER moved narratorUid. So when the Mafia HOST (who
-- is usually the narrator, and who signs in with Google per the product model)
-- changed identity, narratorUid was left pointing at the now-dead anonymous id.
-- Consequences once the game starts:
--   • huddle_mafia_get_narrator_state raises not_narrator for the real host →
--     the narrator dashboard is stuck on "Loading roles…".
--   • huddle_mafia_start_game can no longer exclude the narrator (their old uid
--     is gone from claimedBy), so the narrator's seat is dealt a role and the
--     role cards / counts are wrong.
-- Reproduced live in tmp/repro-mafia-signin.js (get_narrator_state → 42501).
--
-- FIX: when the migrating session was the narrator, move narratorUid to the new
-- auth.uid() too — exactly mirroring the hostId transfer right below it. This is
-- a universal RPC; non-Mafia room states simply have no narratorUid, so the new
-- block is a harmless no-op for hotseat/chameleon/liar rooms.
--
-- Lobby-only (unchanged): migration already no-ops mid-game, so this cannot
-- rewrite identities during an active round.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_migrate_seat(p_table text, p_code text, p_from_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- If the old session was the Mafia narrator, move narratorUid to the new user
  -- too (mirrors the hostId transfer above). Without this, the narrator's
  -- dashboard breaks (not_narrator) and start_game can't exclude the narrator
  -- after the host signs in with Google mid-lobby. No-op for non-Mafia rooms,
  -- which have no narratorUid.
  IF (v_state->>'narratorUid') = p_from_session_id THEN
    v_state := jsonb_set(v_state, '{narratorUid}', to_jsonb(v_uid));
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
$function$;
