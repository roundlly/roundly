-- ============================================================================
-- Huddle / Roundlly — C2 Turn 6 (Mafia full schema + RPC migration + lockdown)
-- ============================================================================
--
-- Introduces the Mafia game (Game #4). Unlike Hot Seat / Chameleon / Liar's
-- Cup — which were migrated to RPCs over multiple turns — Mafia ships FULLY
-- LOCKED from day one: direct UPDATE on mafia_rooms is denied at the DB layer,
-- and every state mutation goes through a SECURITY DEFINER RPC.
--
-- WHY MAFIA NEEDS STRICTER PRIVACY THAN THE OTHER GAMES
-- -----------------------------------------------------
-- Liar's Cup has a documented gap: server returns all hands in state.JSON to
-- every client; privacy is enforced only at the render layer. For Liar's that's
-- a real but acceptable risk (cards reveal at end of round anyway).
--
-- For Mafia, role secrecy IS the game. If state.roles is in the public JSONB,
-- anyone with the room code can `SELECT state FROM mafia_rooms` from a REST
-- client and learn every role in 5 seconds. Game is broken.
--
-- Solution: roles live in a SEPARATE table `mafia_roles` that:
--   1. Has RLS denying ALL access except SECURITY DEFINER functions.
--   2. Is NOT in the supabase_realtime publication (clients can't subscribe).
--   3. Is queried only by RPCs that gate on caller identity:
--        - huddle_mafia_get_my_role          → returns caller's own role only
--        - huddle_mafia_get_narrator_state   → returns full role map, gated to narratorUid
--        - huddle_mafia_detective_query      → returns boolean, gated to verified Detective
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Extends `huddle_assert_room_table` to allowlist `mafia_rooms`.
--   2. Creates `mafia_rooms` table (public synced state — NO roles in it).
--   3. Creates `mafia_roles` table (private, never synced).
--   4. Enables RLS on both. Adds policies — mafia_rooms ALREADY LOCKED (UPDATE
--      denied from day one, no intermediate "claimant can update" turn).
--   5. Adds mafia_rooms to supabase_realtime publication.
--   6. Defines 14 Mafia-specific RPCs.
--   7. Grants EXECUTE on RPCs to authenticated role.
--
-- HOW TO RUN
-- ----------
--   Supabase Dashboard → SQL Editor → New query → paste this entire file →
--   Run. Read each comment block — some statements warn before destructive
--   action.
--
-- PRE-REQUISITES
-- --------------
--   • huddle_c2_rls.sql has been applied (universal RPCs exist).
--   • huddle_c2_policy_fix.sql + huddle_c2_policy_fix2.sql have been applied
--     (old open policies removed).
--   • Anonymous sign-in is enabled.
--
-- ROLLBACK
-- --------
--   To undo: DROP TABLE mafia_rooms CASCADE; DROP TABLE mafia_roles CASCADE;
--   plus DROP FUNCTION ... for each of the 14 Mafia RPCs. No companion file
--   provided — copy the function names from this file's headers.
-- ============================================================================


-- ============================================================================
-- 1. Extend huddle_assert_room_table to allowlist mafia_rooms
-- ============================================================================
-- The universal RPCs (huddle_create_room, huddle_claim_seat, huddle_leave_seat,
-- huddle_close_room) all call this assertion. We CREATE OR REPLACE to add
-- mafia_rooms to the allowlist without breaking existing games.

CREATE OR REPLACE FUNCTION public.huddle_assert_room_table(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  IF p_table NOT IN ('hotseat_rooms', 'chameleon_rooms', 'liar_rooms', 'mafia_rooms') THEN
    RAISE EXCEPTION 'invalid_table: %', p_table USING ERRCODE = '22023';
  END IF;
END;
$$;


-- ============================================================================
-- 2. Create mafia_rooms table (public synced state — NO roles here)
-- ============================================================================
-- State shape (documented for future maintainers):
--   {
--     "claimedBy":    { playerSeatId: uid, ... },   // includes narrator's seat
--     "narratorUid":  uid | null,                   // separate from playerSeat assignment
--     "hostId":       uid,
--     "phase":        "lobby" | "night-mafia" | "night-detective" |
--                     "night-doctor" | "night-resolve" | "day-reveal" |
--                     "day-discuss" | "vote" | "vote-tie" | "day-eliminate" | "end",
--     "round":        int,                          // 1-indexed
--     "aliveIds":     [playerSeatId, ...],          // alive players (excludes narrator)
--     "deadIds":      [playerSeatId, ...],
--     "killTarget":   playerSeatId | null,          // mafia's pick (cleared on resolve)
--     "saveTarget":   playerSeatId | null,          // doctor's pick (cleared on resolve)
--     "detectiveTarget": playerSeatId | null,       // detective's last query (cleared on resolve)
--     "voteTally":    { playerSeatId: count, ... },
--     "votedBy":      { uid: targetPlayerSeatId, ... },  // cleared on eliminate
--     "beatId":       string,                       // current narrator script beat
--     "winner":       "town" | "mafia" | null,
--     "roleReveal":   { playerSeatId: role, ... },  // populated at end of game only
--     "closedByHost": boolean,
--     "revision":     int                           // bumped on every change
--   }
-- NO role information in state.

CREATE TABLE IF NOT EXISTS public.mafia_rooms (
  code        TEXT PRIMARY KEY,
  state       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);


-- ============================================================================
-- 3. Create mafia_roles table (PRIVATE — never synced, never SELECTable from client)
-- ============================================================================
-- One row per (code, playerSeatId). Role is one of:
--   'mafia' | 'detective' | 'doctor' | 'villager'
-- Narrator does NOT get a row — they have no role.

CREATE TABLE IF NOT EXISTS public.mafia_roles (
  code        TEXT NOT NULL,
  player_id   TEXT NOT NULL,    -- the playerSeatId (e.g. 'p1', 'p2', ...)
  role        TEXT NOT NULL CHECK (role IN ('mafia', 'detective', 'doctor', 'villager')),
  PRIMARY KEY (code, player_id),
  FOREIGN KEY (code) REFERENCES public.mafia_rooms(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mafia_roles_code ON public.mafia_roles(code);


-- ============================================================================
-- 4. Enable RLS on both tables
-- ============================================================================

ALTER TABLE public.mafia_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mafia_roles ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 5. Drop any old open policies (defensive — table is new, but safe to run)
-- ============================================================================

DROP POLICY IF EXISTS "Public read"   ON public.mafia_rooms;
DROP POLICY IF EXISTS "Public insert" ON public.mafia_rooms;
DROP POLICY IF EXISTS "Public update" ON public.mafia_rooms;
DROP POLICY IF EXISTS "Public delete" ON public.mafia_rooms;
DROP POLICY IF EXISTS "mafia_rooms_select_all" ON public.mafia_rooms;
DROP POLICY IF EXISTS "mafia_rooms_insert_all" ON public.mafia_rooms;
DROP POLICY IF EXISTS "mafia_rooms_update_all" ON public.mafia_rooms;
DROP POLICY IF EXISTS "mafia_rooms_delete_all" ON public.mafia_rooms;


-- ============================================================================
-- 6. Policies on mafia_rooms — LOCKED FROM DAY ONE
-- ============================================================================
-- Drop first (idempotent re-run safety), then re-create.
DROP POLICY IF EXISTS "Anyone can read"      ON public.mafia_rooms;
DROP POLICY IF EXISTS "Claimant can insert"  ON public.mafia_rooms;

-- SELECT: open. Anyone with the code can read the room state. NO roles are
-- in state, so this is safe.
CREATE POLICY "Anyone can read"
  ON public.mafia_rooms FOR SELECT
  USING (true);

-- INSERT: caller must be in claimedBy as a claimant. Reuses the existing
-- huddle_is_claimant helper from huddle_c2_rls.sql.
CREATE POLICY "Claimant can insert"
  ON public.mafia_rooms FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.huddle_is_claimant(state->'claimedBy', auth.uid()::text)
  );

-- UPDATE: NO POLICY. With RLS enabled and no UPDATE policy, all UPDATEs from
-- client connections are denied. Only SECURITY DEFINER RPCs can mutate state.

-- DELETE: NO POLICY. Implicitly denied. Rooms are closed via closedByHost
-- flag, not deleted.


-- ============================================================================
-- 7. Policies on mafia_roles — ALL ACCESS DENIED from client connections
-- ============================================================================
-- No SELECT/INSERT/UPDATE/DELETE policies → all denied for authenticated/anon
-- roles. Only SECURITY DEFINER RPCs (running as service role) can read/write.

-- (Intentionally no policies. RLS is enabled in step 4, denying everything.)


-- ============================================================================
-- 8. Add mafia_rooms to supabase_realtime publication
-- ============================================================================
-- mafia_roles is INTENTIONALLY excluded — clients should never subscribe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'mafia_rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mafia_rooms;
  END IF;
END $$;


-- ============================================================================
-- 9. Helper: assert caller is the narrator
-- ============================================================================

CREATE OR REPLACE FUNCTION public.huddle_mafia_assert_narrator(p_state JSONB, p_uid TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  IF (p_state->>'narratorUid') IS DISTINCT FROM p_uid THEN
    RAISE EXCEPTION 'not_narrator' USING ERRCODE = '42501';
  END IF;
END;
$$;


-- ============================================================================
-- 10. (Reserved — no additional helpers needed beyond huddle_mafia_assert_narrator
--      and the universal huddle_is_claimant from huddle_c2_rls.sql.)
-- ============================================================================


-- ============================================================================
-- 11. huddle_mafia_set_narrator — host-only, designates a claimant as narrator
-- ============================================================================
-- The narrator must already be a claimant in the room. Host taps a player
-- tile in the narrator picker → this RPC sets narratorUid to that player's
-- uid. The narrator REMAINS in claimedBy (still a claimant for RLS purposes)
-- but won't get a role assigned in start_game.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_set_narrator(
  p_code           TEXT,
  p_narrator_seat  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          TEXT;
  v_state        JSONB;
  v_target_uid   TEXT;
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
    RAISE EXCEPTION 'narrator_locked_after_start' USING ERRCODE = '42501';
  END IF;

  -- Validate target is a claimant.
  v_target_uid := v_state->'claimedBy'->>p_narrator_seat;
  IF v_target_uid IS NULL THEN
    RAISE EXCEPTION 'narrator_seat_not_claimed: %', p_narrator_seat USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{narratorUid}', to_jsonb(v_target_uid));
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 12. huddle_mafia_start_game — host-only, server picks roles
-- ============================================================================
-- Validates: caller is host, narrator is set, player count 6-8 (claimants
-- minus narrator). Picks roles server-side using a random shuffle. Stores
-- roles in mafia_roles (never in state JSONB). Advances phase to night-mafia
-- with round=1 in OPENING mode (Day 0 = meet but no kill).
-- ----------------------------------------------------------------------------
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

  -- Build player_seats = claimedBy keys whose value <> narratorUid.
  SELECT array_agg(key ORDER BY random()) INTO v_player_seats
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value <> v_narrator_uid;

  v_player_count := COALESCE(array_length(v_player_seats, 1), 0);
  IF v_player_count < 6 OR v_player_count > 8 THEN
    RAISE EXCEPTION 'invalid_player_count: %', v_player_count USING ERRCODE = '42501';
  END IF;

  -- Role mix table (Detective removed — was overpowered):
  --   6 → 1M / 1Doc / 4V
  --   7 → 2M / 1Doc / 4V
  --   8 → 2M / 1Doc / 5V
  IF v_player_count = 6 THEN
    v_mafia_count := 1;
    v_villager_count := 4;
  ELSIF v_player_count = 7 THEN
    v_mafia_count := 2;
    v_villager_count := 4;
  ELSE  -- 8
    v_mafia_count := 2;
    v_villager_count := 5;
  END IF;

  -- Build roles array.
  v_roles := ARRAY[]::TEXT[];
  FOR i IN 1..v_mafia_count LOOP
    v_roles := array_append(v_roles, 'mafia');
  END LOOP;
  v_roles := array_append(v_roles, 'doctor');
  FOR i IN 1..v_villager_count LOOP
    v_roles := array_append(v_roles, 'villager');
  END LOOP;

  -- v_player_seats is already shuffled (ORDER BY random() above). Just pair
  -- it with v_roles in order — the shuffle randomizes the assignment.
  -- Sanity check: arrays must match in length.
  IF array_length(v_player_seats, 1) <> array_length(v_roles, 1) THEN
    RAISE EXCEPTION 'role_count_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Clear any previous roles for this room (defensive — shouldn't happen).
  DELETE FROM public.mafia_roles WHERE code = p_code;

  -- Insert one row per player.
  FOR i IN 1..array_length(v_player_seats, 1) LOOP
    INSERT INTO public.mafia_roles(code, player_id, role)
    VALUES (p_code, v_player_seats[i], v_roles[i]);
  END LOOP;

  -- Build aliveIds JSONB array.
  SELECT jsonb_agg(s) INTO v_alive_arr FROM unnest(v_player_seats) AS s;

  -- Advance phase. Opening mode = Day 0: mafia meets but doesn't kill.
  v_state := jsonb_set(v_state, '{phase}',      '"night-mafia"'::jsonb);
  v_state := jsonb_set(v_state, '{round}',      '1'::jsonb);
  v_state := jsonb_set(v_state, '{aliveIds}',   v_alive_arr);
  v_state := jsonb_set(v_state, '{deadIds}',    '[]'::jsonb);
  v_state := jsonb_set(v_state, '{killTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{saveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{detectiveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{voteTally}',  '{}'::jsonb);
  v_state := jsonb_set(v_state, '{votedBy}',    '{}'::jsonb);
  -- Beat tree starts at opening-setup (client MAFIA_BEATS first entry).
  -- The setup beat introduces the game; the engine walks through setup →
  -- roles recap → night1-open → mafia meet → mafia sleep → day0-morning.
  v_state := jsonb_set(v_state, '{beatId}',     '"opening-setup"'::jsonb);
  v_state := jsonb_set(v_state, '{winner}',     'null'::jsonb);
  v_state := jsonb_set(v_state, '{roleReveal}', '{}'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 13. huddle_mafia_get_my_role — returns caller's own role (or null if narrator)
-- ============================================================================
-- Used by player phones after start_game to learn their role. Returns:
--   { "role": "mafia"|"detective"|"doctor"|"villager", "teammates": [seatId,...] }
--   OR { "role": null }    (narrator or unseated)
-- Mafia teammates are included only for callers whose role is 'mafia'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_get_my_role(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
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

  -- Find caller's seat in claimedBy.
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value = v_uid
  LIMIT 1;

  -- Narrator? They have no role.
  IF (v_state->>'narratorUid') = v_uid THEN
    RETURN jsonb_build_object('role', NULL);
  END IF;

  -- Unseated? No role.
  IF v_my_seat IS NULL THEN
    RETURN jsonb_build_object('role', NULL);
  END IF;

  -- Look up role in mafia_roles.
  SELECT role INTO v_my_role
  FROM public.mafia_roles
  WHERE code = p_code AND player_id = v_my_seat;

  IF v_my_role IS NULL THEN
    -- Game hasn't started yet (no roles assigned).
    RETURN jsonb_build_object('role', NULL);
  END IF;

  -- If mafia, include teammates' seat IDs.
  IF v_my_role = 'mafia' THEN
    SELECT jsonb_agg(player_id) INTO v_teammates
    FROM public.mafia_roles
    WHERE code = p_code AND role = 'mafia' AND player_id <> v_my_seat;
    RETURN jsonb_build_object('role', v_my_role, 'teammates', COALESCE(v_teammates, '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('role', v_my_role);
END;
$$;


-- ============================================================================
-- 14. huddle_mafia_get_narrator_state — narrator-only, returns full role map
-- ============================================================================
-- The narrator's status panel needs to know every player's role. This RPC
-- returns it, but only to the verified narrator.
-- Returns: { "roles": { playerSeatId: role, ... } }
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_get_narrator_state(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    TEXT;
  v_state  JSONB;
  v_roles  JSONB;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT state INTO v_state FROM public.mafia_rooms WHERE code = p_code;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  SELECT jsonb_object_agg(player_id, role) INTO v_roles
  FROM public.mafia_roles
  WHERE code = p_code;

  RETURN jsonb_build_object('roles', COALESCE(v_roles, '{}'::jsonb));
END;
$$;


-- ============================================================================
-- 15. huddle_mafia_advance_beat — narrator-only, advances the script beat
-- ============================================================================
-- Most beats just change the public beatId string so all clients can react
-- (e.g. show the "sleeping" overlay when phase enters night). Validates the
-- new beat id is a string; doesn't enforce script ordering (client controls
-- the script flow).
-- ----------------------------------------------------------------------------
-- Idempotent re-run safety: drop any earlier signature(s) before recreating.
-- The original Phase 1 shipped (TEXT, TEXT, TEXT); Phase 5 adds optional p_round.
DROP FUNCTION IF EXISTS public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION public.huddle_mafia_advance_beat(
  p_code    TEXT,
  p_beat_id TEXT,
  p_phase   TEXT,
  p_round   INT DEFAULT NULL
)
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
  IF p_beat_id IS NULL OR length(p_beat_id) = 0 THEN
    RAISE EXCEPTION 'invalid_beat_id' USING ERRCODE = '22023';
  END IF;
  IF p_phase NOT IN ('night-mafia','night-detective','night-doctor','night-resolve',
                     'day-reveal','day-discuss','vote','vote-tie','day-eliminate','end') THEN
    RAISE EXCEPTION 'invalid_phase: %', p_phase USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.mafia_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  v_state := jsonb_set(v_state, '{beatId}', to_jsonb(p_beat_id));
  v_state := jsonb_set(v_state, '{phase}',  to_jsonb(p_phase));
  -- Optional round update — only set when the caller explicitly bumps the round
  -- (used at the opening→middle transition where Round 1 day moves into
  -- Round 2 night, and during nightly resolves in Phase 6).
  IF p_round IS NOT NULL THEN
    v_state := jsonb_set(v_state, '{round}', to_jsonb(p_round));
  END IF;
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT, INT) TO authenticated;


-- ============================================================================
-- 16. huddle_mafia_mafia_kill — narrator records the mafia's chosen target
-- ============================================================================
-- Narrator only. Target must be alive. Stores in state.killTarget. Phase
-- must be 'night-mafia'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_mafia_kill(
  p_code     TEXT,
  p_target   TEXT
)
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  IF (v_state->>'phase') <> 'night-mafia' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_state->'aliveIds') ? p_target THEN
    RAISE EXCEPTION 'target_not_alive' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{killTarget}', to_jsonb(p_target));
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 17. huddle_mafia_detective_query — narrator queries on Detective's behalf
-- ============================================================================
-- SECURITY-CRITICAL: returns the boolean {isMafia: bool} to the narrator's
-- client ONLY. The narrator then gives the Detective a discreet 👍/👎 in
-- person — the answer never enters public state and never reaches any other
-- client.
--
-- Phase must be 'night-detective'. Target must be alive. Stores the target
-- in state.detectiveTarget for record-keeping (does NOT store the result).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_detective_query(
  p_code   TEXT,
  p_target TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_role      TEXT;
  v_is_mafia  BOOLEAN;
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  IF (v_state->>'phase') <> 'night-detective' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_state->'aliveIds') ? p_target THEN
    RAISE EXCEPTION 'target_not_alive' USING ERRCODE = '42501';
  END IF;

  -- Look up the target's role.
  SELECT role INTO v_role
  FROM public.mafia_roles
  WHERE code = p_code AND player_id = p_target;

  v_is_mafia := (v_role = 'mafia');

  -- Record the query target in public state (not the result).
  v_state := jsonb_set(v_state, '{detectiveTarget}', to_jsonb(p_target));
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;

  -- Return the result to the caller (narrator) only.
  RETURN jsonb_build_object('isMafia', v_is_mafia, 'state', v_state);
END;
$$;


-- ============================================================================
-- 18. huddle_mafia_doctor_save — narrator records the doctor's save target
-- ============================================================================
CREATE OR REPLACE FUNCTION public.huddle_mafia_doctor_save(
  p_code   TEXT,
  p_target TEXT
)
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  IF (v_state->>'phase') <> 'night-doctor' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_state->'aliveIds') ? p_target THEN
    RAISE EXCEPTION 'target_not_alive' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{saveTarget}', to_jsonb(p_target));
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 19. huddle_mafia_resolve_night — narrator-only, applies kill/save
-- ============================================================================
-- Compares killTarget vs saveTarget. If equal → no death. Otherwise →
-- killTarget moves from aliveIds → deadIds. Clears kill/save/detective
-- targets. Transitions phase to 'day-reveal' for Round 1 onward; for round 1
-- Night 1 (Day 0 / Opening mode), the mafia DOESN'T kill, so this is a no-op
-- death-wise but still clears state and advances. Also checks win conditions
-- (because the day-vote can kick in only after a reveal).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_resolve_night(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_kill             TEXT;
  v_save             TEXT;
  v_alive_arr        JSONB;
  v_dead_arr         JSONB;
  v_alive_count      INT;
  v_mafia_alive      INT;
  v_town_alive       INT;
  v_winner           TEXT;
  v_role_reveal      JSONB;
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  v_kill := v_state->>'killTarget';
  v_save := v_state->>'saveTarget';

  v_alive_arr := COALESCE(v_state->'aliveIds', '[]'::jsonb);
  v_dead_arr  := COALESCE(v_state->'deadIds',  '[]'::jsonb);

  -- Round 1 (Day 0): no kill should have been recorded, but defensively
  -- ignore any kill on round 1.
  IF (v_state->>'round')::int = 1 THEN
    v_kill := NULL;
  END IF;

  -- Apply death if killed and not saved.
  IF v_kill IS NOT NULL AND v_kill <> COALESCE(v_save, '') THEN
    -- Remove from aliveIds.
    SELECT jsonb_agg(elem) INTO v_alive_arr
    FROM jsonb_array_elements_text(v_alive_arr) AS elem
    WHERE elem <> v_kill;
    v_alive_arr := COALESCE(v_alive_arr, '[]'::jsonb);
    -- Add to deadIds.
    v_dead_arr := v_dead_arr || to_jsonb(v_kill);
  END IF;

  -- Clear ephemeral fields.
  v_state := jsonb_set(v_state, '{killTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{saveTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{detectiveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{aliveIds}',        v_alive_arr);
  v_state := jsonb_set(v_state, '{deadIds}',         v_dead_arr);

  -- Win-condition check (count alive mafia vs alive town).
  SELECT count(*) INTO v_mafia_alive
  FROM public.mafia_roles
  WHERE code = p_code
    AND role = 'mafia'
    AND player_id IN (SELECT jsonb_array_elements_text(v_alive_arr));

  v_alive_count := jsonb_array_length(v_alive_arr);
  v_town_alive := v_alive_count - v_mafia_alive;

  v_winner := NULL;
  IF v_mafia_alive = 0 THEN
    v_winner := 'town';
  ELSIF v_mafia_alive >= v_town_alive THEN
    v_winner := 'mafia';
  END IF;

  IF v_winner IS NOT NULL THEN
    -- Game over. Build role reveal.
    SELECT jsonb_object_agg(player_id, role) INTO v_role_reveal
    FROM public.mafia_roles
    WHERE code = p_code;

    v_state := jsonb_set(v_state, '{phase}',      '"end"'::jsonb);
    v_state := jsonb_set(v_state, '{winner}',     to_jsonb(v_winner));
    v_state := jsonb_set(v_state, '{roleReveal}', COALESCE(v_role_reveal, '{}'::jsonb));
    -- Beat names match client MAFIA_BEATS keys: endgame-win-town / endgame-win-mafia
    v_state := jsonb_set(v_state, '{beatId}',     to_jsonb('endgame-win-' || v_winner));
  ELSE
    -- Continue to day-reveal. Beat name matches client MAFIA_BEATS:
    -- 'middle-day-reveal' (the narrator's day-reveal copy and action).
    v_state := jsonb_set(v_state, '{phase}',  '"day-reveal"'::jsonb);
    v_state := jsonb_set(v_state, '{beatId}', '"middle-day-reveal"'::jsonb);
    -- Stash the kill outcome in transient fields the day-reveal beat
    -- and Phase 7 vote reveal can read. lastKilled = null when doctor saved.
    v_state := jsonb_set(v_state, '{lastKilled}', COALESCE(to_jsonb(
      CASE WHEN v_kill IS NOT NULL AND v_kill <> COALESCE(v_save, '') THEN v_kill END
    ), 'null'::jsonb));
    v_state := jsonb_set(v_state, '{lastSaved}', COALESCE(to_jsonb(v_save), 'null'::jsonb));
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 20. huddle_mafia_start_vote — narrator-only, transitions to vote phase
-- ============================================================================
CREATE OR REPLACE FUNCTION public.huddle_mafia_start_vote(p_code TEXT)
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  IF (v_state->>'phase') NOT IN ('day-discuss','day-reveal') THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{phase}',     '"vote"'::jsonb);
  v_state := jsonb_set(v_state, '{voteTally}', '{}'::jsonb);
  v_state := jsonb_set(v_state, '{votedBy}',   '{}'::jsonb);
  -- Beat name matches client MAFIA_BEATS key: 'middle-vote-progress'.
  v_state := jsonb_set(v_state, '{beatId}',    '"middle-vote-progress"'::jsonb);
  -- Clear any prior tied candidates from previous voting cycles.
  v_state := jsonb_set(v_state, '{tiedCandidates}', 'null'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 21. huddle_mafia_record_vote — alive player records their vote
-- ============================================================================
-- Caller must be ALIVE (own seat in aliveIds). Target must be alive. Caller
-- can't vote for themselves. Vote locks on first call — re-voting is
-- rejected. Phase must be 'vote' or 'vote-tie'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_record_vote(
  p_code   TEXT,
  p_target TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       TEXT;
  v_state     JSONB;
  v_my_seat   TEXT;
  v_tally     JSONB;
  v_voted_by  JSONB;
  v_old_count INT;
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

  IF (v_state->>'phase') NOT IN ('vote','vote-tie') THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;

  -- Find caller's seat.
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(COALESCE(v_state->'claimedBy', '{}'::jsonb))
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_seat IS NULL THEN
    RAISE EXCEPTION 'not_seated' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_state->'aliveIds') ? v_my_seat THEN
    RAISE EXCEPTION 'voter_not_alive' USING ERRCODE = '42501';
  END IF;
  IF v_my_seat = p_target THEN
    RAISE EXCEPTION 'cant_vote_self' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_state->'aliveIds') ? p_target THEN
    RAISE EXCEPTION 'target_not_alive' USING ERRCODE = '42501';
  END IF;
  -- During a tie re-vote, the target must be one of the tied candidates.
  IF (v_state->>'phase') = 'vote-tie'
     AND jsonb_typeof(v_state->'tiedCandidates') = 'array'
     AND NOT (v_state->'tiedCandidates') ? p_target THEN
    RAISE EXCEPTION 'target_not_in_tie' USING ERRCODE = '42501';
  END IF;
  IF (v_state->'votedBy') ? v_uid THEN
    RAISE EXCEPTION 'already_voted' USING ERRCODE = '42501';
  END IF;

  -- Increment tally for target.
  v_tally := COALESCE(v_state->'voteTally', '{}'::jsonb);
  v_old_count := COALESCE((v_tally->>p_target)::int, 0);
  v_tally := jsonb_set(v_tally, ARRAY[p_target], to_jsonb(v_old_count + 1), true);

  -- Record who voted for whom (cleared on eliminate).
  v_voted_by := COALESCE(v_state->'votedBy', '{}'::jsonb);
  v_voted_by := jsonb_set(v_voted_by, ARRAY[v_uid], to_jsonb(p_target), true);

  v_state := jsonb_set(v_state, '{voteTally}', v_tally);
  v_state := jsonb_set(v_state, '{votedBy}',   v_voted_by);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 22. huddle_mafia_eliminate — narrator-only, applies vote result
-- ============================================================================
-- Determines most-voted target. If unique max → eliminate. If tied → set
-- phase='vote-tie' and re-vote (clear tally, narrate must call start_vote
-- again with only the tied candidates voteable). After elimination, advances
-- to night-mafia (or end if win condition met).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_eliminate(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_tally            JSONB;
  v_max_count        INT;
  v_max_targets      TEXT[];
  v_eliminated       TEXT;
  v_alive_arr        JSONB;
  v_dead_arr         JSONB;
  v_alive_count      INT;
  v_mafia_alive      INT;
  v_town_alive       INT;
  v_winner           TEXT;
  v_role_reveal      JSONB;
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
  PERFORM public.huddle_mafia_assert_narrator(v_state, v_uid);

  IF (v_state->>'phase') NOT IN ('vote','vote-tie') THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;

  v_tally := COALESCE(v_state->'voteTally', '{}'::jsonb);

  -- Find max-vote count.
  SELECT COALESCE(max((value)::int), 0) INTO v_max_count
  FROM jsonb_each_text(v_tally);

  IF v_max_count = 0 THEN
    RAISE EXCEPTION 'no_votes_cast' USING ERRCODE = '42501';
  END IF;

  -- Find all targets tied for max.
  SELECT array_agg(key) INTO v_max_targets
  FROM jsonb_each_text(v_tally)
  WHERE (value)::int = v_max_count;

  IF array_length(v_max_targets, 1) > 1 THEN
    -- Tie. Re-vote needed. Don't eliminate.
    v_state := jsonb_set(v_state, '{phase}',     '"vote-tie"'::jsonb);
    v_state := jsonb_set(v_state, '{voteTally}', '{}'::jsonb);
    v_state := jsonb_set(v_state, '{votedBy}',   '{}'::jsonb);
    -- Beat matches client MAFIA_BEATS key: 'middle-vote-tie-revote'.
    v_state := jsonb_set(v_state, '{beatId}',    '"middle-vote-tie-revote"'::jsonb);
    -- Store the tied candidates so the client can restrict the re-vote UI.
    v_state := jsonb_set(v_state, '{tiedCandidates}', to_jsonb(v_max_targets));
    v_state := jsonb_set(
      v_state,
      '{revision}',
      to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
    );
    UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
    RETURN v_state;
  END IF;

  -- Unique winner: eliminate them.
  v_eliminated := v_max_targets[1];
  v_alive_arr := COALESCE(v_state->'aliveIds', '[]'::jsonb);
  v_dead_arr  := COALESCE(v_state->'deadIds',  '[]'::jsonb);

  SELECT jsonb_agg(elem) INTO v_alive_arr
  FROM jsonb_array_elements_text(v_alive_arr) AS elem
  WHERE elem <> v_eliminated;
  v_alive_arr := COALESCE(v_alive_arr, '[]'::jsonb);
  v_dead_arr  := v_dead_arr || to_jsonb(v_eliminated);

  -- Win-condition check.
  SELECT count(*) INTO v_mafia_alive
  FROM public.mafia_roles
  WHERE code = p_code
    AND role = 'mafia'
    AND player_id IN (SELECT jsonb_array_elements_text(v_alive_arr));

  v_alive_count := jsonb_array_length(v_alive_arr);
  v_town_alive := v_alive_count - v_mafia_alive;

  v_winner := NULL;
  IF v_mafia_alive = 0 THEN
    v_winner := 'town';
  ELSIF v_mafia_alive >= v_town_alive THEN
    v_winner := 'mafia';
  END IF;

  v_state := jsonb_set(v_state, '{aliveIds}', v_alive_arr);
  v_state := jsonb_set(v_state, '{deadIds}',  v_dead_arr);
  v_state := jsonb_set(v_state, '{lastEliminated}', to_jsonb(v_eliminated));

  IF v_winner IS NOT NULL THEN
    SELECT jsonb_object_agg(player_id, role) INTO v_role_reveal
    FROM public.mafia_roles
    WHERE code = p_code;
    v_state := jsonb_set(v_state, '{phase}',      '"end"'::jsonb);
    v_state := jsonb_set(v_state, '{winner}',     to_jsonb(v_winner));
    v_state := jsonb_set(v_state, '{roleReveal}', COALESCE(v_role_reveal, '{}'::jsonb));
    -- Beat name matches client MAFIA_BEATS key: 'endgame-win-town' or 'endgame-win-mafia'.
    v_state := jsonb_set(v_state, '{beatId}',     to_jsonb('endgame-win-' || v_winner));
  ELSE
    -- Transition to the vote-reveal beat (narrator-side). The narrator reads
    -- "X was voted out, they were a Y" and then taps Continue, which fires
    -- advance_beat to move to the next night (round increments client-side
    -- via beat tree action.incrementRound). This separates "vote tally"
    -- from "next night begins" so the narrator can pace the reveal.
    v_state := jsonb_set(v_state, '{phase}',  '"day-eliminate"'::jsonb);
    v_state := jsonb_set(v_state, '{beatId}', '"middle-vote-reveal"'::jsonb);
    v_state := jsonb_set(v_state, '{voteTally}', '{}'::jsonb);
    v_state := jsonb_set(v_state, '{votedBy}',   '{}'::jsonb);
    v_state := jsonb_set(v_state, '{tiedCandidates}', 'null'::jsonb);
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 23. huddle_mafia_play_again — host-only, resets state for a new game
-- ============================================================================
-- Keeps the same claimants and narrator; resets phase to 'lobby', clears
-- alive/dead/votes/etc., and DELETES all roles from mafia_roles (start_game
-- will assign fresh roles).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_play_again(p_code TEXT)
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
  IF (v_state->>'hostId') IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_host' USING ERRCODE = '42501';
  END IF;

  -- Clear roles.
  DELETE FROM public.mafia_roles WHERE code = p_code;

  -- Reset state (keep claimedBy, hostId, narratorUid).
  v_state := jsonb_set(v_state, '{phase}',           '"lobby"'::jsonb);
  v_state := jsonb_set(v_state, '{round}',           '0'::jsonb);
  v_state := jsonb_set(v_state, '{aliveIds}',        '[]'::jsonb);
  v_state := jsonb_set(v_state, '{deadIds}',         '[]'::jsonb);
  v_state := jsonb_set(v_state, '{killTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{saveTarget}',      'null'::jsonb);
  v_state := jsonb_set(v_state, '{detectiveTarget}', 'null'::jsonb);
  v_state := jsonb_set(v_state, '{voteTally}',       '{}'::jsonb);
  v_state := jsonb_set(v_state, '{votedBy}',         '{}'::jsonb);
  v_state := jsonb_set(v_state, '{tiedCandidates}',  'null'::jsonb);
  v_state := jsonb_set(v_state, '{lastEliminated}',  'null'::jsonb);
  v_state := jsonb_set(v_state, '{beatId}',          '"lobby"'::jsonb);
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


-- ============================================================================
-- 24. huddle_mafia_handle_disconnect — narrator-only (or self) cleanup
-- ============================================================================
-- Called when a player disconnects mid-game. Two cases:
--  (a) If phase = 'lobby': remove their claim entirely (frees the seat).
--  (b) If game in progress: mark them as dead (treat as eliminated/give-up).
--      Apply win conditions immediately.
-- Either the narrator OR the disconnecting player themselves can call this.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_handle_disconnect(
  p_code      TEXT,
  p_player_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              TEXT;
  v_state            JSONB;
  v_target_uid       TEXT;
  v_claimedBy        JSONB;
  v_alive_arr        JSONB;
  v_dead_arr         JSONB;
  v_alive_count      INT;
  v_mafia_alive      INT;
  v_town_alive       INT;
  v_winner           TEXT;
  v_role_reveal      JSONB;
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

  -- Authz: either narrator OR the disconnecting player themselves.
  IF v_uid <> v_target_uid AND v_uid <> (v_state->>'narratorUid') THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF (v_state->>'phase') = 'lobby' THEN
    -- Lobby: free the seat.
    v_claimedBy := v_state->'claimedBy' - p_player_id;
    v_state := jsonb_set(v_state, '{claimedBy}', v_claimedBy);
    -- If they were the narrator, clear narratorUid.
    IF v_target_uid = (v_state->>'narratorUid') THEN
      v_state := jsonb_set(v_state, '{narratorUid}', 'null'::jsonb);
    END IF;
  ELSE
    -- Mid-game: mark as dead if alive.
    v_alive_arr := COALESCE(v_state->'aliveIds', '[]'::jsonb);
    v_dead_arr  := COALESCE(v_state->'deadIds',  '[]'::jsonb);
    IF v_alive_arr ? p_player_id THEN
      SELECT jsonb_agg(elem) INTO v_alive_arr
      FROM jsonb_array_elements_text(v_alive_arr) AS elem
      WHERE elem <> p_player_id;
      v_alive_arr := COALESCE(v_alive_arr, '[]'::jsonb);
      v_dead_arr  := v_dead_arr || to_jsonb(p_player_id);
      v_state := jsonb_set(v_state, '{aliveIds}', v_alive_arr);
      v_state := jsonb_set(v_state, '{deadIds}',  v_dead_arr);

      -- Re-check win condition.
      SELECT count(*) INTO v_mafia_alive
      FROM public.mafia_roles
      WHERE code = p_code
        AND role = 'mafia'
        AND player_id IN (SELECT jsonb_array_elements_text(v_alive_arr));
      v_alive_count := jsonb_array_length(v_alive_arr);
      v_town_alive := v_alive_count - v_mafia_alive;

      v_winner := NULL;
      IF v_mafia_alive = 0 THEN
        v_winner := 'town';
      ELSIF v_mafia_alive >= v_town_alive THEN
        v_winner := 'mafia';
      END IF;

      IF v_winner IS NOT NULL THEN
        SELECT jsonb_object_agg(player_id, role) INTO v_role_reveal
        FROM public.mafia_roles WHERE code = p_code;
        v_state := jsonb_set(v_state, '{phase}',      '"end"'::jsonb);
        v_state := jsonb_set(v_state, '{winner}',     to_jsonb(v_winner));
        v_state := jsonb_set(v_state, '{roleReveal}', COALESCE(v_role_reveal, '{}'::jsonb));
        v_state := jsonb_set(v_state, '{beatId}',     to_jsonb('end-' || v_winner));
      END IF;
    END IF;
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.mafia_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 25. huddle_mafia_regenerate_room — anyone-in-room, changes the room code
-- ============================================================================
-- Mirrors the pattern used by hot/liar/cham games. Moves the row to a new
-- code (cascades to mafia_roles via FK).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_mafia_regenerate_room(
  p_old_code TEXT,
  p_new_code TEXT
)
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
  IF p_new_code IS NULL OR length(p_new_code) = 0 THEN
    RAISE EXCEPTION 'invalid_new_code' USING ERRCODE = '22023';
  END IF;
  IF p_old_code = p_new_code THEN
    RAISE EXCEPTION 'same_code' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.mafia_rooms WHERE code = $1 FOR UPDATE'
    USING p_old_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_old_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.huddle_is_claimant(v_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'not_in_room' USING ERRCODE = '42501';
  END IF;

  -- Check new code is free.
  IF EXISTS (SELECT 1 FROM public.mafia_rooms WHERE code = p_new_code) THEN
    RAISE EXCEPTION 'new_code_in_use' USING ERRCODE = '23505';
  END IF;

  -- Use UPDATE on PK — FK on mafia_roles cascades automatically (ON UPDATE
  -- CASCADE is the default for FK PRIMARY KEY references on Postgres when
  -- declared without ON UPDATE; defensively re-key mafia_roles too).
  UPDATE public.mafia_roles SET code = p_new_code WHERE code = p_old_code;
  UPDATE public.mafia_rooms SET code = p_new_code WHERE code = p_old_code;

  SELECT state INTO v_state FROM public.mafia_rooms WHERE code = p_new_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- 26. Grant EXECUTE on all Mafia RPCs to authenticated role
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.huddle_mafia_set_narrator(TEXT, TEXT)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_get_my_role(TEXT)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_get_narrator_state(TEXT)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_mafia_kill(TEXT, TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_detective_query(TEXT, TEXT)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_doctor_save(TEXT, TEXT)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_resolve_night(TEXT)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_start_vote(TEXT)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_record_vote(TEXT, TEXT)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_eliminate(TEXT)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_play_again(TEXT)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_handle_disconnect(TEXT, TEXT)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_mafia_regenerate_room(TEXT, TEXT)           TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_mafia_set_narrator(TEXT, TEXT)             FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_start_game(TEXT)                     FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_get_my_role(TEXT)                    FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_get_narrator_state(TEXT)             FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_advance_beat(TEXT, TEXT, TEXT)       FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_mafia_kill(TEXT, TEXT)               FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_detective_query(TEXT, TEXT)          FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_doctor_save(TEXT, TEXT)              FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_resolve_night(TEXT)                  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_start_vote(TEXT)                     FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_record_vote(TEXT, TEXT)              FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_eliminate(TEXT)                      FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_play_again(TEXT)                     FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_handle_disconnect(TEXT, TEXT)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_mafia_regenerate_room(TEXT, TEXT)          FROM anon, public;


-- ============================================================================
-- 27. Smoke tests (run AFTER applying — paste each as a separate query)
-- ============================================================================
--
-- TEST 1: Verify tables exist with RLS enabled.
-- SELECT tablename, rowsecurity
-- FROM pg_tables WHERE schemaname='public'
-- AND tablename IN ('mafia_rooms','mafia_roles');
-- Expected: 2 rows, rowsecurity = true for both.
--
--
-- TEST 2: Verify policies on mafia_rooms.
-- SELECT policyname, cmd FROM pg_policies
-- WHERE schemaname='public' AND tablename='mafia_rooms'
-- ORDER BY cmd;
-- Expected: "Anyone can read" / SELECT and "Claimant can insert" / INSERT.
-- IMPORTANT: NO row for UPDATE — that's the lockdown.
--
--
-- TEST 3: Verify NO policies on mafia_roles (everything denied).
-- SELECT policyname FROM pg_policies
-- WHERE schemaname='public' AND tablename='mafia_roles';
-- Expected: 0 rows.
--
--
-- TEST 4: Verify mafia_rooms is in realtime publication.
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname='supabase_realtime' AND schemaname='public'
-- AND tablename IN ('mafia_rooms','mafia_roles');
-- Expected: 1 row — mafia_rooms only (NOT mafia_roles).
--
--
-- TEST 5: Verify Mafia RPCs exist + the universal allowlist was updated.
-- SELECT proname FROM pg_proc
-- WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
-- AND (proname LIKE 'huddle_mafia_%' OR proname = 'huddle_assert_room_table')
-- ORDER BY proname;
-- Expected: 17 rows total — huddle_assert_room_table + 16 huddle_mafia_*
-- functions (1 assert helper + 15 RPCs: set_narrator, start_game, get_my_role,
-- get_narrator_state, advance_beat, mafia_kill, detective_query, doctor_save,
-- resolve_night, start_vote, record_vote, eliminate, play_again,
-- handle_disconnect, regenerate_room).
--
--
-- TEST 6: Verify huddle_assert_room_table now accepts mafia_rooms.
-- SELECT public.huddle_assert_room_table('mafia_rooms');
-- Expected: no error.
-- SELECT public.huddle_assert_room_table('nonexistent_rooms');
-- Expected: error "invalid_table: nonexistent_rooms".
--
--
-- TEST 7: As an authenticated user, try to UPDATE mafia_rooms directly via REST.
-- (Run from a Supabase client, NOT this SQL editor — the editor bypasses RLS.)
--   const { error } = await sb.from('mafia_rooms').update({state: '{}'}).eq('code','TEST');
-- Expected: error "permission denied" or 0 rows updated.
-- This proves the UPDATE lockdown works.
--
--
-- TEST 8: As an authenticated user, try to SELECT mafia_roles directly via REST.
--   const { data, error } = await sb.from('mafia_roles').select('*').limit(1);
-- Expected: returns 0 rows (RLS denies SELECT). NO error — the policy denies
-- silently, the query just returns empty.
-- This proves the role privacy lockdown works.
-- ============================================================================
