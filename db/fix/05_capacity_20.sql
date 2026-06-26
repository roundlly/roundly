-- ============================================================================
-- db/fix/05 — Capacity raised to 20 players (Mafia + Liar's Cup server side)
-- ----------------------------------------------------------------------------
-- Re-creates ONLY the four server functions whose player-count logic changed:
--   * huddle_mafia_start_game  - count guard widened 5-8 -> 5-20; the base role
--     mix is now a formula (mafia = floor((n-1)/3), villagers = n-mafia-2) that
--     reproduces the old 5-8 numbers exactly and extends to 20. MUST stay in
--     lockstep with the client mafiaRoleMixFor in app-08-mafia.js.
--   * huddle_liar_start_game / _after_sip / _handle_disconnect - deck multiplier
--     is now ceil(players / 4) (one 20-card unit per 4 players) so the deck
--     covers up to 20 players (100 cards) instead of capping at 40.
--
-- These four are disjoint from db/fix/02 (huddle_mafia_handle_disconnect) and
-- db/fix/03 (huddle_migrate_seat), so apply order does not matter.
-- Idempotent (CREATE OR REPLACE). Hot Seat & Chameleon need NO server change
-- (their seat count is client-side; min-player guards already allow up to 20).
-- ============================================================================

-- ---- public.huddle_mafia_start_game (from db\migrations\07_mafia_rpcs.sql) ----
CREATE OR REPLACE FUNCTION public.huddle_mafia_start_game(p_code text, p_include_detective boolean DEFAULT true, p_include_child boolean DEFAULT false, p_include_mafia_leader boolean DEFAULT false, p_variant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_include_det      BOOLEAN;
  v_include_child    BOOLEAN;
  v_include_leader   BOOLEAN;
  i                  INT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- COALESCE protects against explicit NULL pass (treat as default).
  v_include_det    := COALESCE(p_include_detective,    TRUE);
  v_include_child  := COALESCE(p_include_child,        FALSE);
  v_include_leader := COALESCE(p_include_mafia_leader, FALSE);

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
  IF v_player_count < 5 OR v_player_count > 20 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Base role mix — scales 5..20: ~1 Mafia per ~3 players (floor((n-1)/3)), with
  -- 1 Doctor and (when toggled on) 1 Detective; the rest Villagers. Reproduces the
  -- original 5-8 table exactly (5:1/2 6:1/3 7:2/3 8:2/4 ... 20:6/12, mafia/villager).
  -- MUST match the client mafiaRoleMixFor base mix in app-08-mafia.js or the
  -- role_count_mismatch guard below fires.
  v_mafia_count    := (v_player_count - 1) / 3;            -- integer division = floor
  v_villager_count := v_player_count - v_mafia_count - 2;  -- minus Doctor + Detective

  -- Detective slot → extra Villager when toggle is off.
  IF NOT v_include_det THEN
    v_villager_count := v_villager_count + 1;
  END IF;

  -- Mafia Leader steals ONE Mafia slot (kept on the Mafia team — same evil
  -- count, just one of them is the Godfather). Guard against under-counting:
  -- min mafia after the steal is 0, which is fine — the Leader IS evil.
  IF v_include_leader AND v_mafia_count > 0 THEN
    v_mafia_count := v_mafia_count - 1;
  END IF;

  -- Child steals ONE Villager slot. Guard against under-counting: if for some
  -- reason villager_count is already 0 (only possible with weird future
  -- toggle combos), drop the child rather than going negative.
  IF v_include_child AND v_villager_count > 0 THEN
    v_villager_count := v_villager_count - 1;
  END IF;

  -- Build role queue: Mafia(s), Mafia Leader?, Doctor, Detective?, Child?,
  -- Villager(s). Order doesn't matter for assignment (seats are shuffled
  -- above) but keeping a stable shape makes the queue easy to reason about.
  v_roles := ARRAY[]::TEXT[];
  FOR i IN 1..v_mafia_count LOOP
    v_roles := array_append(v_roles, 'mafia');
  END LOOP;
  IF v_include_leader AND
     -- Only add the Leader slot if there WAS a Mafia slot to steal.
     -- (Defends against a future role-mix table where mafia_count starts at 0.)
     v_player_count >= 5
  THEN
    v_roles := array_append(v_roles, 'mafia_leader');
  END IF;
  v_roles := array_append(v_roles, 'doctor');
  IF v_include_det THEN
    v_roles := array_append(v_roles, 'detective');
  END IF;
  IF v_include_child THEN
    v_roles := array_append(v_roles, 'child');
  END IF;
  FOR i IN 1..v_villager_count LOOP
    v_roles := array_append(v_roles, 'villager');
  END LOOP;

  IF array_length(v_player_seats, 1) <> array_length(v_roles, 1) THEN
    RAISE EXCEPTION 'role_count_mismatch: seats=% roles=%',
      array_length(v_player_seats, 1), array_length(v_roles, 1)
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.mafia_roles WHERE code = p_code;

  FOR i IN 1..array_length(v_player_seats, 1) LOOP
    INSERT INTO public.mafia_roles(code, player_id, role)
    VALUES (p_code, v_player_seats[i], v_roles[i]);
  END LOOP;

  SELECT jsonb_agg(s) INTO v_alive_arr FROM unnest(v_player_seats) AS s;

  -- Rules-gate landing (unchanged from optional_roles.sql).
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
  IF p_variant IS NOT NULL THEN
    v_state := jsonb_set(v_state, '{variant}', to_jsonb(p_variant));
  END IF;
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$function$;

-- ---- public.huddle_liar_start_game (from db\migrations\06_liar_rpcs.sql) ----
CREATE OR REPLACE FUNCTION public.huddle_liar_start_game(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Deck multiplier (matches liarBuildDeck): ceil(players / 4) → one 20-card unit
  -- per (up to) 4 players. 2-4→1, 5-8→2, 9-12→3, 13-16→4, 17-20→5.
  v_multiplier := GREATEST(1, CEIL(v_alive_count / 4.0)::int);

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
$function$;

-- ---- public.huddle_liar_after_sip (from db\migrations\06_liar_rpcs.sql) ----
CREATE OR REPLACE FUNCTION public.huddle_liar_after_sip(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  v_multiplier := GREATEST(1, CEIL(v_alive_count / 4.0)::int);  -- ceil(players/4); see start_game
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
$function$;

-- ---- public.huddle_liar_handle_disconnect (from db\migrations\06_liar_rpcs.sql) ----
CREATE OR REPLACE FUNCTION public.huddle_liar_handle_disconnect(p_code text, p_gone_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

      v_multiplier := GREATEST(1, CEIL(v_new_alive_count / 4.0)::int);  -- ceil(players/4)
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
$function$;

