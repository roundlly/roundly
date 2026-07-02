-- ============================================================================
-- FIX — allow the new 'themePack' Hot Seat lobby setting through the allowlist
-- ----------------------------------------------------------------------------
-- WHY: Guess the Theme gained a "Theme pack" setting (2026-07-02) — the host
-- picks which pack of secret themes feeds the draw pool (Classic / Everyday /
-- Places / Funny / Food / Mixed). The value MUST live in synced room state:
-- in giver-goes-next flow the player who just escaped the seat (NOT the host)
-- draws the next theme on their phone, so their device needs the host's pick.
--
-- huddle_hot_set_setting hard-rejects field names outside its allowlist
-- ('category','rounds','order','mode'). This fix re-creates the function with
-- 'themePack' added. Everything else is byte-identical to the live function
-- (source: db/migrations/04_hotseat_rpcs.sql, generated from the live DB).
--
-- Pack VALUES are deliberately NOT validated here: packs are defined client-
-- side (LINK_PACKS in app-01) and are meant to be easy to add/remove without
-- SQL churn. An unknown value is harmless — the client falls back to the full
-- theme pool. The call is already host-only + string-type-checked.
--
-- CREATE OR REPLACE keeps the function's existing owner and GRANTs.
-- UNTIL THIS IS RUN: changing "Theme pack" in the lobby shows a couldn't-sync
-- toast and other phones keep drawing from the full (Mixed) pool.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_hot_set_setting(p_code text, p_field text, p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   TEXT;
  v_state JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Allowlist the field name — prevents writing arbitrary state paths
  IF p_field NOT IN ('category', 'rounds', 'order', 'mode', 'themePack') THEN
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
$function$;

-- Sanity check — the allowlist line should now contain themePack:
--   SELECT prosrc FROM pg_proc WHERE proname = 'huddle_hot_set_setting';
