-- ============================================================================
-- Huddle / Roundlly — C2 Turn 3c (Liar's Cup lockdown)
-- ============================================================================
--
-- Final Liar's Cup migration step. Adds the two remaining direct-upsert
-- mutation paths as RPCs (disconnect cleanup, reset-players), then tightens
-- the liar_rooms UPDATE policy to DENY all direct UPDATE — forcing every
-- mutation through a SECURITY DEFINER RPC.
--
-- INSERT and SELECT policies are left unchanged (open SELECT, claimant-only
-- INSERT — room creation continues to work through direct INSERT).
--
-- Run AFTER huddle_c2_rls.sql, huddle_c2_liar.sql, huddle_c2_liar_ingame.sql,
-- and huddle_c2_liar_cup.sql have succeeded.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_liar_reset_players
-- ----------------------------------------------------------------------------
-- Host-only. Clears claimedBy to only contain the caller. Used by the lobby
-- "Reset" button to kick all current claimants except the host so the host
-- can start fresh.
-- Mirrors liarResetPlayers in client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_reset_players(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_my_seat   TEXT;
  v_new_claim JSONB;
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

  -- Find caller's seat
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;

  IF v_my_seat IS NULL THEN
    -- Host has no seat (shouldn't happen, but guard): clear claimedBy entirely
    v_new_claim := '{}'::jsonb;
  ELSE
    v_new_claim := jsonb_build_object(v_my_seat, v_uid);
  END IF;

  v_state := jsonb_set(v_state, '{claimedBy}', v_new_claim);
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
-- huddle_liar_handle_disconnect
-- ----------------------------------------------------------------------------
-- Caller (any claimant — client-side gate picks the lowest-connected peer)
-- requests cleanup of a gone player's session. Server identifies the seat
-- from the session id and applies cleanup based on current phase:
--
--   • lobby / result / undefined  → remove seat, transfer host if needed
--   • play  + gone in alivePlayers → remove seat & alive entry, normalize
--                                    currentPlayerIdx; if 1 survivor remains
--                                    set winnerId + phase='result'
--   • reveal / cup + gone is loser → force spill + run after_sip-equivalent
--   • any other case               → remove seat (best-effort)
--
-- KNOWN LIMITATION: server can't verify the caller's "lowest-connected"
-- claim. A malicious claimant could call this with a victim's session id to
-- evict them. Mitigation requires server-side presence (future work). For
-- now, this is no worse than today's permissive UPDATE policy (where the
-- same attack is possible via direct upsert).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_handle_disconnect(
  p_code             TEXT,
  p_gone_session_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_phase            TEXT;
  v_gone_seat        TEXT;
  v_pending_loser    TEXT;
  v_alive            JSONB;
  v_alive_idx        INT;
  v_current_idx      INT;
  v_new_alive        JSONB;
  v_new_alive_count  INT;
  v_n                INT;
  v_new_current      INT;
  v_chambers         JSONB;
  v_winner_id        TEXT;
  v_wins             JSONB;
  v_remaining_claim  JSONB;
  v_lowest_seat_uid  TEXT;
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

  v_phase := v_state->>'phase';

  -- Find the gone player's seat
  SELECT key INTO v_gone_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = p_gone_session_id
  LIMIT 1;

  IF v_gone_seat IS NULL THEN
    -- Already cleaned up; idempotent
    RETURN v_state;
  END IF;

  -- Always remove the gone seat from claimedBy
  v_remaining_claim := (v_state->'claimedBy') - v_gone_seat;
  v_state := jsonb_set(v_state, '{claimedBy}', v_remaining_claim);

  -- Transfer host if the gone player was host (lexicographic seat order,
  -- matches the client's existing rule).
  IF (v_state->>'hostId') = p_gone_session_id THEN
    SELECT value INTO v_lowest_seat_uid
    FROM jsonb_each_text(v_remaining_claim)
    ORDER BY key
    LIMIT 1;
    IF v_lowest_seat_uid IS NOT NULL THEN
      v_state := jsonb_set(v_state, '{hostId}', to_jsonb(v_lowest_seat_uid));
    ELSE
      v_state := jsonb_set(v_state, '{hostId}', 'null'::jsonb);
    END IF;
  END IF;

  -- Lobby/result/undefined: seat removal is all we needed
  IF v_phase IS NULL OR v_phase = 'lobby' OR v_phase = 'result' THEN
    v_state := jsonb_set(
      v_state,
      '{revision}',
      to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
    );
    UPDATE public.liar_rooms SET state = v_state WHERE code = p_code;
    RETURN v_state;
  END IF;

  -- === CASE A: gone player is the pendingLoser in reveal/cup ===
  v_pending_loser := v_state->>'pendingLoserId';
  IF (v_phase = 'reveal' OR v_phase = 'cup') AND v_pending_loser = v_gone_seat THEN
    -- Force-resolve as if they spilled, then run after-sip inline.
    v_chambers := COALESCE(v_state->'sipChamberIsSpill', '[]'::jsonb);
    IF jsonb_array_length(v_chambers) <> 6 THEN
      v_chambers := '[true,false,false,false,false,false]'::jsonb;
    END IF;
    -- Pick first spill chamber, or chamber 0 if no spill exists (force one).
    SELECT COALESCE(MIN(ord)::int - 1, 0)
    INTO v_alive_idx
    FROM jsonb_array_elements(v_chambers) WITH ORDINALITY AS t(elem, ord)
    WHERE elem::text::boolean = true;
    IF (v_chambers->v_alive_idx)::text::boolean IS NOT TRUE THEN
      v_chambers := jsonb_set(v_chambers, ARRAY['0'], 'true'::jsonb);
      v_alive_idx := 0;
    END IF;
    v_state := v_state || jsonb_build_object(
      'phase',             'cup',
      'sipChamberIsSpill', v_chambers,
      'sipChamberIdx',     v_alive_idx,
      'sipOutcome',        'spilled',
      'sipTaken',          true
    );

    -- Inline after_sip's "spilled" branch: eliminate loser, check win, or
    -- deal next round. (Copy of huddle_liar_after_sip logic, but the gone
    -- player IS the loser so they're auto-eliminated.)
    v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
    SELECT jsonb_agg(p_id ORDER BY ord)
    INTO v_new_alive
    FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
    WHERE p_id <> v_gone_seat;
    v_new_alive := COALESCE(v_new_alive, '[]'::jsonb);
    v_new_alive_count := jsonb_array_length(v_new_alive);

    IF v_new_alive_count <= 1 THEN
      v_winner_id := v_new_alive->>0;
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
        'alivePlayers', v_new_alive,
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

    -- Survivors > 1: dealing next round on disconnect would require full
    -- deck-deal logic. To keep this RPC bounded, set phase='tablecard'
    -- WITHOUT redealing — the next legitimate action (e.g. host) will deal
    -- via huddle_liar_after_sip's normal flow when sipTaken stays true and
    -- caller has loser claim. Simpler interim: set state ready for a manual
    -- re-deal trigger.
    --
    -- Cleaner: just remove the loser, keep phase='cup'+sipTaken so that
    -- ANY remaining claimant's device (no longer the loser, who's gone)
    -- can call huddle_liar_after_sip to advance. But after_sip requires
    -- the caller to BE the loser. Workaround: change pendingLoserId to a
    -- different player so cleanup completes. Risky.
    --
    -- Decision: inline the same deck-deal logic from huddle_liar_after_sip.
    DECLARE
      v_accuser_idx INT;
      v_accuser_id  TEXT;
      v_accused_id  TEXT;
      v_winner_idx  INT;
      v_multiplier  INT;
      v_hand_size   INT := 5;
      v_table_card  TEXT;
      v_prev_table  TEXT;
      v_deck        JSONB;
      v_hands       JSONB;
      v_player_hand JSONB;
      v_player_id   TEXT;
      v_idx         INT;
      v_round_count INT;
      v_pending_cause TEXT;
    BEGIN
      v_pending_cause := v_state->>'pendingLoserCause';
      v_accuser_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
      v_accuser_id := v_alive->>v_accuser_idx;
      v_accused_id := v_state->'lastPlay'->>'byPlayerId';
      v_winner_id := CASE
        WHEN v_pending_cause = 'lied' THEN v_accuser_id
        ELSE v_accused_id
      END;
      v_winner_idx := COALESCE(
        (SELECT ord::int - 1
         FROM jsonb_array_elements_text(v_new_alive) WITH ORDINALITY AS t(p_id, ord)
         WHERE p_id = v_winner_id
         LIMIT 1),
        0
      );

      v_multiplier := CASE WHEN v_new_alive_count > 4 THEN 2 ELSE 1 END;
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
      FOR v_idx IN 0 .. v_new_alive_count - 1 LOOP
        v_player_id := v_new_alive->>v_idx;
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
        'alivePlayers',       v_new_alive,
        'cupSpills',          1,
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
  END IF;

  -- === CASE B: gone player is in alivePlayers during 'play' phase ===
  IF v_phase = 'play' THEN
    v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
    SELECT (ord::int - 1) INTO v_alive_idx
    FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
    WHERE p_id = v_gone_seat
    LIMIT 1;

    IF v_alive_idx IS NULL THEN
      -- Already eliminated; just persist the seat clear
      v_state := jsonb_set(
        v_state,
        '{revision}',
        to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
      );
      UPDATE public.liar_rooms SET state = v_state WHERE code = p_code;
      RETURN v_state;
    END IF;

    SELECT jsonb_agg(p_id ORDER BY ord)
    INTO v_new_alive
    FROM jsonb_array_elements_text(v_alive) WITH ORDINALITY AS t(p_id, ord)
    WHERE p_id <> v_gone_seat;
    v_new_alive := COALESCE(v_new_alive, '[]'::jsonb);
    v_new_alive_count := jsonb_array_length(v_new_alive);

    IF v_new_alive_count <= 1 THEN
      v_winner_id := v_new_alive->>0;
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
        'alivePlayers', v_new_alive,
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

    -- Normalize currentPlayerIdx (mirrors client logic)
    v_current_idx := COALESCE((v_state->>'currentPlayerIdx')::int, 0);
    v_n := v_new_alive_count;
    IF v_alive_idx < v_current_idx THEN
      v_new_current := GREATEST(0, v_current_idx - 1) % v_n;
    ELSE
      v_new_current := v_current_idx % v_n;
    END IF;

    v_state := v_state || jsonb_build_object(
      'alivePlayers',     v_new_alive,
      'currentPlayerIdx', v_new_current
    );
    v_state := jsonb_set(
      v_state,
      '{revision}',
      to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
    );
    UPDATE public.liar_rooms SET state = v_state WHERE code = p_code;
    RETURN v_state;
  END IF;

  -- Fall-through: any other phase (tablecard etc.) — just persist seat clear
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
-- huddle_liar_finish_solo
-- ----------------------------------------------------------------------------
-- Caller declares themselves the sole survivor (used by client-side polling
-- fallback when presence-disconnect cleanup didn't fire — e.g. a tab crashed
-- without sending a presence 'leave' event).
--
-- Server-side validation: caller must be a claimant and must be in
-- alivePlayers. Server does NOT verify "I'm the only present claimant"
-- (no presence info in SQL) — trust the caller's gate, same as the
-- disconnect RPC. Same caveat: a malicious claimant could falsely declare
-- themselves the winner this way, but the resulting state is no worse than
-- a permissive-UPDATE attack.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_liar_finish_solo(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_my_seat       TEXT;
  v_alive         JSONB;
  v_wins          JSONB;
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

  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_seat IS NULL THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;

  v_alive := COALESCE(v_state->'alivePlayers', '[]'::jsonb);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_alive) AS a(p_id)
    WHERE p_id = v_my_seat
  ) THEN
    RAISE EXCEPTION 'not_alive' USING ERRCODE = '42501';
  END IF;

  -- Already in result phase? Idempotent.
  IF (v_state->>'phase') = 'result' THEN
    RETURN v_state;
  END IF;

  v_wins := COALESCE(v_state->'wins', '{}'::jsonb);
  v_wins := jsonb_set(
    v_wins,
    ARRAY[v_my_seat],
    to_jsonb(COALESCE((v_wins->>v_my_seat)::int, 0) + 1),
    true
  );

  v_state := v_state || jsonb_build_object(
    'alivePlayers', jsonb_build_array(v_my_seat),
    'wins',         v_wins,
    'winnerId',     v_my_seat,
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
END;
$$;


-- ============================================================================
-- Tighten liar_rooms UPDATE policy: DENY all direct UPDATE
-- ============================================================================
-- After this point, the only writes to liar_rooms.state come from
-- SECURITY DEFINER RPCs (which bypass RLS). A malicious claimant calling
-- the REST API directly with .from('liar_rooms').update(...) is rejected
-- with "permission denied for table liar_rooms".
--
-- INSERT policy is unchanged: room creation continues to work via direct
-- INSERT (auth.uid() must be in NEW.state->'claimedBy').
-- SELECT policy is unchanged: open read access for the join flow.
-- DELETE policy was never granted: still implicitly denied.

DROP POLICY IF EXISTS "Claimant can update" ON public.liar_rooms;

-- No replacement policy = no client UPDATE allowed. RPCs use SECURITY DEFINER
-- and bypass RLS so legitimate game actions continue to work.


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_liar_reset_players(TEXT)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_handle_disconnect(TEXT, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_liar_finish_solo(TEXT)               TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_liar_reset_players(TEXT)            FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_handle_disconnect(TEXT, TEXT)  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_liar_finish_solo(TEXT)              FROM anon, public;
