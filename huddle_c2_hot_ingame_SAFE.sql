-- huddle_c2_hot_ingame_SAFE.sql
-- Auto-derived from huddle_c2_hot_ingame.sql with the DROP POLICY removed.
-- Purpose: create the Hot Seat in-game RPCs (incl. huddle_hot_play_again) that
-- are MISSING from the live DB and cause Start game to show "Couldn't sync".
-- Safe to run in Supabase SQL Editor: only CREATE OR REPLACE FUNCTION + GRANT/REVOKE.

-- ============================================================================
-- Huddle / Roundlly — C2 Turn 4b (Hot Seat in-game RPCs + lockdown)
-- ============================================================================
--
-- Final Hot Seat migration step. Adds the remaining in-game mutations as
-- RPCs and tightens hotseat_rooms UPDATE policy to deny direct upsert.
--
-- NOTE on word picking: server does NOT pick the word — client picks from
-- its in-memory category dictionary and passes the chosen word to the RPC.
-- Server validates only that the word is a non-empty string. This is a
-- known trust gap (a cheating host or helper could send a crafted word);
-- documenting rather than fixing because porting the ~5000-word multi-
-- category dictionary to SQL is far beyond C2 scope.
--
-- Run AFTER huddle_c2_hot_lobby.sql + all earlier C2 migrations.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_hot_start_turn
-- ----------------------------------------------------------------------------
-- Host-only. Starts a player's turn. Used by:
--   • pickNextPlayer auto-rotating/random path (host's device picks idx)
--   • hostPicked manual path (host taps a player tile)
--   • play-again first-turn path (host starts fresh game)
--
-- Validates: caller is host; phase is one of {lobby, result}; p_player_idx
-- maps to a claimed seat that isn't already used this round.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_start_turn(
  p_code        TEXT,
  p_player_idx  INT,
  p_word        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_players       JSONB;
  v_player_id     TEXT;
  v_claimed_by    JSONB;
  v_used          JSONB;
  v_used_words    JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_word IS NULL OR length(trim(p_word)) = 0 THEN
    RAISE EXCEPTION 'invalid_word' USING ERRCODE = '22023';
  END IF;
  IF length(p_word) > 200 THEN
    RAISE EXCEPTION 'word_too_long' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  IF p_player_idx < 0 OR p_player_idx >= jsonb_array_length(v_players) THEN
    RAISE EXCEPTION 'invalid_player_idx' USING ERRCODE = '22023';
  END IF;
  v_player_id := v_players->p_player_idx->>'id';
  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  IF (v_claimed_by->>v_player_id) IS NULL THEN
    RAISE EXCEPTION 'seat_not_claimed' USING ERRCODE = '42501';
  END IF;
  v_used := COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_used) AS u(idx)
    WHERE idx::int = p_player_idx
  ) THEN
    RAISE EXCEPTION 'player_already_used_this_round' USING ERRCODE = '42501';
  END IF;

  -- Append word to usedWords (defensive — client also tracks locally)
  v_used_words := COALESCE(v_state->'usedWords', '[]'::jsonb) || jsonb_build_array(p_word);

  v_state := v_state || jsonb_build_object(
    'currentPlayerIdx', p_player_idx,
    'currentWord',      p_word,
    'roundOutcome',     null,
    'phase',            'splash',
    'phaseStartAt',     public.huddle_phase_start_ms(),
    'usedWords',        v_used_words
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_dismiss_splash
-- ----------------------------------------------------------------------------
-- Any claimant. Advances from splash to play, marks current player as used,
-- captures turnStartTime.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_dismiss_splash(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_idx       INT;
  v_used      JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.huddle_is_claimant(v_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') <> 'splash' THEN
    -- Idempotent: someone already advanced
    RETURN v_state;
  END IF;

  v_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_used := COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb);
  -- Idempotent append
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_used) AS u(i)
    WHERE i::int = v_idx
  ) THEN
    v_used := v_used || to_jsonb(v_idx);
  END IF;

  v_state := v_state || jsonb_build_object(
    'playersUsedThisRound', v_used,
    'roundOutcome',         null,
    'turnStartTime',        (extract(epoch FROM now()) * 1000)::bigint,
    'phase',                'play',
    'phaseStartAt',         public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_end_round
-- ----------------------------------------------------------------------------
-- Role-gated: outcome='forfeit' requires caller to BE the hot seat player;
-- outcome='won' requires caller to NOT be the hot seat player. Server-side
-- this is enforced against the canonical claimedBy + currentPlayerIdx.
--
-- Records outcome, lastTurnDuration, player.wins (if won), player.bestTimeMs
-- (if best so far). Sets phase='result'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_end_round(
  p_code    TEXT,
  p_outcome TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid             TEXT;
  v_state           JSONB;
  v_my_seat         TEXT;
  v_current_idx     INT;
  v_players         JSONB;
  v_current_player  JSONB;
  v_current_pid     TEXT;
  v_duration        BIGINT;
  v_turn_start      BIGINT;
  v_player_wins     INT;
  v_player_best     BIGINT;
  v_new_players     JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_outcome NOT IN ('won', 'forfeit') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'phase') <> 'play' THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  -- Identify caller's seat
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_seat IS NULL THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;

  v_current_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  v_current_player := v_players->v_current_idx;
  v_current_pid := v_current_player->>'id';

  -- Role gate: forfeit must be hot seat, won must be non-hot-seat
  IF p_outcome = 'forfeit' AND v_my_seat <> v_current_pid THEN
    RAISE EXCEPTION 'only_hotseat_can_forfeit' USING ERRCODE = '42501';
  END IF;
  IF p_outcome = 'won' AND v_my_seat = v_current_pid THEN
    RAISE EXCEPTION 'only_helper_can_mark_won' USING ERRCODE = '42501';
  END IF;

  -- Compute duration
  v_turn_start := COALESCE((v_state->>'turnStartTime')::bigint, 0);
  IF v_turn_start > 0 THEN
    v_duration := (extract(epoch FROM now()) * 1000)::bigint - v_turn_start;
  ELSE
    v_duration := 0;
  END IF;

  -- Update player.wins / bestTimeMs if won
  IF p_outcome = 'won' THEN
    v_player_wins := COALESCE((v_current_player->>'wins')::int, 0) + 1;
    v_player_best := COALESCE((v_current_player->>'bestTimeMs')::bigint, 9223372036854775807);
    IF v_duration < v_player_best THEN
      v_player_best := v_duration;
    END IF;
    v_current_player := v_current_player || jsonb_build_object(
      'wins',       v_player_wins,
      'bestTimeMs', v_player_best
    );
    v_new_players := jsonb_set(v_players, ARRAY[v_current_idx::text], v_current_player);
    v_state := jsonb_set(v_state, '{players}', v_new_players);
  END IF;

  v_state := v_state || jsonb_build_object(
    'roundOutcome',     p_outcome,
    'lastTurnDuration', v_duration,
    'phase',            'result',
    'phaseStartAt',     public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_next_turn
-- ----------------------------------------------------------------------------
-- Host-only. Advances from result to next splash. If all players have been
-- used this round, increment currentRound and reset playersUsedThisRound
-- before starting the next turn.
--
-- Cascades into start_turn logic: sets currentPlayerIdx + word + phase.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_next_turn(
  p_code       TEXT,
  p_player_idx INT,
  p_word       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid            TEXT;
  v_state          JSONB;
  v_used           JSONB;
  v_claimed_count  INT;
  v_players        JSONB;
  v_player_id      TEXT;
  v_claimed_by     JSONB;
  v_used_words     JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_word IS NULL OR length(trim(p_word)) = 0 THEN
    RAISE EXCEPTION 'invalid_word' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') <> 'result' THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  v_used := COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb);
  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(v_claimed_by);

  -- Round-rollover: if all claimed players have been used, bump round & reset
  IF jsonb_array_length(v_used) >= v_claimed_count THEN
    v_state := jsonb_set(
      v_state,
      '{currentRound}',
      to_jsonb(COALESCE((v_state->>'currentRound')::int, 1) + 1)
    );
    v_state := jsonb_set(v_state, '{playersUsedThisRound}', '[]'::jsonb);
  END IF;

  -- Now start the next turn (mirrors start_turn validation)
  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  IF p_player_idx < 0 OR p_player_idx >= jsonb_array_length(v_players) THEN
    RAISE EXCEPTION 'invalid_player_idx' USING ERRCODE = '22023';
  END IF;
  v_player_id := v_players->p_player_idx->>'id';
  IF (v_claimed_by->>v_player_id) IS NULL THEN
    RAISE EXCEPTION 'seat_not_claimed' USING ERRCODE = '42501';
  END IF;
  v_used := COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_used) AS u(idx)
    WHERE idx::int = p_player_idx
  ) THEN
    RAISE EXCEPTION 'player_already_used_this_round' USING ERRCODE = '42501';
  END IF;

  v_used_words := COALESCE(v_state->'usedWords', '[]'::jsonb) || jsonb_build_array(p_word);

  v_state := v_state || jsonb_build_object(
    'currentPlayerIdx', p_player_idx,
    'currentWord',      p_word,
    'roundOutcome',     null,
    'phase',            'splash',
    'phaseStartAt',     public.huddle_phase_start_ms(),
    'usedWords',        v_used_words
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_play_again  (also used for fresh-game start from lobby)
-- ----------------------------------------------------------------------------
-- Host-only. Resets game state (wins=0, bestTimeMs=null, round=1, used=[],
-- _gamesPlayedCounted=false, closedByHost=false) then starts the first
-- turn (currentPlayerIdx + word + phase='splash').
--
-- Accepts both phase='lobby' (fresh game start via startGame) and
-- phase='result' (real Play Again from game-over screen). No phase guard.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_play_again(
  p_code       TEXT,
  p_player_idx INT,
  p_word       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_players       JSONB;
  v_player_id     TEXT;
  v_claimed_by    JSONB;
  v_used_words    JSONB;
  v_new_players   JSONB;
  v_idx           INT;
  v_p             JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_word IS NULL OR length(trim(p_word)) = 0 THEN
    RAISE EXCEPTION 'invalid_word' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  IF p_player_idx < 0 OR p_player_idx >= jsonb_array_length(v_players) THEN
    RAISE EXCEPTION 'invalid_player_idx' USING ERRCODE = '22023';
  END IF;
  v_player_id := v_players->p_player_idx->>'id';
  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  IF (v_claimed_by->>v_player_id) IS NULL THEN
    RAISE EXCEPTION 'seat_not_claimed' USING ERRCODE = '42501';
  END IF;

  -- Reset each player's wins + bestTimeMs
  v_new_players := '[]'::jsonb;
  FOR v_idx IN 0 .. jsonb_array_length(v_players) - 1 LOOP
    v_p := v_players->v_idx;
    v_p := v_p || jsonb_build_object(
      'wins',       0,
      'bestTimeMs', null
    );
    v_new_players := v_new_players || jsonb_build_array(v_p);
  END LOOP;

  v_used_words := COALESCE(v_state->'usedWords', '[]'::jsonb) || jsonb_build_array(p_word);

  v_state := v_state || jsonb_build_object(
    'players',               v_new_players,
    'currentRound',          1,
    'playersUsedThisRound',  '[]'::jsonb,
    '_gamesPlayedCounted',   false,
    'closedByHost',          false,
    'currentPlayerIdx',      p_player_idx,
    'currentWord',           p_word,
    'roundOutcome',          null,
    'phase',                 'splash',
    'phaseStartAt',          public.huddle_phase_start_ms(),
    'usedWords',             v_used_words
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_mark_game_counted
-- ----------------------------------------------------------------------------
-- Any claimant. Idempotently flips _gamesPlayedCounted=true so subsequent
-- re-renders of the result screen don't re-bump lifetime stats (C1 fix).
-- Server validates phase='result' AND lastTurn condition (used == claimed
-- AND currentRound == rounds).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_mark_game_counted(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_used_count       INT;
  v_claimed_count    INT;
  v_current_round    INT;
  v_rounds           INT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.huddle_is_claimant(v_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') <> 'result' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  -- Idempotent
  IF (v_state->>'_gamesPlayedCounted')::boolean IS TRUE THEN
    RETURN v_state;
  END IF;

  v_used_count := jsonb_array_length(COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb));
  SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(COALESCE(v_state->'claimedBy', '{}'::jsonb));
  v_current_round := COALESCE((v_state->>'currentRound')::int, 1);
  v_rounds := COALESCE((v_state->>'rounds')::int, 1);

  IF NOT (v_used_count = v_claimed_count AND v_current_round = v_rounds) THEN
    RAISE EXCEPTION 'not_last_turn' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{_gamesPlayedCounted}', 'true'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- Tighten hotseat_rooms UPDATE policy: DENY all direct UPDATE
-- ============================================================================
-- After this drops, only SECURITY DEFINER RPCs can mutate hotseat_rooms.
-- A claimant calling .from('hotseat_rooms').update(...) via REST gets
-- "permission denied". RPCs continue to work (they bypass RLS).
--
-- INSERT policy remains: room creation (hotStateReset) continues via direct
-- INSERT, governed by Turn 1's "Claimant can insert" policy.

-- [SAFE-APPLY] DROP POLICY line intentionally REMOVED — keeping direct-update policy so existing seat-claim/persist writes keep working. The RPCs below are SECURITY DEFINER and work regardless.


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_hot_start_turn(TEXT, INT, TEXT)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_dismiss_splash(TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_end_round(TEXT, TEXT)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_next_turn(TEXT, INT, TEXT)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_play_again(TEXT, INT, TEXT)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_mark_game_counted(TEXT)             TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_hot_start_turn(TEXT, INT, TEXT)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_dismiss_splash(TEXT)               FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_end_round(TEXT, TEXT)              FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_next_turn(TEXT, INT, TEXT)         FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_play_again(TEXT, INT, TEXT)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_mark_game_counted(TEXT)            FROM anon, public;
