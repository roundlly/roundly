-- ============================================================================
-- db/fix/07_kick_and_lock.sql  (2026-06-27, RECONNECTION_PLAN.md "Batch 2")
-- Renumbered from 06 (a 06_mafia_roles_*.sql already exists). Apply AFTER 02-05.
-- ----------------------------------------------------------------------------
-- Two host controls — the human answer to "this player left / a stranger walked
-- in" (a phone can't tell "locked" from "gone", so the host decides):
--
--   1. HOST KICK  — huddle_<game>_kick(p_code, p_player_id)
--      Host-only (narrator-only for Mafia). Removes a seat by DELEGATING to the
--      existing, tested huddle_<game>_handle_disconnect (reuses seat removal +
--      host transfer). LOBBY-ONLY: kicking mid-game would route through
--      handle_disconnect, which mid-round can re-deal hands (Liar), force a vote
--      to resolve and reveal the Chameleon, or abort a round — a host must not
--      be able to weaponise that. Mid-game, an away player is freed by the 5-min
--      presence grace instead. (Review-driven, 2026-06-27.)
--
--   2. LOBBY LOCK — huddle_set_room_lock(p_table, p_code, p_locked)
--      Host flips state.locked. huddle_claim_seat then rejects NEW joiners while
--      locked, but still lets an already-seated player re-claim / switch seats
--      (reconnect keeps working). Stops a stranger scanning a cafe QR from
--      wandering into a seated game.
--
-- SAFE TO RE-RUN: every statement is CREATE OR REPLACE. No data migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- huddle_claim_seat — REDEFINED to add the lobby-lock guard.
-- VERBATIM copy of db/migrations/03_universal_room_rpcs.sql with ONE added block
-- (the `room_locked` guard, marked below). Diff before applying if you've since
-- changed claim_seat.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_claim_seat(p_table text, p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_claimedBy JSONB;
  v_existing  TEXT;
  v_old_seat  TEXT;
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

  -- >>> ADDED 2026-06-27 (lobby lock): block NEW joiners while the room is
  -- locked, but still allow an already-seated player to re-claim / switch their
  -- seat (reconnect must keep working). A "new joiner" = their uid is not yet a
  -- value anywhere in claimedBy.
  IF (v_state->>'locked')::boolean IS TRUE
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
       WHERE value = v_uid
     ) THEN
    RAISE EXCEPTION 'room_locked' USING ERRCODE = '42501';
  END IF;
  -- <<< END ADDED

  v_claimedBy := COALESCE(v_state->'claimedBy', '{}'::jsonb);

  -- Reject if the target seat is held by someone else.
  v_existing := v_claimedBy->>p_player_id;
  IF v_existing IS NOT NULL AND v_existing <> v_uid THEN
    RAISE EXCEPTION 'seat_already_claimed' USING ERRCODE = '42501';
  END IF;

  -- switch-seats support: if caller already holds a *different* seat, release it.
  SELECT key INTO v_old_seat
  FROM jsonb_each_text(v_claimedBy)
  WHERE value = v_uid AND key <> p_player_id
  LIMIT 1;

  IF v_old_seat IS NOT NULL THEN
    v_claimedBy := v_claimedBy - v_old_seat;
  END IF;

  -- Claim the new seat.
  v_claimedBy := jsonb_set(v_claimedBy, ARRAY[p_player_id], to_jsonb(v_uid), true);
  v_state := jsonb_set(v_state, '{claimedBy}', v_claimedBy);

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
$function$;

