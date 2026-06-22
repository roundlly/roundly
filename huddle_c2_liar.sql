-- ============================================================================
-- Huddle / Roundlly — C2 Turn 2 (Liar's Cup lobby actions)
-- ============================================================================
--
-- Run this AFTER huddle_c2_rls.sql succeeded. It updates the universal
-- huddle_claim_seat RPC so it supports "switch seats" (release the caller's
-- existing seat before claiming the new one) — matching the client's
-- existing behavior where tapping a different seat moves you to it.
--
-- This is a CREATE OR REPLACE — safe to run; no data is touched, only the
-- function body is updated.
-- ============================================================================

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

  v_claimedBy := COALESCE(v_state->'claimedBy', '{}'::jsonb);

  -- Reject if the target seat is held by someone else.
  v_existing := v_claimedBy->>p_player_id;
  IF v_existing IS NOT NULL AND v_existing <> v_uid THEN
    RAISE EXCEPTION 'seat_already_claimed' USING ERRCODE = '42501';
  END IF;

  -- NEW IN TURN 2: switch-seats support. If caller already holds a *different*
  -- seat in this room, release it before claiming the new one.
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
$$;

-- Grant remains the same — already authenticated-only.
GRANT EXECUTE ON FUNCTION public.huddle_claim_seat (TEXT, TEXT, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_claim_seat (TEXT, TEXT, TEXT) FROM anon, public;
