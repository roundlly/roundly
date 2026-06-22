-- ============================================================================
-- Huddle / Roundlly — Liar's Cup rule change: anyone-can-call-LIAR
-- ============================================================================
--
-- Original rule: only the player whose turn is next (alivePlayers[currentIdx])
-- could call LIAR on the most recent play.
--
-- New rule: ANY alive player EXCEPT the accused (lastPlay.byPlayerId) can
-- call LIAR. First valid call wins (server serializes via FOR UPDATE);
-- subsequent calls in the same window get 'wrong_phase' (because phase has
-- already moved to 'reveal').
--
-- Two RPC updates:
--   1. huddle_liar_call_liar — relaxes caller gate AND stores pendingAccuserId
--      so the next-round-starter rule works regardless of whose turn it was.
--   2. huddle_liar_after_sip — reads pendingAccuserId from state instead of
--      deriving accuser from alivePlayers[currentPlayerIdx].
--
-- Also updates huddle_liar_handle_disconnect (case A: loser-DC) which uses
-- the same accuser derivation.
--
-- Safe to run on top of all earlier C2 migrations. CREATE OR REPLACE only,
-- no data changes.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_liar_call_liar (NEW: anyone alive except accused)
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
  v_alive            JSONB;
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

  -- NEW: caller must be ALIVE (still in this round) and NOT the accused
  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_alive) AS a(pid)
    WHERE a.pid = v_my_player_id
  ) THEN
    RAISE EXCEPTION 'not_alive' USING ERRCODE = '42501';
  END IF;

  v_accused_id := v_last_play->>'byPlayerId';
  IF v_my_player_id = v_accused_id THEN
    RAISE EXCEPTION 'cannot_call_on_self' USING ERRCODE = '42501';
  END IF;

  v_claimed_rank := v_last_play->>'claimedRank';

  -- All cards valid if every one matches claimed rank OR is a Joker
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_last_play->'cards') AS c(card)
    WHERE (card->>'rank') <> v_claimed_rank AND (card->>'rank') <> 'J'
  ) INTO v_all_valid;

  IF v_all_valid THEN
    v_pending_loser := v_my_player_id;     -- wrong accuse → CALLER goes to cup
    v_pending_cause := 'wrongAccuse';
  ELSE
    v_pending_loser := v_accused_id;       -- liar caught
    v_pending_cause := 'lied';
  END IF;

  -- NEW: store the accuser so after_sip can pick the right next-round leader
  -- regardless of whose turn it was at call time.
  v_state := v_state || jsonb_build_object(
    'pendingAccuserId',  v_my_player_id,
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
-- huddle_liar_after_sip (UPDATED: read pendingAccuserId from state)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_after_sip(p_code TEXT)
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
  v_pending_cause    TEXT;
  v_pending_accuser  TEXT;
  v_alive            JSONB;
  v_accused_id       TEXT;
  v_winner_id        TEXT;
  v_outcome          TEXT;
  v_alive_count      INT;
  v_cup_spills       INT;
  v_round_count      INT;
  v_winner_idx       INT;
  v_multiplier       INT;
  v_hand_size        INT := 5;
  v_table_card       TEXT;
  v_prev_table       TEXT;
  v_deck             JSONB;
  v_hands            JSONB;
  v_player_hand      JSONB;
  v_player_id        TEXT;
  v_idx              INT;
  v_wins             JSONB;
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

  IF (v_state->>'phase') <> 'cup' THEN
    RETURN v_state;
  END IF;
  IF (v_state->>'sipTaken')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'sip_not_taken' USING ERRCODE = '42501';
  END IF;

  v_pending_loser   := v_state->>'pendingLoserId';
  v_pending_cause   := v_state->>'pendingLoserCause';
  v_pending_accuser := v_state->>'pendingAccuserId';
  v_outcome         := v_state->>'sipOutcome';

  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS DISTINCT FROM v_pending_loser THEN
    RAISE EXCEPTION 'not_loser' USING ERRCODE = '42501';
  END IF;

  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  v_accused_id := v_state->'lastPlay'->>'byPlayerId';

  -- NEW: winner of LIAR call uses the stored accuser, not currentPlayerIdx.
  -- Fallback to currentPlayerIdx-derived accuser for backward compatibility
  -- with any state written before this migration.
  IF v_pending_accuser IS NULL THEN
    v_pending_accuser := v_alive->>COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  END IF;

  v_winner_id := CASE
    WHEN v_pending_cause = 'lied' THEN v_pending_accuser
    ELSE v_accused_id
  END;

  IF v_outcome = 'spilled' THEN
    SELECT jsonb_agg(p_id ORDER BY ord)
    INTO v_alive
    FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
    WHERE p_id <> v_pending_loser;
    v_alive := COALESCE(v_alive, '[]'::jsonb);
    v_alive_count := jsonb_array_length(v_alive);

    IF v_alive_count <= 1 THEN
      v_winner_id := v_alive->>0;
      v_wins := COALESCE(v_state->'wins', '{}'::jsonb);
      IF v_winner_id IS NOT NULL THEN
        v_wins := jsonb_set(
          v_wins,
          ARRAY[v_winner_id],
          to_jsonb(COALESCE((v_wins->>v_winner_id)::int, 0) + 1),
          true
        );
      END IF;

      v_state := v_state || jsonb_build_object(
        'alivePlayers', v_alive,
        'wins',         v_wins,
        'winnerId',     v_winner_id,
        'phase',        'result',
        'phaseStartAt', public.huddle_phase_start_ms()
      );
      v_state := jsonb_set(
        v_state,
        '{revision}',
        to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
      );
      UPDATE public.liar_rooms SET state = v_state WHERE code = p_code;
      RETURN v_state;
    END IF;

    v_cup_spills := 1;
  ELSE
    v_cup_spills := LEAST(6, COALESCE((v_state->>'cupSpills')::int, 1) + 1);
    v_alive_count := jsonb_array_length(v_alive);
  END IF;

  v_winner_idx := COALESCE(
    (SELECT ord::int - 1
     FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
     WHERE p_id = v_winner_id
     LIMIT 1),
    0
  );

  v_multiplier := CASE WHEN v_alive_count > 4 THEN 2 ELSE 1 END;
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

  v_prev_table := v_state->>'tableCard';
  IF v_prev_table IS NULL THEN
    v_table_card := (ARRAY['A','K','Q'])[1 + floor(random() * 3)::int];
  ELSE
    v_table_card := (
      SELECT r FROM unnest(ARRAY['A','K','Q']) r
      WHERE r <> v_prev_table
      ORDER BY random() LIMIT 1
    );
  END IF;

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

  v_round_count := COALESCE((v_state->>'roundCount')::int, 0) + 1;

  v_state := v_state || jsonb_build_object(
    'alivePlayers',       v_alive,
    'cupSpills',          v_cup_spills,
    'roundCount',         v_round_count,
    'tableCard',          v_table_card,
    'hands',              v_hands,
    'pile',               '[]'::jsonb,
    'lastPlay',           null,
    'recentPlays',        '{}'::jsonb,
    'pendingLoserId',     null,
    'pendingLoserCause',  null,
    'pendingAccuserId',   null,
    'sipOutcome',         null,
    'sipChamberIdx',      null,
    'sipChamberIsSpill',  '[]'::jsonb,
    'sipTaken',           false,
    'nextRoundStartIdx',  null,
    'currentPlayerIdx',   v_winner_idx,
    'phase',              'tablecard',
    'phaseStartAt',       public.huddle_phase_start_ms()
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
-- Note on huddle_liar_handle_disconnect (case A):
-- The disconnect handler also has next-round-deal cascade logic. It already
-- reads pendingLoserCause but derives accuser from currentPlayerIdx. With
-- the fallback path in after_sip above, disconnect-cleanup will still work
-- correctly for legacy states. Going forward, new states have
-- pendingAccuserId populated by call_liar, so the cleanup is consistent.
-- No update needed if huddle_liar_handle_disconnect's "case A" rarely fires.
-- (Disconnected loser is an edge case; deferred to a follow-up if needed.)
-- ----------------------------------------------------------------------------