-- ----------------------------------------------------------------------------
-- huddle_set_room_lock(p_table, p_code, p_locked) — host flips state.locked.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_set_room_lock(p_table text, p_code text, p_locked boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_state := jsonb_set(v_state, '{locked}', to_jsonb(COALESCE(p_locked, false)));
  v_state := jsonb_set(
    v_state, '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format('UPDATE public.%I SET state = $1 WHERE code = $2', p_table)
    USING v_state, p_code;

  RETURN v_state;
END;
$function$;

-- ----------------------------------------------------------------------------
-- Per-game KICK wrappers. Host-only (narrator for Mafia), LOBBY-ONLY. Target by
-- SEAT id (e.g. 'p3'); resolve the uid and delegate to handle_disconnect.
-- NOTE: claimedBy[seat] holds the player's auth.uid (claim_seat stores auth.uid),
-- so v_target_uid below is a uid; the self-kick check is uid-vs-uid.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_kick(p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        TEXT;
  v_state      JSONB;
  v_target_uid TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT state INTO v_state FROM public.hotseat_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') NOT IN ('lobby', '') THEN
    RAISE EXCEPTION 'cannot_kick_mid_game' USING ERRCODE = '42501';
  END IF;

  v_target_uid := v_state->'claimedBy'->>p_player_id;
  IF v_target_uid IS NULL THEN
    RETURN v_state;  -- already gone; idempotent
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_kick_self' USING ERRCODE = '42501';
  END IF;

  PERFORM public.huddle_hot_handle_disconnect(p_code, v_target_uid);

  SELECT state INTO v_state FROM public.hotseat_rooms WHERE code = p_code;
  RETURN v_state;
END;
$function$;

CREATE OR REPLACE FUNCTION public.huddle_cham_kick(p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        TEXT;
  v_state      JSONB;
  v_target_uid TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT state INTO v_state FROM public.chameleon_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') NOT IN ('lobby', '') THEN
    RAISE EXCEPTION 'cannot_kick_mid_game' USING ERRCODE = '42501';
  END IF;

  v_target_uid := v_state->'claimedBy'->>p_player_id;
  IF v_target_uid IS NULL THEN
    RETURN v_state;
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_kick_self' USING ERRCODE = '42501';
  END IF;

  PERFORM public.huddle_cham_handle_disconnect(p_code, v_target_uid);

  SELECT state INTO v_state FROM public.chameleon_rooms WHERE code = p_code;
  RETURN v_state;
END;
$function$;

CREATE OR REPLACE FUNCTION public.huddle_liar_kick(p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        TEXT;
  v_state      JSONB;
  v_target_uid TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT state INTO v_state FROM public.liar_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') NOT IN ('lobby', '') THEN
    RAISE EXCEPTION 'cannot_kick_mid_game' USING ERRCODE = '42501';
  END IF;

  v_target_uid := v_state->'claimedBy'->>p_player_id;
  IF v_target_uid IS NULL THEN
    RETURN v_state;
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_kick_self' USING ERRCODE = '42501';
  END IF;

  PERFORM public.huddle_liar_handle_disconnect(p_code, v_target_uid);

  SELECT state INTO v_state FROM public.liar_rooms WHERE code = p_code;
  RETURN v_state;
END;
$function$;

-- Mafia: NARRATOR-only. handle_disconnect takes a SEAT id and is narrator-or-
-- self gated, and is a NO-OP mid-game (db/fix/02), so kicking is meaningful only
-- in the lobby — gate it there too for consistency + add the self-kick guard.
CREATE OR REPLACE FUNCTION public.huddle_mafia_kick(p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        TEXT;
  v_state      JSONB;
  v_target_uid TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT state INTO v_state FROM public.mafia_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);
  IF (v_state->>'phase') NOT IN ('lobby', '') THEN
    RAISE EXCEPTION 'cannot_kick_mid_game' USING ERRCODE = '42501';
  END IF;

  v_target_uid := v_state->'claimedBy'->>p_player_id;
  IF v_target_uid IS NULL THEN
    RETURN v_state;  -- already gone; idempotent
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_kick_self' USING ERRCODE = '42501';
  END IF;

  PERFORM public.huddle_mafia_handle_disconnect(p_code, p_player_id);

  SELECT state INTO v_state FROM public.mafia_rooms WHERE code = p_code;
  RETURN v_state;
END;
$function$;

-- ----------------------------------------------------------------------------
-- Grants (login is required now — anon never plays — so only authenticated).
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.huddle_claim_seat(text, text, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_set_room_lock(text, text, boolean)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_kick(text, text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_kick(text, text)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_kick(text, text)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_kick(text, text)            TO authenticated;
