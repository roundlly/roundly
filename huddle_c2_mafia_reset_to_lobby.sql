-- ============================================================================
-- huddle_c2_mafia_reset_to_lobby.sql
-- ----------------------------------------------------------------------------
-- Narrator-callable RPC that resets the room back to its lobby state so the
-- same group can play another round without leaving + re-joining.
--
-- Used by Mafia Cards' "End game" button. After the narrator declares a
-- winner verbally and taps End game, this RPC:
--   • Resets phase to 'lobby', beatId to 'lobby', readyBy to {}
--   • Clears aliveIds / deadIds / vote tally / kill+save+detective targets
--   • Wipes mafia_roles for this room (next start_game will re-deal)
--   • PRESERVES: claimedBy, narratorUid, hostId — same group, same narrator
--   • Bumps revision so all connected phones realtime-sync back to the lobby
--
-- SECURITY: only the room's narrator can call this. Players can't reset.
--
-- Apply order: AFTER huddle_c2_mafia_rules_gate.sql, set_ready.sql, and
-- detective_return.sql. Standalone — does not modify any existing function.
-- ============================================================================

DROP FUNCTION IF EXISTS public.huddle_mafia_reset_to_lobby(TEXT);

CREATE OR REPLACE FUNCTION public.huddle_mafia_reset_to_lobby(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    TEXT;
  v_state  JSONB;
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

  -- Only the narrator may end the game. Helper raises 42501 if not narrator.
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  -- Wipe per-game role assignments. Next start_game re-deals from scratch.
  DELETE FROM public.mafia_roles WHERE code = p_code;

  -- Reset all transient game state. Keep the identity of who's in the
  -- room (claimedBy + narratorUid + hostId) so the group can immediately
  -- start a new game without re-claiming seats.
  v_state := jsonb_set(v_state, '{phase}',           '"lobby"'::jsonb);
  v_state := jsonb_set(v_state, '{beatId}',          '"lobby"'::jsonb);
  v_state := jsonb_set(v_state, '{round}',           '0'::jsonb);
  v_state := jsonb_set(v_state, '{aliveIds}',        '[]'::jsonb);
  v_state := jsonb_set(v_state, '{deadIds}',         '[]'::jsonb);
  v_state := jsonb_set(v_state, '{killTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{saveTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{detectiveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{voteTally}',       '{}'::jsonb);
  v_state := jsonb_set(v_state, '{votedBy}',         '{}'::jsonb);
  v_state := jsonb_set(v_state, '{readyBy}',         '{}'::jsonb);
  v_state := jsonb_set(v_state, '{winner}',          'null'::jsonb);
  v_state := jsonb_set(v_state, '{roleReveal}',      '{}'::jsonb);
  v_state := jsonb_set(v_state, '{lastKilled}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{lastEliminated}',  'null'::jsonb);
  v_state := jsonb_set(v_state, '{tiedCandidates}',  '[]'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_reset_to_lobby(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_reset_to_lobby(TEXT) FROM anon, public;
