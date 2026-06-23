-- ============================================================================
-- Huddle / Roundlly — C2 Turn 3 (Liar's Cup in-game RPCs, part A: round mechanics)
-- ============================================================================
--
-- Adds five game-specific RPCs for Liar's Cup. These move the most security-
-- critical mutations server-side: hand dealing, card-play ownership
-- validation, accuser identity, and game reset.
--
-- Deferred to a follow-up turn:
--   • huddle_liar_start_sip / take_sip / after_sip / finish_game (cup mechanics)
--   • huddle_liar_create_room / regenerate_room (room creation paths)
--   • Tightening liar_rooms UPDATE policy to deny direct upsert (after all
--     liar mutations are RPC-only)
--
-- Run AFTER huddle_c2_rls.sql AND huddle_c2_liar.sql succeeded.
-- This is a CREATE OR REPLACE — re-run-safe; no data is touched.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Helper: phase-start timestamp
-- ----------------------------------------------------------------------------
-- Mirrors huddleSyncMarkPhaseStart in the client (~450ms in the future) so
-- multi-device sync gate waits for all peers to receive the new state before
-- rendering the new phase. Time is milliseconds since epoch.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_phase_start_ms()
RETURNS BIGINT
LANGUAGE sql
STABLE PARALLEL SAFE
AS $$
  SELECT (extract(epoch FROM now()) * 1000)::bigint + 450;
$$;


-- ----------------------------------------------------------------------------
-- Helper: assert caller is host of this state
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_assert_host(p_state JSONB, p_uid TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  IF (p_state->>'hostId') IS DISTINCT FROM p_uid THEN
    RAISE EXCEPTION 'not_host' USING ERRCODE = '42501';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- Helper: shuffle a JSONB array (used for deck deal)
-- ----------------------------------------------------------------------------
-- Server-side shuffle prevents the client from rigging deals. Uses Postgres
-- random() which is good enough for game purposes (not cryptographic).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_shuffle_jsonb(p_arr JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE PARALLEL SAFE
AS $$
  SELECT COALESCE(jsonb_agg(elem ORDER BY random()), '[]'::jsonb)
  FROM jsonb_array_elements(p_arr) AS elem;
$$;


-- ----------------------------------------------------------------------------
-- huddle_liar_start_game
-- ----------------------------------------------------------------------------
-- Host-only. Sets up a fresh game from the lobby:
--   • alivePlayers = claimed seats
--   • cupSpills = 1, roundCount = 0, winnerId = null
--   • Deals first round's hands server-side
--   • Picks tableCard server-side
--   • Phase → 'tablecard'
-- Mirrors liarStartGame + first liarStartRound in client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_start_game(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_claimedBy     JSONB;
  v_alive         JSONB;
  v_alive_count   INT;
  v_deck          JSONB;
  v_multiplier    INT;
  v_hand_size     INT := 5;
  v_table_card    TEXT;
  v_prev_table    TEXT;
  v_hands         JSONB;
  v_player_hand   JSONB;
  v_player_id     TEXT;
  v_idx           INT;
  v_start_idx     INT;
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
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_claimedBy := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  -- alivePlayers = claimed seats only
  SELECT jsonb_agg(key ORDER BY key) INTO v_alive
  FROM jsonb_each_text(v_claimedBy);
  v_alive_count := jsonb_array_length(COALESCE(v_alive, '[]'::jsonb));
  IF v_alive_count < 2 THEN
    RAISE EXCEPTION 'need_at_least_2_players' USING ERRCODE = '42501';
  END IF;

  -- Deck multiplier (matches liarBuildDeck): >4 players doubles the deck
  v_multiplier := CASE WHEN v_alive_count > 4 THEN 2 ELSE 1 END;

  -- Build deck (6A, 6K, 6Q, 2J × multiplier)
  WITH ranks AS (
    SELECT 'A' AS rank, generate_series(1, 6 * v_multiplier) AS n
    UNION ALL
    SELECT 'K', generate_series(1, 6 * v_multiplier)
    UNION ALL
    SELECT 'Q', generate_series(1, 6 * v_multiplier)
    UNION ALL
    SELECT 'J', generate_series(1, 2 * v_multiplier)
  )
  SELECT jsonb_agg(
    jsonb_build_object('rank', rank, 'id', lower(rank) || n)
    ORDER BY random()
  )
  INTO v_deck
  FROM ranks;

  -- Pick tableCard — avoid same as previous round if possible
  v_prev_table := v_state->>'tableCard';
  IF v_prev_table IS NULL THEN
    v_table_card := (ARRAY['A','K','Q'])[1 + floor(random() * 3)::int];
  ELSE
    -- Pick from {A,K,Q} minus prev
    v_table_card := (
      SELECT r FROM unnest(ARRAY['A','K','Q']) r
      WHERE r <> v_prev_table
      ORDER BY random() LIMIT 1
    );
  END IF;

  -- Deal hands: 5 cards per alive player from the shuffled deck
  v_hands := '{}'::jsonb;
  FOR v_idx IN 0 .. v_alive_count - 1 LOOP
    v_player_id := v_alive->>v_idx;
    SELECT jsonb_agg(card)
    INTO v_player_hand
    FROM (
      SELECT card
      FROM jsonb_array_elements(v_deck) WITH ORDINALITY AS t(card, ord)
      WHERE ord > v_idx * v_hand_size AND ord <= (v_idx + 1) * v_hand_size
    ) s;
    v_hands := jsonb_set(v_hands, ARRAY[v_player_id], COALESCE(v_player_hand, '[]'::jsonb));
  END LOOP;

  -- Starting player: seat 0 (matches client default for first round)
  v_start_idx := 0;

  -- Build the new state
  v_state := v_state
    || jsonb_build_object(
      'alivePlayers',         v_alive,
      'cupSpills',            1,
      'roundCount',           1,
      'winnerId',             null,
      'tableCard',            v_table_card,
      'hands',                v_hands,
      'pile',                 '[]'::jsonb,
      'lastPlay',             null,
      'recentPlays',          '{}'::jsonb,
      'pendingLoserId',       null,
      'pendingLoserCause',    null,
      'sipOutcome',           null,
      'sipChamberIdx',        null,
      'sipChamberIsSpill',    '[]'::jsonb,
      'sipTaken',             false,
      'nextRoundStartIdx',    null,
      'currentPlayerIdx',     v_start_idx,
      'phase',                'tablecard',
      'phaseStartAt',         public.huddle_phase_start_ms()
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


-- ----------------------------------------------------------------------------
-- huddle_liar_start_first_turn
-- ----------------------------------------------------------------------------
-- Any claimant (typically the host taps it, but any claimant can to keep
-- the game moving if host is slow) advances phase: 'tablecard' → 'play'.
-- Mirrors liarStartFirstTurn in client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_start_first_turn(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   TEXT;
  v_state JSONB;
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
  IF NOT public.huddle_is_claimant(v_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') <> 'tablecard' THEN
    -- Idempotent for double-taps: if already past tablecard, return current state
    RETURN v_state;
  END IF;

  v_state := v_state
    || jsonb_build_object(
      'phase',        'play',
      'phaseStartAt', public.huddle_phase_start_ms()
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


-- ----------------------------------------------------------------------------
-- huddle_liar_play_cards
-- ----------------------------------------------------------------------------
-- Current player plays 1-3 cards face-down, claiming them as the table rank.
-- KEY SECURITY WIN: server validates the caller actually holds the cards
-- before removing them. A malicious client cannot inject cards they don't
-- own into the pile.
--
-- p_card_ids = JSONB array of card id strings, e.g. '["a3","k1"]'
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_play_cards(
  p_code     TEXT,
  p_card_ids JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_my_player_id     TEXT;
  v_current_idx      INT;
  v_alive            JSONB;
  v_current_player   TEXT;
  v_my_hand          JSONB;
  v_card_count       INT;
  v_played_cards     JSONB;
  v_new_hand         JSONB;
  v_new_pile         JSONB;
  v_table_card       TEXT;
  v_turn_index       INT;
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

  -- Phase guard
  IF (v_state->>'phase') <> 'play' THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  -- Identify caller's seat from claimedBy
  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS NULL THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;

  -- Caller must be the current player
  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  v_current_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_current_player := v_alive->>v_current_idx;
  IF v_current_player IS DISTINCT FROM v_my_player_id THEN
    RAISE EXCEPTION 'not_your_turn' USING ERRCODE = '42501';
  END IF;

  -- Card count guard (1-3 per Liar's Cup rules)
  IF jsonb_typeof(p_card_ids) <> 'array' THEN
    RAISE EXCEPTION 'invalid_card_ids' USING ERRCODE = '22023';
  END IF;
  v_card_count := jsonb_array_length(p_card_ids);
  IF v_card_count < 1 OR v_card_count > 3 THEN
    RAISE EXCEPTION 'card_count_out_of_range' USING ERRCODE = '22023';
  END IF;

  -- Caller's hand
  v_my_hand := COALESCE(v_state->'hands'->v_my_player_id, '[]'::jsonb);

  -- Verify EVERY requested card id is in caller's hand. This is the security
  -- linchpin — if any card id isn't present, the play is rejected wholesale.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_card_ids) AS requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_my_hand) AS held(card)
      WHERE held.card->>'id' = requested.id
    )
  ) THEN
    RAISE EXCEPTION 'card_not_in_hand' USING ERRCODE = '42501';
  END IF;

  -- Build the played-cards array (cards from hand with matching ids, in
  -- requested order). Then build the new hand (cards NOT in p_card_ids).
  SELECT jsonb_agg(card ORDER BY ord)
  INTO v_played_cards
  FROM jsonb_array_elements(v_my_hand) WITH ORDINALITY AS h(card, ord)
  WHERE card->>'id' IN (SELECT jsonb_array_elements_text(p_card_ids));

  SELECT jsonb_agg(card)
  INTO v_new_hand
  FROM jsonb_array_elements(v_my_hand) AS h(card)
  WHERE card->>'id' NOT IN (SELECT jsonb_array_elements_text(p_card_ids));

  v_new_pile := COALESCE(v_state->'pile', '[]'::jsonb) || v_played_cards;
  v_table_card := v_state->>'tableCard';
  v_turn_index := jsonb_array_length(v_new_pile);

  -- Apply mutations
  v_state := jsonb_set(v_state, ARRAY['hands', v_my_player_id], COALESCE(v_new_hand, '[]'::jsonb));
  v_state := jsonb_set(v_state, '{pile}', v_new_pile);
  v_state := jsonb_set(v_state, '{lastPlay}', jsonb_build_object(
    'count',        v_card_count,
    'cards',        v_played_cards,
    'byPlayerId',   v_my_player_id,
    'claimedRank',  v_table_card
  ));
  v_state := jsonb_set(
    v_state,
    ARRAY['recentPlays', v_my_player_id],
    jsonb_build_object(
      'count',       v_card_count,
      'claimedRank', v_table_card,
      'turnIndex',   v_turn_index
    ),
    true
  );

  -- Advance turn
  v_state := jsonb_set(
    v_state,
    '{currentPlayerIdx}',
    to_jsonb((v_current_idx + 1) % jsonb_array_length(v_alive))
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


-- ----------------------------------------------------------------------------
-- huddle_liar_call_liar
-- ----------------------------------------------------------------------------
-- Current player (whose turn it would be) calls LIAR on the previous play.
-- Server determines pendingLoser based on whether the cards actually match
-- the claimed rank. Phase → 'reveal'.
-- Mirrors liarCallLiar in client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_call_liar(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_my_player_id     TEXT;
  v_current_idx      INT;
  v_alive            JSONB;
  v_current_player   TEXT;
  v_last_play        JSONB;
  v_accused_id       TEXT;
  v_claimed_rank     TEXT;
  v_all_valid        BOOLEAN;
  v_pending_loser    TEXT;
  v_pending_cause    TEXT;
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

  IF (v_state->>'phase') <> 'play' THEN
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  v_last_play := v_state->'lastPlay';
  IF v_last_play IS NULL OR jsonb_typeof(v_last_play) <> 'object' THEN
    RAISE EXCEPTION 'no_last_play' USING ERRCODE = '42501';
  END IF;

  -- Identify caller's seat
  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS NULL THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;

  -- Caller must be the current player
  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  v_current_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_current_player := v_alive->>v_current_idx;
  IF v_current_player IS DISTINCT FROM v_my_player_id THEN
    RAISE EXCEPTION 'not_your_turn' USING ERRCODE = '42501';
  END IF;

  v_accused_id := v_last_play->>'byPlayerId';
  v_claimed_rank := v_last_play->>'claimedRank';

  -- All cards valid if every one matches claimed rank OR is a Joker
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_last_play->'cards') AS c(card)
    WHERE (card->>'rank') <> v_claimed_rank AND (card->>'rank') <> 'J'
  ) INTO v_all_valid;

  IF v_all_valid THEN
    v_pending_loser := v_my_player_id;     -- wrong accuse
    v_pending_cause := 'wrongAccuse';
  ELSE
    v_pending_loser := v_accused_id;       -- liar caught
    v_pending_cause := 'lied';
  END IF;

  v_state := v_state || jsonb_build_object(
    'pendingLoserId',    v_pending_loser,
    'pendingLoserCause', v_pending_cause,
    'phase',             'reveal',
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


-- ----------------------------------------------------------------------------
-- huddle_liar_play_again
-- ----------------------------------------------------------------------------
-- Host-only. Resets game state to lobby (preserves wins for cross-game
-- leaderboard).
-- Mirrors liarPlayAgain in client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_play_again(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_players   JSONB;
  v_alive     JSONB;
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
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') <> 'result' THEN
    -- Mirror client's double-tap guard
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;

  -- alivePlayers = all players (matches client liarPlayAgain line 16992)
  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  SELECT jsonb_agg(p->>'id') INTO v_alive
  FROM jsonb_array_elements(v_players) p;

  v_state := v_state || jsonb_build_object(
    'alivePlayers',      COALESCE(v_alive, '[]'::jsonb),
    'cupSpills',         1,
    'roundCount',        0,
    'winnerId',          null,
    'pile',              '[]'::jsonb,
    'lastPlay',          null,
    'pendingLoserId',    null,
    'pendingLoserCause', null,
    'sipTaken',          false,
    'closedByHost',      false,
    'phase',             'lobby'
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


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_liar_start_game(TEXT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_start_first_turn(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_play_cards(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_call_liar(TEXT)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_play_again(TEXT)       TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_liar_start_game(TEXT)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_start_first_turn(TEXT)  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_play_cards(TEXT, JSONB) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_call_liar(TEXT)         FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_play_again(TEXT)        FROM anon, public;
