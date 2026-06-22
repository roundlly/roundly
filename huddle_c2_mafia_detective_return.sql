-- ============================================================================
-- huddle_c2_mafia_detective_return.sql
-- ----------------------------------------------------------------------------
-- Two changes to huddle_mafia_start_game, shipped together:
--
--   (A) Minimum player count lowered from 6 → 5.
--       The role-mix table gains a 5-player row. Player-count guard updated.
--
--   (B) Detective role REINSTATED.
--       The Detective was previously dropped from the role-mix table (the
--       owner found the original variant overpowered). After a freeform
--       night-action rewrite, the Detective is being added back as a
--       standard role: each night they point at a player; narrator gives a
--       real-life thumb signal based on the truth (no on-screen picker).
--       Role-mix table now allocates 1 Detective per game.
--
-- New role-mix table:
--   Players | Mafia | Doctor | Detective | Villager
--   --------+-------+--------+-----------+---------
--      5    |   1   |   1    |     1     |    2
--      6    |   1   |   1    |     1     |    3
--      7    |   2   |   1    |     1     |    3
--      8    |   2   |   1    |     1     |    4
--
-- Everything else (rules-gate landing state — phase='rules', beatId='rules-gate',
-- readyBy={}) is unchanged from huddle_c2_mafia_rules_gate.sql.
--
-- Apply AFTER huddle_c2_mafia_rules_gate.sql and huddle_c2_mafia_set_ready.sql.
-- ============================================================================

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
  -- Min lowered from 6 → 5. Max stays at 8 (only 8 seats exist in the lobby).
  IF v_player_count < 5 OR v_player_count > 8 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Role mix table — Detective REINSTATED, 5-player row added:
  --   5 → 1M / 1Doc / 1Det / 2V
  --   6 → 1M / 1Doc / 1Det / 3V
  --   7 → 2M / 1Doc / 1Det / 3V
  --   8 → 2M / 1Doc / 1Det / 4V
  IF v_player_count = 5 THEN
    v_mafia_count := 1;
    v_villager_count := 2;
  ELSIF v_player_count = 6 THEN
    v_mafia_count := 1;
    v_villager_count := 3;
  ELSIF v_player_count = 7 THEN
    v_mafia_count := 2;
    v_villager_count := 3;
  ELSE  -- 8
    v_mafia_count := 2;
    v_villager_count := 4;
  END IF;

  -- Build the role queue in fixed slot order: Mafia(s), Doctor, Detective,
  -- Villager(s). v_player_seats is already shuffled (ORDER BY random above),
  -- so pairing them in order produces a random role assignment.
  v_roles := ARRAY[]::TEXT[];
  FOR i IN 1..v_mafia_count LOOP
    v_roles := array_append(v_roles, 'mafia');
  END LOOP;
  v_roles := array_append(v_roles, 'doctor');
  v_roles := array_append(v_roles, 'detective');
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

  -- Pre-game RULES GATE (unchanged from huddle_c2_mafia_rules_gate.sql).
  -- Companion RPC huddle_mafia_set_ready flips the gate once everyone is ready.
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
