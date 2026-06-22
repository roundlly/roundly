-- ============================================================================
-- huddle_c2_mafia_optional_roles_v2.sql
-- ----------------------------------------------------------------------------
-- Adds Child + Mafia Leader optional-role support to huddle_mafia_start_game,
-- and teaches huddle_mafia_get_my_role that mafia_leader is on the Mafia team.
--
-- BEFORE this migration:
--   huddle_mafia_start_game(p_code TEXT, p_include_detective BOOLEAN)
--   → only Detective was toggleable. Child + Mafia Leader were UI stubs that
--     saved to localStorage but never affected role assignment.
--
-- AFTER this migration:
--   huddle_mafia_start_game(p_code, p_include_detective, p_include_child,
--                           p_include_mafia_leader, p_variant)
--   When p_include_mafia_leader = TRUE, ONE of the Mafia slots becomes a
--   'mafia_leader' (the Godfather variant — narrator lies to the Detective
--   about them). When p_include_child = TRUE, ONE Villager slot becomes a
--   'child' (when the Child dies, they take one player with them — handled
--   verbally by the narrator, no server logic).
--
-- Role mix is computed slot-by-slot so totals always equal player_count:
--   base mafia + (-1 if leader on)
--     +  base villager + (-1 if child on) + (+1 if detective off)
--     +  doctor (always 1)
--     +  detective (1 if on)
--     +  mafia_leader (1 if on)
--     +  child (1 if on)
--
-- Detective gameplay is unchanged for Detective interaction with the Leader:
-- the SERVER stores the Leader as 'mafia_leader', and the narrator's cheat
-- sheet (client-side) shows the Leader with an "appears innocent" badge so
-- the narrator knows to give a thumbs-DOWN when the Detective investigates.
-- No new server-side detective logic — the existing role-reveal RPC is
-- read-only, and Cards mode is freeform anyway.
--
-- Teammates: huddle_mafia_get_my_role treated only role='mafia' as Mafia
-- team. With this migration, both 'mafia' and 'mafia_leader' see each other
-- as teammates (so the Leader knows their Mafia partners, and the Mafia
-- knows their Leader). Role string is returned as-stored — the client maps
-- 'mafia_leader' to its own copy / styling.
--
-- Apply order: AFTER huddle_c2_mafia_optional_roles.sql. Safe to apply
-- repeatedly (DROP IF EXISTS + CREATE OR REPLACE).
-- ============================================================================

-- The function signature is changing (adding params), so DROP every prior
-- signature first. CREATE OR REPLACE alone can't change a function's
-- signature. Covers every version this codebase has shipped:
--   (TEXT)              — mafia.sql / detective_return.sql / rules_gate.sql
--   (TEXT, BOOLEAN)     — optional_roles.sql
--   (TEXT, BOOLEAN, TEXT) — variant.sql (most recent before this)
DROP FUNCTION IF EXISTS public.huddle_mafia_start_game(TEXT);
DROP FUNCTION IF EXISTS public.huddle_mafia_start_game(TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.huddle_mafia_start_game(TEXT, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.huddle_mafia_start_game(
  p_code                 TEXT,
  p_include_detective    BOOLEAN DEFAULT TRUE,
  p_include_child        BOOLEAN DEFAULT FALSE,
  p_include_mafia_leader BOOLEAN DEFAULT FALSE,
  p_variant              TEXT    DEFAULT NULL
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
  v_include_child    BOOLEAN;
  v_include_leader   BOOLEAN;
  v_variant          TEXT;
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

  -- Mirror the variant validation from huddle_c2_mafia_variant.sql so the
  -- field on state ALWAYS gets set — classic callers (no p_variant) land on
  -- 'classic'; unknown values fall back rather than erroring.
  v_variant := COALESCE(p_variant, 'classic');
  IF v_variant NOT IN ('classic','cards') THEN
    v_variant := 'classic';
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
  IF v_player_count < 5 OR v_player_count > 8 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Base role mix.
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
  -- Always set the variant so every connected phone reads the same value
  -- via realtime. Matches huddle_c2_mafia_variant.sql behavior.
  v_state := jsonb_set(v_state, '{variant}', to_jsonb(v_variant));
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;
GRANT EXECUTE  ON FUNCTION public.huddle_mafia_start_game(TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT) FROM anon, public;


-- ============================================================================
-- huddle_mafia_get_my_role — treat mafia + mafia_leader as one team
-- ============================================================================
-- The Leader knows their Mafia partners, and Mafia knows their Leader. Both
-- see each other in their teammates list. Role string is returned as-stored
-- ('mafia' or 'mafia_leader') so the client can show distinct copy/styling.
CREATE OR REPLACE FUNCTION public.huddle_mafia_get_my_role(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_narrator_uid  TEXT;
  v_my_seat       TEXT;
  v_my_role       TEXT;
  v_teammates     JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT state INTO v_state FROM public.mafia_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;

  v_narrator_uid := v_state->>'narratorUid';
  IF v_narrator_uid = v_uid THEN
    RETURN jsonb_build_object('role', NULL);
  END IF;

  SELECT key INTO v_my_seat
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value = v_uid
  LIMIT 1;

  IF v_my_seat IS NULL THEN
    RETURN jsonb_build_object('role', NULL);
  END IF;

  SELECT role INTO v_my_role
  FROM public.mafia_roles
  WHERE code = p_code AND player_id = v_my_seat;

  IF v_my_role IS NULL THEN
    RETURN jsonb_build_object('role', NULL);
  END IF;

  -- Both Mafia and Mafia Leader see each other as teammates.
  IF v_my_role IN ('mafia', 'mafia_leader') THEN
    SELECT jsonb_agg(player_id) INTO v_teammates
    FROM public.mafia_roles
    WHERE code = p_code
      AND role IN ('mafia', 'mafia_leader')
      AND player_id <> v_my_seat;
    RETURN jsonb_build_object('role', v_my_role, 'teammates', COALESCE(v_teammates, '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('role', v_my_role);
END;
$$;
GRANT EXECUTE  ON FUNCTION public.huddle_mafia_get_my_role(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_get_my_role(TEXT) FROM anon, public;
