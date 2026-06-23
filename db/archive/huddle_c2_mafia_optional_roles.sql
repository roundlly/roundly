-- ============================================================================
-- huddle_c2_mafia_optional_roles.sql
-- ----------------------------------------------------------------------------
-- Adds optional-role support to huddle_mafia_start_game.
--
-- BEFORE this migration:
--   huddle_mafia_start_game(p_code TEXT) — always deals 1 Detective.
--
-- AFTER this migration:
--   huddle_mafia_start_game(p_code TEXT, p_include_detective BOOLEAN DEFAULT TRUE)
--   When p_include_detective = FALSE, the Detective slot becomes an extra
--   Villager. Classic Mafia callers (which pass no second arg) keep the
--   default TRUE → Detective always dealt, unchanged behavior. Mafia Cards
--   passes the host's lobby toggle state — host can disable Detective for
--   a quicker / different game shape.
--
-- New role-mix table (with detective toggle):
--   Players | Mafia | Doctor | Detective | Villager (det on / off)
--   --------+-------+--------+-----------+----------------------
--      5    |   1   |   1    |     1/0   |    2 / 3
--      6    |   1   |   1    |     1/0   |    3 / 4
--      7    |   2   |   1    |     1/0   |    3 / 4
--      8    |   2   |   1    |     1/0   |    4 / 5
--
-- Everything else (rules-gate landing, role randomization, etc.) is byte-
-- identical to huddle_c2_mafia_detective_return.sql — only the role-queue
-- assembly changes.
--
-- Apply order: AFTER huddle_c2_mafia_rules_gate.sql, set_ready.sql,
-- detective_return.sql. This file replaces the start_game function from
-- detective_return.sql; safe to apply repeatedly (CREATE OR REPLACE).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_mafia_start_game(
  p_code              TEXT,
  p_include_detective BOOLEAN DEFAULT TRUE
)
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
  v_include_det      BOOLEAN;
  i                  INT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- COALESCE protects against an explicit NULL pass (treat as default TRUE).
  v_include_det := COALESCE(p_include_detective, TRUE);

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
  IF v_player_count < 5 OR v_player_count > 8 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Base role mix (with Detective on). When Detective is off below, the
  -- Detective slot becomes an extra Villager — keeps total slot count equal
  -- to player count.
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

  -- Detective slot → extra Villager when toggle is off.
  IF NOT v_include_det THEN
    v_villager_count := v_villager_count + 1;
  END IF;

  -- Build role queue: Mafia(s), Doctor, [Detective], Villager(s).
  v_roles := ARRAY[]::TEXT[];
  FOR i IN 1..v_mafia_count LOOP
    v_roles := array_append(v_roles, 'mafia');
  END LOOP;
  v_roles := array_append(v_roles, 'doctor');
  IF v_include_det THEN
    v_roles := array_append(v_roles, 'detective');
  END IF;
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

  -- Rules-gate landing (unchanged from detective_return.sql).
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
GRANT EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT, BOOLEAN) FROM anon, public;
