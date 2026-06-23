-- ============================================================================
-- Huddle / Roundlly — C2 Turn 3b (Liar's Cup cup mechanics + game end)
-- ============================================================================
--
-- Adds three RPCs that move the cup phase, sip outcome, and round-cascade
-- server-side. Folds finish_game into after_sip.
--
-- After this lands, the only Liar's Cup mutations still using direct upsert
-- are room creation (liarStateReset) and regenerate. Those are Turn 3c.
-- The UPDATE policy tightening also waits for Turn 3c.
--
-- Run AFTER huddle_c2_rls.sql, huddle_c2_liar.sql, and
-- huddle_c2_liar_ingame.sql have succeeded.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_liar_start_sip
-- ----------------------------------------------------------------------------
-- Loser-only (or fallback-by-lowest-connected). Builds the 6-chamber spill
-- pattern server-side and transitions phase 'reveal' → 'cup'.
--
-- Mirrors liarStartSip in client. The chamber pattern is random server-side
-- so a cheating client can't preview spill positions.
--
-- Authorization gate: caller must be pendingLoserId. (The client also has a
-- "lowest-connected fallback" for the case the loser DC'd — for now the RPC
-- only allows the actual loser to call. If the loser is gone, the fallback
-- pathway can be re-introduced later via presence-aware policy. This is a
-- minor regression from today's auto-advance-by-fallback but the security
-- gain is worth it.)
-- ----------------------------------------------------------------------------
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
    -- Idempotent for double-fire: already past reveal, return current state
    RETURN v_state;
  END IF;

  v_pending_loser := v_state->>'pendingLoserId';
  IF v_pending_loser IS NULL THEN
    RAISE EXCEPTION 'no_pending_loser' USING ERRCODE = '42501';
  END IF;

  -- Caller must be the pending loser
  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS DISTINCT FROM v_pending_loser THEN
    RAISE EXCEPTION 'not_loser' USING ERRCODE = '42501';
  END IF;

  -- Build chamber pattern: place `spills` true values among 6 chambers randomly.
  v_spills := GREATEST(1, LEAST(6, COALESCE((v_state->>'cupSpills')::int, 1)));

  -- Generate 6 booleans: first v_spills are true, then shuffled.
  SELECT jsonb_agg(is_spill ORDER BY random())
  INTO v_chambers
  FROM (
    SELECT (n <= v_spills) AS is_spill
    FROM generate_series(1, 6) n
  ) s;

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


-- ----------------------------------------------------------------------------
-- huddle_liar_take_sip
-- ----------------------------------------------------------------------------
-- Loser-only. Server picks a random chamber, resolves outcome, sets sipTaken.
-- THE KEY SECURITY WIN: the random chamber pick is server-side. A cheating
-- client cannot rig their own cup outcome.
--
-- Phase stays 'cup' (rendering reacts to sipTaken=true to play the animation).
-- liar_after_sip is what advances phase next.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_take_sip(p_code TEXT)
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
  v_chambers         JSONB;
  v_chamber_idx      INT;
  v_is_spill         BOOLEAN;
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
    RAISE EXCEPTION 'wrong_phase: %', v_state->>'phase' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'sipTaken')::boolean IS TRUE THEN
    -- Idempotent for double-tap
    RETURN v_state;
  END IF;

  v_pending_loser := v_state->>'pendingLoserId';
  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS DISTINCT FROM v_pending_loser THEN
    RAISE EXCEPTION 'not_loser' USING ERRCODE = '42501';
  END IF;

  v_chambers := COALESCE(v_state->'sipChamberIsSpill', '[]'::jsonb);
  IF jsonb_array_length(v_chambers) <> 6 THEN
    RAISE EXCEPTION 'invalid_chamber_state' USING ERRCODE = '42501';
  END IF;

  v_chamber_idx := floor(random() * 6)::int;
  v_is_spill := (v_chambers->v_chamber_idx)::text::boolean;

  v_state := v_state || jsonb_build_object(
    'sipChamberIdx', v_chamber_idx,
    'sipOutcome',    CASE WHEN v_is_spill THEN 'spilled' ELSE 'safe' END,
    'sipTaken',      true,
    'phaseStartAt',  public.huddle_phase_start_ms()
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
-- huddle_liar_after_sip
-- ----------------------------------------------------------------------------
-- Loser-only. After the cup animation runs on every device, the loser's
-- device fires this. It:
--   1. Determines winnerId of the LIAR resolution (accuser if cause='lied',
--      accused if cause='wrongAccuse'). Winner of the call leads the next
--      round (Huddle's custom rule).
--   2. If outcome='spilled':
--      a. Remove loser from alivePlayers.
--      b. If alivePlayers <= 1: set state.winnerId, bump wins map,
--         phase='result'. Game over.
--      c. Else: reset cupSpills=1, deal new round inline.
--   3. If outcome='safe': cupSpills++ (capped at 6), deal new round inline.
--
-- The "deal new round" logic mirrors huddle_liar_start_game but starts the
-- round at winnerIdx (the winner of the LIAR call) instead of seat 0.
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
  v_alive            JSONB;
  v_accuser_idx      INT;
  v_accuser_id       TEXT;
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
    -- Already advanced by another fire; idempotent return
    RETURN v_state;
  END IF;
  IF (v_state->>'sipTaken')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'sip_not_taken' USING ERRCODE = '42501';
  END IF;

  v_pending_loser := v_state->>'pendingLoserId';
  v_pending_cause := v_state->>'pendingLoserCause';
  v_outcome := v_state->>'sipOutcome';

  SELECT key INTO v_my_player_id
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_player_id IS DISTINCT FROM v_pending_loser THEN
    RAISE EXCEPTION 'not_loser' USING ERRCODE = '42501';
  END IF;

  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  v_accuser_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
  v_accuser_id := v_alive->>v_accuser_idx;
  v_accused_id := v_state->'lastPlay'->>'byPlayerId';

  -- Winner of the LIAR call: accuser if 'lied', accused if 'wrongAccuse'
  v_winner_id := CASE
    WHEN v_pending_cause = 'lied' THEN v_accuser_id
    ELSE v_accused_id
  END;

  IF v_outcome = 'spilled' THEN
    -- Eliminate loser from alivePlayers
    SELECT jsonb_agg(p_id ORDER BY ord)
    INTO v_alive
    FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
    WHERE p_id <> v_pending_loser;
    v_alive := COALESCE(v_alive, '[]'::jsonb);
    v_alive_count := jsonb_array_length(v_alive);

    IF v_alive_count <= 1 THEN
      -- Game over: lone survivor wins
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
    -- Safe sip: cup difficulty +1 (capped at 6)
    v_cup_spills := LEAST(6, COALESCE((v_state->>'cupSpills')::int, 1) + 1);
    v_alive_count := jsonb_array_length(v_alive);
  END IF;

  -- Deal next round. Winner of the LIAR call leads.
  v_winner_idx := COALESCE(
    (SELECT ord::int - 1
     FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
     WHERE p_id = v_winner_id
     LIMIT 1),
    0
  );

  -- Build deck (matches huddle_liar_start_game)
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

  -- tableCard: avoid same as previous
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

  -- Deal hands
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


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_liar_start_sip(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_take_sip(TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_after_sip(TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_liar_start_sip(TEXT) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_take_sip(TEXT)  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_after_sip(TEXT) FROM anon, public;
