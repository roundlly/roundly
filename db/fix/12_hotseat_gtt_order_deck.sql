-- ============================================================================
-- db/fix/12_hotseat_gtt_order_deck.sql  (2026-07-02)
-- ----------------------------------------------------------------------------
-- "Guess the Theme" — 3 hot-seat orders + "biggest giver" stat + deck system
-- + host End-game / "Deck finished!" standings screen. Four changes:
--
--   1. huddle_hot_giver_next  — REPLACED with a 4th parameter p_giver_idx.
--      After each escape the winner picks WHOSE clue gave it away. That pick
--      now also bumps that player's giverCount (the "biggest giver" standings
--      stat), which must live in synced room state — client-side counting
--      would drift between phones. In "Giver goes next" order the blamed
--      player is also the next hot seat; in Rotating/Random the pick is
--      stats-only and p_player_idx follows the order instead.
--
--   2. huddle_hot_play_again  — REPLACED with a 4th parameter p_fresh_deck.
--      The deck rule: a theme NEVER repeats in a room — usedWords already
--      carries across Play-again (this function has always appended, never
--      reset). p_fresh_deck=true is the one exception: after "Deck finished!"
--      a new game reshuffles the pack (usedWords restarts at just the new
--      first word). Also zeroes giverCount alongside wins/bestTimeMs (all
--      three are per-game stats) and clears endReason.
--
--   3. huddle_hot_end_game    — NEW. Ends a Guess the Theme game: sets
--      phase='ended' + endReason ('host' = host tapped End game, 'deck' =
--      the selected pack ran out of themes). Every phone routes to the final
--      standings screen. 'host' requires the host; 'deck' is fired by the
--      player advancing the game (current hot seat) or the host. Can also
--      record a final blame (p_giver_idx) so the last round's pick counts.
--
--   4. huddle_hot_mark_game_counted — REPLACED (same signature): now accepts
--      phase='ended' (a continuous Guess-the-Theme game over) in addition to
--      the classic last-turn 'result', so these games count in profile stats.
--
-- ⚠⚠ SUPERSEDES db/fix/09_hotseat_giver_next.sql ⚠⚠
--   * If 09 was NEVER run: skip it — run THIS file only.
--   * If 09 WAS run: running this file upgrades it (the old 3-argument
--     version is dropped below).
--   * NEVER run 09 AFTER this file — it would re-create the old 3-argument
--     function NEXT TO the new 4-argument one, and PostgREST then rejects
--     every call as ambiguous (the game could not advance at all).
--
-- Old deployed clients keep working: they call these functions without the
-- new arguments, which all have DEFAULTs.
--
-- SAFE TO RE-RUN: DROP IF EXISTS + CREATE OR REPLACE, no data migration.
-- UNTIL THIS IS RUN: in Guess the Theme, advancing after a win (blame pick),
-- the host End-game button, the "Deck finished!" ending and Play-again from
-- the standings screen all fail with a couldn't-sync toast.
-- ============================================================================


-- ============================================================================
-- 1) huddle_hot_giver_next — now also records the "biggest giver" stat
-- ============================================================================
-- Signature change (3 args → 4 args with DEFAULT) requires dropping the old
-- version first; CREATE OR REPLACE alone would leave both behind (ambiguous).
DROP FUNCTION IF EXISTS public.huddle_hot_giver_next(text, integer, text);

CREATE OR REPLACE FUNCTION public.huddle_hot_giver_next(p_code text, p_player_idx integer, p_word text, p_giver_idx integer DEFAULT NULL)
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
  v_giver        JSONB;
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

  -- "Biggest giver" stat: the escapee reported whose clue gave it away — bump
  -- that player's giverCount. Skipped silently if the blamed seat is no longer
  -- claimed (the player left between the result screen and the tap): losing
  -- one stat tick is better than blocking the game from advancing.
  IF p_giver_idx IS NOT NULL
     AND p_giver_idx >= 0 AND p_giver_idx < jsonb_array_length(v_players)
     AND (v_claimed_by->>(v_players->p_giver_idx->>'id')) IS NOT NULL
  THEN
    v_giver := v_players->p_giver_idx;
    v_giver := v_giver || jsonb_build_object(
      'giverCount', COALESCE((v_giver->>'giverCount')::int, 0) + 1
    );
    v_players := jsonb_set(v_players, ARRAY[p_giver_idx::text], v_giver);
    v_state := jsonb_set(v_state, '{players}', v_players);
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

