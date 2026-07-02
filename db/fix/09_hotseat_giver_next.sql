-- ============================================================================
-- db/fix/09_hotseat_giver_next.sql  (2026-07-01)
-- ----------------------------------------------------------------------------
-- ⚠⚠ SUPERSEDED by db/fix/12_hotseat_gtt_order_deck.sql (2026-07-02) ⚠⚠
-- Run 12 INSTEAD of this file — it contains this function plus a 4th
-- parameter (p_giver_idx, the "biggest giver" stat). NEVER run this file
-- AFTER 12: it would re-create the old 3-argument version NEXT TO the new
-- 4-argument one and PostgREST would reject every call as ambiguous.
-- Kept only as history of what shipped with commit 3fa3a02.
-- ----------------------------------------------------------------------------
-- "Guess the Theme" mode — the "whoever gives it away goes next" rule.
--
-- In this mode the game does NOT take fixed turns. Whoever's clue cracks the
-- theme is put in the hot seat next, chosen by the player who just escaped
-- (or random when they give up). That means:
--   * the NEXT player is picked by the CURRENT hot-seat player (not the host),
--   * the same person can be picked again (no "everyone once per round" limit),
--   * scores (wins / best time) carry across — it's one continuous game.
--
-- The existing huddle_hot_next_turn can't do this: it's host-only and rejects
-- a player who already went this round. So this is a NEW, separate function;
-- nothing else changes. Classic / Silent keep using huddle_hot_next_turn.
--
-- SAFE TO RE-RUN: CREATE OR REPLACE, no data migration. Apply any time.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_hot_giver_next(p_code text, p_player_idx integer, p_word text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid          TEXT;
  v_state        JSONB;
  v_players      JSONB;
  v_claimed_by   JSONB;
  v_cur_idx      INT;
  v_cur_pid      TEXT;
  v_cur_sid      TEXT;
  v_player_id    TEXT;
  v_used_words   JSONB;
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
  IF (v_state->>'phase') <> 'result' THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  v_players    := COALESCE(v_state->'players', '[]'::jsonb);
  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);

  -- Authorize: the caller must be the CURRENT hot-seat player (the one who just
  -- guessed or gave up) OR the host (fallback if that player has dropped, so the
  -- game can still advance).
  v_cur_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_cur_pid := v_players->v_cur_idx->>'id';
  v_cur_sid := v_claimed_by->>v_cur_pid;
  IF v_uid <> COALESCE(v_cur_sid, '') AND v_uid <> COALESCE(v_state->>'hostId', '') THEN
    RAISE EXCEPTION 'not_current_or_host' USING ERRCODE = '42501';
  END IF;

  -- The picked next player must be a claimed seat (any claimed seat — repeats OK).
  IF p_player_idx < 0 OR p_player_idx >= jsonb_array_length(v_players) THEN
    RAISE EXCEPTION 'invalid_player_idx' USING ERRCODE = '22023';
  END IF;
  v_player_id := v_players->p_player_idx->>'id';
  IF (v_claimed_by->>v_player_id) IS NULL THEN
    RAISE EXCEPTION 'seat_not_claimed' USING ERRCODE = '42501';
  END IF;

  v_used_words := COALESCE(v_state->'usedWords', '[]'::jsonb) || jsonb_build_array(p_word);

  -- Start the next turn. NO round-rollover, NO used-this-round tracking, and
  -- wins/bestTimeMs are left untouched (one continuous game).
  v_state := v_state || jsonb_build_object(
    'currentPlayerIdx',     p_player_idx,
    'currentWord',          p_word,
    'roundOutcome',         null,
    'playersUsedThisRound', '[]'::jsonb,
    'phase',                'splash',
    'phaseStartAt',         public.huddle_phase_start_ms(),
    'usedWords',            v_used_words
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$function$;

GRANT EXECUTE   ON FUNCTION public.huddle_hot_giver_next(text, integer, text) TO authenticated;
REVOKE EXECUTE  ON FUNCTION public.huddle_hot_giver_next(text, integer, text) FROM anon, public;
