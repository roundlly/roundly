-- ============================================================================
-- huddle_c2_mafia_set_ready.sql
-- ----------------------------------------------------------------------------
-- The RPC that closes the pre-game RULES GATE introduced by
-- huddle_c2_mafia_rules_gate.sql.
--
-- Flow:
--   1. Host runs huddle_mafia_start_game → state lands at
--      phase='rules', beatId='rules-gate', readyBy={}.
--   2. Each player + the narrator opens the rules screen on their phone
--      and taps "I'm Ready". Their phone calls huddle_mafia_set_ready.
--   3. Once every alive player seat AND the narrator's sentinel slot
--      ('__narrator__') is true in readyBy, this function flips the
--      room to phase='night-mafia', beatId='opening-night1-open'. The
--      now-redundant opening-setup + opening-roles beats are skipped —
--      their content lives on the rules page so the narrator doesn't
--      read them out.
--
-- SECURITY NOTE
--   The seat key is derived server-side from auth.uid(). The p_seat
--   parameter is accepted for symmetry with the dev/lab harness (which
--   has no real auth and must pass the seat explicitly) but is IGNORED
--   here. Clients cannot mark another player ready by spoofing p_seat.
--
-- Companion file: huddle_c2_mafia_rules_gate.sql (must be applied first).
-- ============================================================================

DROP FUNCTION IF EXISTS public.huddle_mafia_set_ready(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.huddle_mafia_set_ready(
  p_code  TEXT,
  p_seat  TEXT DEFAULT NULL   -- IGNORED; seat derived from auth.uid()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          TEXT;
  v_state        JSONB;
  v_narrator_uid TEXT;
  v_seat_key     TEXT;
  v_ready_by     JSONB;
  v_player_seats TEXT[];
  v_all_ready    BOOLEAN;
  s              TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.mafia_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'phase') <> 'rules' THEN
    RAISE EXCEPTION 'not_in_rules_phase' USING ERRCODE = '42501';
  END IF;

  -- Derive seat key from auth.uid(). The narrator gets a sentinel key so
  -- it counts as a distinct "slot" from any player seat.
  v_narrator_uid := v_state->>'narratorUid';
  IF v_narrator_uid = v_uid THEN
    v_seat_key := '__narrator__';
  ELSE
    SELECT key INTO v_seat_key
    FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
    WHERE value = v_uid
    LIMIT 1;
  END IF;
  IF v_seat_key IS NULL THEN
    RAISE EXCEPTION 'caller_not_in_room' USING ERRCODE = '42501';
  END IF;

  -- Flip caller's ready bit.
  v_ready_by := COALESCE(v_state->'readyBy', '{}'::jsonb);
  v_ready_by := jsonb_set(v_ready_by, ARRAY[v_seat_key], 'true'::jsonb);
  v_state := jsonb_set(v_state, '{readyBy}', v_ready_by);

  -- Compute "all ready" = every player seat AND the narrator are true.
  SELECT array_agg(key) INTO v_player_seats
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value <> COALESCE(v_narrator_uid, '');

  -- Defensive: an empty player set (claimedBy somehow stripped post-start)
  -- must NOT be treated as vacuously "all ready" — that would let a lone
  -- narrator transition a broken room into night-mafia with no players.
  IF v_player_seats IS NULL OR array_length(v_player_seats, 1) IS NULL THEN
    v_all_ready := FALSE;
  ELSE
    v_all_ready := TRUE;
    FOREACH s IN ARRAY v_player_seats LOOP
      IF NOT COALESCE((v_ready_by->>s)::boolean, FALSE) THEN
        v_all_ready := FALSE;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_all_ready AND v_narrator_uid IS NOT NULL THEN
    IF NOT COALESCE((v_ready_by->>'__narrator__')::boolean, FALSE) THEN
      v_all_ready := FALSE;
    END IF;
  END IF;

  IF v_all_ready THEN
    -- Gate open. Skip opening-setup + opening-roles (their content lives
    -- on the rules page) and jump straight to the first live cue.
    v_state := jsonb_set(v_state, '{phase}',  '"night-mafia"'::jsonb);
    v_state := jsonb_set(v_state, '{beatId}', '"opening-night1-open"'::jsonb);
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_set_ready(TEXT, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_set_ready(TEXT, TEXT) FROM anon, public;
