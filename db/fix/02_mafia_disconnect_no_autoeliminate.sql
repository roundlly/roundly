-- ============================================================================
-- fix/02 — Mafia: never auto-eliminate (or auto-end the game) on a disconnect
-- ----------------------------------------------------------------------------
-- Apply to the LIVE Supabase DB (SQL editor). Idempotent (CREATE OR REPLACE),
-- server-only, no app redeploy required.
--
-- Replaces huddle_mafia_handle_disconnect. The OLD mid-game behavior moved the
-- dropped player from aliveIds → deadIds and ran a win-check that could flip
-- the room to phase='end' (declaring a winner) and write roleReveal — so a
-- single phone going to sleep for 60s could END the game for everyone and leak
-- every role. In the live "Cards" mode the NARRATOR is the source of truth for
-- who is out (tracked on the narrator's own device), so the server must never
-- eliminate on a disconnect.
--
-- New behavior:
--   • Lobby  → free the seat (and clear narratorUid if they held it), exactly
--              as before, so a slot reopens for someone else.
--   • In-game → DO NOTHING (idempotent no-op). The narrator decides whether to
--              wait for the reconnect or mark the player out by hand. The
--              client also surfaces a presence-driven "away" badge.
--
-- Graceful degradation: the client (app-08 mafiaConfirmUserGone) already stops
-- calling this RPC mid-game, so the app is safe even before this is applied.
-- This file hardens the server so the destructive path is gone at the source.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_mafia_handle_disconnect(p_code text, p_player_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid          TEXT;
  v_state        JSONB;
  v_target_uid   TEXT;
  v_claimedBy    JSONB;
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

  v_target_uid := v_state->'claimedBy'->>p_player_id;
  IF v_target_uid IS NULL THEN
    -- Already gone. Idempotent.
    RETURN v_state;
  END IF;

  -- Authz: either the narrator OR the disconnecting player themselves.
  IF v_uid <> v_target_uid AND v_uid <> (v_state->>'narratorUid') THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF (v_state->>'phase') = 'lobby' THEN
    -- Lobby: free the seat so the slot reopens.
    v_claimedBy := v_state->'claimedBy' - p_player_id;
    v_state := jsonb_set(v_state, '{claimedBy}', v_claimedBy);
    -- If they were the narrator, clear narratorUid.
    IF v_target_uid = (v_state->>'narratorUid') THEN
      v_state := jsonb_set(v_state, '{narratorUid}', 'null'::jsonb);
    END IF;

    v_state := jsonb_set(
      v_state,
      '{revision}',
      to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
    );
    UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
    RETURN v_state;
  END IF;

  -- Mid-game: DO NOTHING. Never auto-eliminate or auto-end on a disconnect —
  -- the narrator is the source of truth and chooses to wait or mark the player
  -- out by hand. Idempotent no-op (state left untouched).
  RETURN v_state;
END;
$function$;