GRANT EXECUTE   ON FUNCTION public.huddle_hot_giver_next(text, integer, text, integer) TO authenticated;
REVOKE EXECUTE  ON FUNCTION public.huddle_hot_giver_next(text, integer, text, integer) FROM anon, public;


-- ============================================================================
-- 2) huddle_hot_play_again — deck persistence + optional fresh-deck reshuffle
-- ============================================================================
DROP FUNCTION IF EXISTS public.huddle_hot_play_again(text, integer, text);

CREATE OR REPLACE FUNCTION public.huddle_hot_play_again(p_code text, p_player_idx integer, p_word text, p_fresh_deck boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Reset each player's per-game stats: wins, bestTimeMs and (Guess the Theme)
  -- giverCount all start fresh with the new game.
  v_new_players := '[]'::jsonb;
  FOR v_idx IN 0 .. jsonb_array_length(v_players) - 1 LOOP
    v_p := v_players->v_idx;
    v_p := v_p || jsonb_build_object(
      'wins',       0,
      'bestTimeMs', null,
      'giverCount', 0
    );
    v_new_players := v_new_players || jsonb_build_array(v_p);
  END LOOP;

  -- Deck rule (Guess the Theme): usedWords persists across Play-again so a
  -- theme never repeats in the room — APPEND, don't reset. p_fresh_deck=true
  -- (sent only from the "Deck finished!" standings screen, or a lobby start
  -- when the pack is fully used) reshuffles: the list restarts at p_word.
  IF p_fresh_deck THEN
    v_used_words := jsonb_build_array(p_word);
  ELSE
    v_used_words := COALESCE(v_state->'usedWords', '[]'::jsonb) || jsonb_build_array(p_word);
  END IF;

  v_state := v_state || jsonb_build_object(
    'players',               v_new_players,
    'currentRound',          1,
    'playersUsedThisRound',  '[]'::jsonb,
    '_gamesPlayedCounted',   false,
    'closedByHost',          false,
    'currentPlayerIdx',      p_player_idx,
    'currentWord',           p_word,
    'roundOutcome',          null,
    'endReason',             null,
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
$function$;

GRANT EXECUTE   ON FUNCTION public.huddle_hot_play_again(text, integer, text, boolean) TO authenticated;
REVOKE EXECUTE  ON FUNCTION public.huddle_hot_play_again(text, integer, text, boolean) FROM anon, public;


-- ============================================================================
-- 3) huddle_hot_end_game — NEW: end a Guess the Theme game → final standings
-- ============================================================================
CREATE OR REPLACE FUNCTION public.huddle_hot_end_game(p_code text, p_reason text DEFAULT 'host', p_giver_idx integer DEFAULT NULL)
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
  v_is_host      BOOLEAN;
  v_giver        JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_reason NOT IN ('host', 'deck') THEN
    RAISE EXCEPTION 'invalid_reason: %', p_reason USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  -- Only Guess the Theme (mode 'link') has the continuous game + standings
  -- screen; Classic/Silent end via their fixed last turn.
  IF COALESCE(v_state->>'mode', '') <> 'link' THEN
    RAISE EXCEPTION 'wrong_mode: %', v_state->>'mode' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') NOT IN ('result', 'play') THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  v_players    := COALESCE(v_state->'players', '[]'::jsonb);
  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  v_cur_idx    := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_cur_pid    := v_players->v_cur_idx->>'id';
  v_cur_sid    := v_claimed_by->>v_cur_pid;
  v_is_host    := (v_uid = COALESCE(v_state->>'hostId', ''));

  -- 'host' = the manual End-game button → host only.
  -- 'deck' = the pack ran out of themes → fired by whoever was advancing the
  --          game (the current hot-seat player) or the host as fallback.
  IF p_reason = 'host' AND NOT v_is_host THEN
    RAISE EXCEPTION 'not_host' USING ERRCODE = '42501';
  END IF;
  IF p_reason = 'deck' AND v_uid <> COALESCE(v_cur_sid, '') AND NOT v_is_host THEN
    RAISE EXCEPTION 'not_current_or_host' USING ERRCODE = '42501';
  END IF;

  -- Record the final round's blame too (same rules as huddle_hot_giver_next),
  -- so a "Deck finished!" ending doesn't lose the last "who gave it away" pick.
  IF p_giver_idx IS NOT NULL
     AND p_giver_idx >= 0 AND p_giver_idx < jsonb_array_length(v_players)
     AND (v_claimed_by->>(v_players->p_giver_idx->>'id')) IS NOT NULL
  THEN
    v_giver := v_players->p_giver_idx;
    v_giver := v_giver || jsonb_build_object(
      'giverCount', COALESCE((v_giver->>'giverCount')::int, 0) + 1
    );
    v_players := jsonb_set(v_players, ARRAY[p_giver_idx::text], v_giver);
    v_state := jsonb_set(v_state, '{players}', v_players);
  END IF;

  v_state := v_state || jsonb_build_object(
    'phase',        'ended',
    'endReason',    p_reason,
    'roundOutcome', null,
    'phaseStartAt', public.huddle_phase_start_ms()
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

GRANT EXECUTE   ON FUNCTION public.huddle_hot_end_game(text, text, integer) TO authenticated;
REVOKE EXECUTE  ON FUNCTION public.huddle_hot_end_game(text, text, integer) FROM anon, public;


-- ============================================================================
-- 4) huddle_hot_mark_game_counted — accept phase='ended' (GTT game over)
-- ============================================================================
-- Same signature → plain CREATE OR REPLACE (no drop needed). Body identical to
-- the live version except: 'ended' passes the phase gate and skips the classic
-- last-turn check (a continuous game has no fixed last turn — 'ended' IS over).
CREATE OR REPLACE FUNCTION public.huddle_hot_mark_game_counted(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF (v_state->>'phase') NOT IN ('result', 'ended') THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  -- Idempotent
  IF (v_state->>'_gamesPlayedCounted')::boolean IS TRUE THEN
    RETURN v_state;
  END IF;

  -- Classic/Silent: only the true last turn counts. 'ended' (Guess the Theme
  -- standings screen) is by definition the end of the game — no turn math.
  IF (v_state->>'phase') = 'result' THEN
    v_used_count := jsonb_array_length(COALESCE(v_state->'playersUsedThisRound', '[]'::jsonb));
    SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(COALESCE(v_state->'claimedBy', '{}'::jsonb));
    v_current_round := COALESCE((v_state->>'currentRound')::int, 1);
    v_rounds := COALESCE((v_state->>'rounds')::int, 1);

    IF NOT (v_used_count = v_claimed_count AND v_current_round = v_rounds) THEN
      RAISE EXCEPTION 'not_last_turn' USING ERRCODE = '42501';
    END IF;
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
$function$;

GRANT EXECUTE   ON FUNCTION public.huddle_hot_mark_game_counted(text) TO authenticated;
REVOKE EXECUTE  ON FUNCTION public.huddle_hot_mark_game_counted(text) FROM anon, public;


-- Sanity checks after running:
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname IN
--     ('huddle_hot_giver_next','huddle_hot_play_again','huddle_hot_end_game','huddle_hot_mark_game_counted');
-- Expect EXACTLY ONE row per name:
--   huddle_hot_giver_next        p_code text, p_player_idx integer, p_word text, p_giver_idx integer
--   huddle_hot_play_again        p_code text, p_player_idx integer, p_word text, p_fresh_deck boolean
--   huddle_hot_end_game          p_code text, p_reason text, p_giver_idx integer
--   huddle_hot_mark_game_counted p_code text
