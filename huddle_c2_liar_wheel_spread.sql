-- ============================================================================
-- Huddle / Roundlly — Wheel chamber-spread upgrade
-- ============================================================================
--
-- Replaces huddle_liar_start_sip's random chamber shuffle with a maximally-
-- spread pattern (interleaved reds & greens) + a random rotation per round.
--
-- Before: ORDER BY random() — could cluster 3 reds next to each other.
-- After: deterministic spread pattern per spill count, randomly rotated.
--
-- Patterns (R = spill / red, G = safe / green):
--   1 spill : R G G G G G
--   2 spills: R G G R G G   (opposite pair)
--   3 spills: R G R G R G   (every other)
--   4 spills: R R G R R G   (2 safe slots opposite)
--   5 spills: R R R G R R   (1 safe slot — best we can do)
--   6 spills: R R R R R R   (all spill — forced loss)
--
-- After picking the pattern, server rotates by a random offset 0..5 so the
-- visual position varies each round without clustering.
--
-- Run on top of all earlier C2 migrations. CREATE OR REPLACE only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_liar_start_sip(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_my_player_id     TEXT;
  v_pending_loser    TEXT;
  v_spills           INT;
  v_pattern          JSONB;
  v_offset           INT;
  v_chambers         JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.liar_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;

  IF (v_state->>'phase') <> 'reveal' THEN
    RETURN v_state;
  END IF;

  v_pending_loser := v_state->>'pendingLoserId';
  IF v_pending_loser IS NULL THEN
    RAISE EXCEPTION 'no_pending_loser' USING ERRCODE = '42501';
  END IF;

  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS DISTINCT FROM v_pending_loser THEN
    RAISE EXCEPTION 'not_loser' USING ERRCODE = '42501';
  END IF;

  v_spills := GREATEST(1, LEAST(6, COALESCE((v_state->>'cupSpills')::int, 1)));

  -- Pick the spread pattern based on spill count
  v_pattern := CASE v_spills
    WHEN 1 THEN '[true,false,false,false,false,false]'::jsonb
    WHEN 2 THEN '[true,false,false,true,false,false]'::jsonb
    WHEN 3 THEN '[true,false,true,false,true,false]'::jsonb
    WHEN 4 THEN '[true,true,false,true,true,false]'::jsonb
    WHEN 5 THEN '[true,true,true,false,true,true]'::jsonb
    ELSE         '[true,true,true,true,true,true]'::jsonb
  END;

  -- Random rotation 0..5 so the visual placement varies each round
  v_offset := floor(random() * 6)::int;
  SELECT jsonb_agg(v_pattern->((i + v_offset) % 6) ORDER BY i)
  INTO v_chambers
  FROM generate_series(0, 5) AS s(i);

  v_state := v_state || jsonb_build_object(
    'sipChamberIsSpill', v_chambers,
    'sipChamberIdx',     null,
    'sipOutcome',        null,
    'sipTaken',          false,
    'phase',             'cup',
    'phaseStartAt',      public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.liar_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;

GRANT EXECUTE ON FUNCTION public.huddle_liar_start_sip(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_start_sip(TEXT) FROM anon, public;
