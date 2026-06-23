-- ============================================================================
-- Huddle / Roundlly — C2 Turn 4a (Hot Seat lobby + settings RPCs)
-- ============================================================================
--
-- Adds three Hot Seat-specific RPCs for lobby management:
--   • huddle_hot_reset_players   — host clears claimedBy to self only
--   • huddle_hot_set_setting     — host updates one of {category, rounds, order, mode}
--   • huddle_hot_apply_recommended — host resets all four settings to preset
--
-- Lobby actions (claim_seat, leave_seat, close_room) reuse Turn 1's
-- universal RPCs with p_table='hotseat_rooms'.
--
-- Run AFTER huddle_c2_rls.sql + huddle_c2_policy_fix.sql + policy_fix2.sql.
-- This file is CREATE OR REPLACE — safe to re-run.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_hot_reset_players
-- ----------------------------------------------------------------------------
-- Host-only. Clears claimedBy to only contain the caller. Used by the lobby
-- "Reset" button to kick all current claimants except the host.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_reset_players(p_code TEXT)
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

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;

  IF v_my_seat IS NULL THEN
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

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_set_setting
-- ----------------------------------------------------------------------------
-- Host-only. Updates one of the four lobby settings (category / rounds /
-- order / mode). Field name is allowlisted to prevent arbitrary state writes.
--
-- Values are passed as JSONB so we can accept strings (category/order/mode)
-- and numbers (rounds) through one signature. The RPC validates the value
-- type matches the field.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_set_setting(
  p_code  TEXT,
  p_field TEXT,
  p_value JSONB
)
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

  -- Allowlist the field name — prevents writing arbitrary state paths
  IF p_field NOT IN ('category', 'rounds', 'order', 'mode') THEN
    RAISE EXCEPTION 'invalid_field: %', p_field USING ERRCODE = '22023';
  END IF;

  -- Type-check the value
  IF p_field = 'rounds' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'rounds_must_be_number' USING ERRCODE = '22023';
    END IF;
    IF (p_value::text)::int < 1 OR (p_value::text)::int > 99 THEN
      RAISE EXCEPTION 'rounds_out_of_range' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF jsonb_typeof(p_value) <> 'string' THEN
      RAISE EXCEPTION 'value_must_be_string' USING ERRCODE = '22023';
    END IF;
  END IF;

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_state := jsonb_set(v_state, ARRAY[p_field], p_value);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_hot_apply_recommended
-- ----------------------------------------------------------------------------
-- Host-only. Resets the four lobby settings to the recommended preset
-- (mode='classic', category='mixed', rounds=1, order='rotating').
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_hot_apply_recommended(p_code TEXT)
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

  EXECUTE 'SELECT state FROM public.hotseat_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_state := v_state || jsonb_build_object(
    'mode',     'classic',
    'category', 'mixed',
    'rounds',   1,
    'order',    'rotating'
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.hotseat_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_hot_reset_players(TEXT)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_set_setting(TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_hot_apply_recommended(TEXT)     TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_hot_reset_players(TEXT)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_set_setting(TEXT, TEXT, JSONB) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_hot_apply_recommended(TEXT)    FROM anon, public;
