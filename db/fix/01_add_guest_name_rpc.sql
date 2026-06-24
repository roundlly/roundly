-- ============================================================================
-- fix/01 — Guest display names (no-account players)
-- ----------------------------------------------------------------------------
-- Apply to the LIVE Supabase DB (SQL editor). Additive + idempotent
-- (CREATE OR REPLACE), server-only, no redeploy of the app needed.
--
-- Adds huddle_set_guest_name(): lets a player store the display name they typed
-- on the login screen into the room's state under `guestNames`, keyed by their
-- OWN auth uid. Because the key is auth.uid(), a caller can only set their own
-- name — they cannot spoof another seat. The client (profileForClaim) reads
-- guestNames so the name shows on that player's seat for everyone in the room.
--
-- Room tables already carry an open `state jsonb`; `guestNames` is just a new
-- key inside it, so no table DDL changes are required. Existing rooms without
-- the key are handled by COALESCE below.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_set_guest_name(p_table text, p_code text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    TEXT;
  v_state  JSONB;
  v_names  JSONB;
  v_clean  TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM public.huddle_assert_room_table(p_table);

  -- Sanitize: drop control chars, trim, cap at 24 chars (matches the client).
  v_clean := btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', '', 'g'));
  v_clean := left(v_clean, 24);

  EXECUTE format('SELECT state FROM public.%I WHERE code = $1 FOR UPDATE', p_table)
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'closedByHost')::boolean IS TRUE THEN
    RAISE EXCEPTION 'room_closed' USING ERRCODE = '42501';
  END IF;

  v_names := COALESCE(v_state->'guestNames', '{}'::jsonb);

  IF v_clean = '' THEN
    -- Empty name clears any prior entry for this caller.
    v_names := v_names - v_uid;
  ELSE
    -- No duplicate names AMONG PLAYERS CURRENTLY IN THE ROOM. We only compare
    -- against names whose owner is presently seated (their uid is a value in
    -- claimedBy) — a guest who already LEFT leaves a leftover name entry that
    -- must NOT count, so that name frees up again. Keyed by auth.uid(), so
    -- re-setting your OWN same name is always fine.
    IF EXISTS (
      SELECT 1
      FROM jsonb_each_text(v_names) gn
      WHERE gn.key <> v_uid
        AND lower(gn.value) = lower(v_clean)
        AND gn.key IN (
          SELECT cb.value FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb)) cb
        )
    ) THEN
      RAISE EXCEPTION 'name_taken' USING ERRCODE = '42501';
    END IF;
    v_names := jsonb_set(v_names, ARRAY[v_uid], to_jsonb(v_clean), true);
  END IF;

  v_state := jsonb_set(v_state, '{guestNames}', v_names);

  -- Bump revision so other clients pick up the change via realtime.
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  EXECUTE format('UPDATE public.%I SET state = $1 WHERE code = $2', p_table)
    USING v_state, p_code;

  RETURN v_state;
END;
$function$;
