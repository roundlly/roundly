-- ============================================================================
-- huddle_c2_mafia_rules_gate.sql
-- ----------------------------------------------------------------------------
-- Adds the pre-game RULES GATE to Mafia.
--
-- BEFORE this migration:
--   huddle_mafia_start_game → phase='night-mafia', beatId='opening-setup'
--   Narrator immediately reads "Welcome to Mafia… memorize your role…
--   here's how each role works…" out loud.
--
-- AFTER this migration:
--   huddle_mafia_start_game → phase='rules', beatId='rules-gate', readyBy={}
--   Every player + narrator lands on the rules screen, taps "I'm Ready".
--   Once all are ready, the companion RPC huddle_mafia_set_ready flips the
--   gate and the room jumps straight to beatId='opening-night1-open',
--   skipping the now-redundant opening-setup + opening-roles beats whose
--   content lives on the rules page.
--
-- This file ships TWO tightly-coupled changes that must land together:
--   (1) huddle_mafia_advance_beat — accept 'rules' on the phase allowlist.
--   (2) huddle_mafia_start_game   — land in the rules gate.
--
-- Companion: huddle_c2_mafia_set_ready.sql adds the RPC that closes the gate.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) huddle_mafia_advance_beat — accept 'rules' on the phase allowlist.
-- ----------------------------------------------------------------------------
-- The existing function rejects any phase not on its allowlist. We deliberately
-- do NOT add 'rules' to the list — the rules phase is entered by start_game
-- and exited by set_ready, both server-side. Allowing advance_beat to push a
-- room into 'rules' would let a narrator stall or reset the game mid-play.
-- This is unchanged from the prior version's allowlist; we recreate the
-- function only because the original migration also did, and we want
-- start_game (below) and advance_beat to land together as one atomic file.
--
-- Drop BOTH historical overloads — the original huddle_c2_mafia.sql dropped
-- (TEXT,TEXT,TEXT) and (TEXT,TEXT,TEXT,INT). Recreate the 4-arg form only.
DROP FUNCTION IF EXISTS public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION public.huddle_mafia_advance_beat(
  p_code    TEXT,
  p_beat_id TEXT,
  p_phase   TEXT,
  p_round   INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    TEXT;
  v_state  JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_beat_id IS NULL OR length(p_beat_id) = 0 THEN
    RAISE EXCEPTION 'invalid_beat_id' USING ERRCODE = '22023';
  END IF;
  -- Phase allowlist intentionally excludes 'rules': only start_game (entry)
  -- and set_ready (exit) may set that phase, both server-side. A narrator
  -- calling advance_beat with phase='rules' is rejected — prevents stalling
  -- or resetting the game mid-play.
  IF p_phase NOT IN ('night-mafia','night-detective','night-doctor','night-resolve',
                     'day-reveal','day-discuss','vote','vote-tie','day-eliminate','end') THEN
    RAISE EXCEPTION 'invalid_phase: %', p_phase USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.mafia_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  v_state := jsonb_set(v_state, '{beatId}', to_jsonb(p_beat_id));
  v_state := jsonb_set(v_state, '{phase}',  to_jsonb(p_phase));
  -- Optional round update — only set when the caller explicitly bumps the round.
  IF p_round IS NOT NULL THEN
    v_state := jsonb_set(v_state, '{round}', to_jsonb(p_round));
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
GRANT EXECUTE ON FUNCTION public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT, INT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT, INT) FROM anon, public;


-- ----------------------------------------------------------------------------
-- 2) huddle_mafia_start_game — land in phase='rules', beatId='rules-gate'.
-- ----------------------------------------------------------------------------
-- Same role assignment + alive list logic as before. The ONLY differences
-- from the previous version are:
--   • phase   → 'rules'        (was 'night-mafia')
--   • beatId  → 'rules-gate'   (was 'opening-setup')
--   • readyBy → {}             (NEW — initialized empty for set_ready to fill)
-- Everything else is byte-for-byte identical to the prior implementation.
CREATE OR REPLACE FUNCTION public.huddle_mafia_start_game(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_narrator_uid     TEXT;
  v_player_seats     TEXT[];
  v_player_count     INT;
  v_roles            TEXT[];
  v_mafia_count      INT;
  v_villager_count   INT;
  v_alive_arr        JSONB;
  i                  INT;
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
  IF (v_state->>'hostId') IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_host' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') <> 'lobby' THEN
    RAISE EXCEPTION 'already_started' USING ERRCODE = '42501';
  END IF;

  v_narrator_uid := v_state->>'narratorUid';
  IF v_narrator_uid IS NULL THEN
    RAISE EXCEPTION 'narrator_not_set' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(key ORDER BY random()) INTO v_player_seats
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value <> v_narrator_uid;

  v_player_count := COALESCE(array_length(v_player_seats, 1), 0);
  IF v_player_count < 6 OR v_player_count > 8 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Role mix table (Detective removed — was overpowered):
  --   6 → 1M / 1Doc / 4V
  --   7 → 2M / 1Doc / 4V
  --   8 → 2M / 1Doc / 5V
  IF v_player_count = 6 THEN
    v_mafia_count := 1;
    v_villager_count := 4;
  ELSIF v_player_count = 7 THEN
    v_mafia_count := 2;
    v_villager_count := 4;
  ELSE  -- 8
    v_mafia_count := 2;
    v_villager_count := 5;
  END IF;

  v_roles := ARRAY[]::TEXT[];
  FOR i IN 1..v_mafia_count LOOP
    v_roles := array_append(v_roles, 'mafia');
  END LOOP;
  v_roles := array_append(v_roles, 'doctor');
  FOR i IN 1..v_villager_count LOOP
    v_roles := array_append(v_roles, 'villager');
  END LOOP;

  IF array_length(v_player_seats, 1) <> array_length(v_roles, 1) THEN
    RAISE EXCEPTION 'role_count_mismatch' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.mafia_roles WHERE code = p_code;

  FOR i IN 1..array_length(v_player_seats, 1) LOOP
    INSERT INTO public.mafia_roles(code, player_id, role)
    VALUES (p_code, v_player_seats[i], v_roles[i]);
  END LOOP;

  SELECT jsonb_agg(s) INTO v_alive_arr FROM unnest(v_player_seats) AS s;

  -- Pre-game RULES GATE. Companion RPC huddle_mafia_set_ready flips the
  -- gate to phase='night-mafia' beatId='opening-night1-open' once every
  -- alive player + narrator has tapped Ready on the rules screen.
  v_state := jsonb_set(v_state, '{phase}',           '"rules"'::jsonb);
  v_state := jsonb_set(v_state, '{round}',           '1'::jsonb);
  v_state := jsonb_set(v_state, '{aliveIds}',        v_alive_arr);
  v_state := jsonb_set(v_state, '{deadIds}',         '[]'::jsonb);
  v_state := jsonb_set(v_state, '{killTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{saveTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{detectiveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{voteTally}',       '{}'::jsonb);
  v_state := jsonb_set(v_state, '{votedBy}',         '{}'::jsonb);
  v_state := jsonb_set(v_state, '{beatId}',          '"rules-gate"'::jsonb);
  v_state := jsonb_set(v_state, '{readyBy}',         '{}'::jsonb);
  v_state := jsonb_set(v_state, '{winner}',          'null'::jsonb);
  v_state := jsonb_set(v_state, '{roleReveal}',      '{}'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT) FROM anon, public;
