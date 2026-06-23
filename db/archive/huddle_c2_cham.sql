-- ============================================================================
-- Huddle / Roundlly — C2 Turn 5 (Chameleon full RPC migration + lockdown)
-- ============================================================================
--
-- Final Chameleon migration. Adds all Chameleon-specific RPCs and tightens
-- chameleon_rooms UPDATE policy to deny direct upsert.
--
-- Server-side security wins vs current direct-upsert:
--   • Chameleon role pick is server-side (claimant cannot rig "I'm never the
--     chameleon" or pre-know the chameleon — fixes a real Chameleon attack)
--   • Vote tally + scoring is server-side (claimant cannot fabricate vote
--     results or steal score points)
--   • Outcome resolution is HOST-ONLY (fixes #H11 race where multiple
--     devices each ran chamResolveOutcome and stomped scores)
--   • Phase transitions all host-gated where they should be
--
-- Known trust gaps (documented, not fixed in C2):
--   • Grid items + secret index come from the client's dictionary — a
--     cheating host could craft an "easy" grid or send a secret index
--     the chameleon can guess from. Server validates types + length but
--     not content. Porting the multi-language CHAM_TOPICS dictionary to
--     SQL is far beyond C2 scope.
--   • Server doesn't verify "chameleon's guess" — that's still a UX-only
--     flow handled outside this resolution.
--
-- Run AFTER all earlier C2 migrations + huddle_c2_policy_fix*.sql.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- huddle_cham_reset_players
-- ----------------------------------------------------------------------------
-- Host-only. Clears claimedBy to only contain the caller.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_reset_players(p_code TEXT)
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

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
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

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_set_setting
-- ----------------------------------------------------------------------------
-- Host-only. Updates topic or rounds. Field allowlisted.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_set_setting(
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
  IF p_field NOT IN ('topic', 'rounds') THEN
    RAISE EXCEPTION 'invalid_field: %', p_field USING ERRCODE = '22023';
  END IF;
  IF p_field = 'rounds' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'rounds_must_be_number' USING ERRCODE = '22023';
    END IF;
    IF (p_value::text)::int < 1 OR (p_value::text)::int > 20 THEN
      RAISE EXCEPTION 'rounds_out_of_range' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF jsonb_typeof(p_value) <> 'string' THEN
      RAISE EXCEPTION 'value_must_be_string' USING ERRCODE = '22023';
    END IF;
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
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

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_start_round
-- ----------------------------------------------------------------------------
-- Host-only. Picks the chameleon SERVER-SIDE from claimedBy (excluding the
-- previous chameleon when possible). Picks starting player server-side too.
-- Client provides the activeTopic + 16 grid items + secret index (dictionary
-- lives in JS).
--
-- Validates: caller is host, claimed >= 3, grid_items is 16 strings,
-- secret_index in [0,15], activeTopic is a non-empty string.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_start_round(
  p_code         TEXT,
  p_active_topic TEXT,
  p_grid_items   JSONB,
  p_secret_index INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid             TEXT;
  v_state           JSONB;
  v_claimed_by      JSONB;
  v_claimed_count   INT;
  v_prev_chameleon  TEXT;
  v_chameleon_id    TEXT;
  v_players         JSONB;
  v_starting_idx    INT;
  v_starting_id     TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_active_topic IS NULL OR length(p_active_topic) = 0 THEN
    RAISE EXCEPTION 'invalid_topic' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_grid_items) <> 'array' OR jsonb_array_length(p_grid_items) <> 16 THEN
    RAISE EXCEPTION 'invalid_grid_items' USING ERRCODE = '22023';
  END IF;
  IF p_secret_index < 0 OR p_secret_index >= 16 THEN
    RAISE EXCEPTION 'invalid_secret_index' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(v_claimed_by);
  IF v_claimed_count < 3 THEN
    RAISE EXCEPTION 'need_at_least_3_players' USING ERRCODE = '42501';
  END IF;

  -- SERVER picks chameleon — avoid previous chameleon if possible. This is
  -- the core Chameleon security win: a cheating client cannot rig the role.
  v_prev_chameleon := v_state->>'previousChameleonId';
  SELECT key INTO v_chameleon_id
  FROM jsonb_each_text(v_claimed_by)
  WHERE key <> v_prev_chameleon OR v_prev_chameleon IS NULL
  ORDER BY random()
  LIMIT 1;
  IF v_chameleon_id IS NULL THEN
    -- Edge case: only previous chameleon left? Just pick anyone.
    SELECT key INTO v_chameleon_id
    FROM jsonb_each_text(v_claimed_by)
    ORDER BY random() LIMIT 1;
  END IF;

  -- SERVER picks starting player from claimed players
  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  SELECT key INTO v_starting_id
  FROM jsonb_each_text(v_claimed_by)
  ORDER BY random() LIMIT 1;
  SELECT (ord::int - 1) INTO v_starting_idx
  FROM jsonb_array_elements(v_players) WITH ORDINALITY AS t(p, ord)
  WHERE p->>'id' = v_starting_id
  LIMIT 1;
  IF v_starting_idx IS NULL THEN v_starting_idx := 0; END IF;

  v_state := v_state || jsonb_build_object(
    'chameleonId',        v_chameleon_id,
    'activeTopic',        p_active_topic,
    'gridItems',          p_grid_items,
    'secretIndex',        p_secret_index,
    'startingPlayerIdx',  v_starting_idx,
    'myVote',             null,
    'voteResults',        '{}'::jsonb,
    'mostVotedId',        null,
    'chameleonCaught',    false,
    'outcome',            null,
    'phase',              'splash',
    'phaseStartAt',       public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_dismiss_splash
-- ----------------------------------------------------------------------------
-- Host-only. Advances from splash → play.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_dismiss_splash(p_code TEXT)
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

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);
  IF (v_state->>'phase') <> 'splash' THEN
    RETURN v_state;
  END IF;

  v_state := v_state || jsonb_build_object(
    'phase',        'play',
    'phaseStartAt', public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );
  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_go_to_vote
-- ----------------------------------------------------------------------------
-- Host-only. Phase: play → vote.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_go_to_vote(p_code TEXT)
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

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_state := v_state || jsonb_build_object(
    'phase',        'vote',
    'voteResults',  '{}'::jsonb,
    'myVote',       null,
    'phaseStartAt', public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );
  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_submit_vote
-- ----------------------------------------------------------------------------
-- Any claimant. Records caller's vote for p_target_id. Rejects duplicate
-- votes (one vote per claimant per round). Voter cannot vote for themselves.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_submit_vote(
  p_code      TEXT,
  p_target_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid            TEXT;
  v_state          JSONB;
  v_my_seat        TEXT;
  v_vote_results   JSONB;
  v_target_votes   JSONB;
  v_already_voted  BOOLEAN;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target_id IS NULL OR length(p_target_id) = 0 THEN
    RAISE EXCEPTION 'invalid_target' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF (v_state->>'phase') <> 'vote' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;

  -- Identify caller's seat
  SELECT key INTO v_my_seat
  FROM jsonb_each_text(v_state->'claimedBy')
  WHERE value = v_uid
  LIMIT 1;
  IF v_my_seat IS NULL THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;
  IF v_my_seat = p_target_id THEN
    RAISE EXCEPTION 'cannot_vote_for_self' USING ERRCODE = '42501';
  END IF;

  v_vote_results := COALESCE(v_state->'voteResults', '{}'::jsonb);

  -- Already voted? Check every target's array.
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_each(v_vote_results) AS pairs(target, voters),
         jsonb_array_elements_text(voters) AS v(voter_id)
    WHERE v.voter_id = v_my_seat
  ) INTO v_already_voted;
  IF v_already_voted THEN
    RAISE EXCEPTION 'already_voted' USING ERRCODE = '42501';
  END IF;

  -- Append caller to voteResults[target]
  v_target_votes := COALESCE(v_vote_results->p_target_id, '[]'::jsonb) || jsonb_build_array(v_my_seat);
  v_vote_results := jsonb_set(v_vote_results, ARRAY[p_target_id], v_target_votes, true);
  v_state := jsonb_set(v_state, '{voteResults}', v_vote_results);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_resolve_outcome
-- ----------------------------------------------------------------------------
-- HOST-ONLY (fixes plan note #H11 — original chamResolveOutcome had no host
-- guard, so multiple devices each ran it and stomped scores). Server tallies
-- votes, determines outcome, computes scoring, sets phase='result'.
--
-- Scoring rule (mirrors client):
--   • chameleon NOT in top-voted → outcome='chameleon' → chameleon gets +1
--   • chameleon IS in top-voted  → outcome='players'  → each correct voter
--     (voted for chameleon, but isn't the chameleon themselves) gets +1
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_resolve_outcome(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid               TEXT;
  v_state             JSONB;
  v_claimed_count     INT;
  v_voted_count       INT;
  v_vote_results      JSONB;
  v_max_count         INT;
  v_chameleon_id      TEXT;
  v_chameleon_in_top  BOOLEAN;
  v_outcome           TEXT;
  v_most_voted_id     TEXT;
  v_scores            JSONB;
  v_top_voted_first   TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  IF (v_state->>'phase') <> 'vote' THEN
    -- Idempotent: already resolved
    RETURN v_state;
  END IF;

  -- Verify all claimed players have voted
  SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(COALESCE(v_state->'claimedBy', '{}'::jsonb));
  v_vote_results := COALESCE(v_state->'voteResults', '{}'::jsonb);
  SELECT COALESCE(sum(jsonb_array_length(arr)), 0)::int INTO v_voted_count
  FROM jsonb_each(v_vote_results) AS pairs(target, arr);
  IF v_voted_count < v_claimed_count THEN
    RAISE EXCEPTION 'votes_incomplete: % of %', v_voted_count, v_claimed_count USING ERRCODE = '42501';
  END IF;

  -- Tally: find max votes, find top-voted set, detect chameleon
  v_max_count := 0;
  FOR v_top_voted_first IN SELECT key FROM jsonb_each(v_vote_results) LOOP
    IF jsonb_array_length(v_vote_results->v_top_voted_first) > v_max_count THEN
      v_max_count := jsonb_array_length(v_vote_results->v_top_voted_first);
    END IF;
  END LOOP;

  v_chameleon_id := v_state->>'chameleonId';
  v_chameleon_in_top := (
    v_vote_results ? v_chameleon_id
    AND jsonb_array_length(v_vote_results->v_chameleon_id) = v_max_count
    AND v_max_count > 0
  );

  IF v_chameleon_in_top THEN
    v_outcome := 'players';
    v_most_voted_id := v_chameleon_id;
  ELSE
    v_outcome := 'chameleon';
    SELECT key INTO v_most_voted_id
    FROM jsonb_each(v_vote_results)
    WHERE jsonb_array_length(value) = v_max_count
    ORDER BY key LIMIT 1;
  END IF;

  -- Scoring
  v_scores := COALESCE(v_state->'scores', '{}'::jsonb);
  IF v_outcome = 'chameleon' THEN
    v_scores := jsonb_set(
      v_scores,
      ARRAY[v_chameleon_id],
      to_jsonb(COALESCE((v_scores->>v_chameleon_id)::int, 0) + 1),
      true
    );
  ELSE
    -- +1 for each voter who voted for the chameleon (excluding chameleon self-vote, if any)
    FOR v_top_voted_first IN
      SELECT voter_id
      FROM jsonb_array_elements_text(COALESCE(v_vote_results->v_chameleon_id, '[]'::jsonb)) AS v(voter_id)
      WHERE voter_id <> v_chameleon_id
    LOOP
      v_scores := jsonb_set(
        v_scores,
        ARRAY[v_top_voted_first],
        to_jsonb(COALESCE((v_scores->>v_top_voted_first)::int, 0) + 1),
        true
      );
    END LOOP;
  END IF;

  v_state := v_state || jsonb_build_object(
    'chameleonCaught', v_chameleon_in_top,
    'mostVotedId',     v_most_voted_id,
    'outcome',         v_outcome,
    'scores',          v_scores,
    'phase',           'result',
    'phaseStartAt',    public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_play_again  (also used for fresh-game start)
-- ----------------------------------------------------------------------------
-- Host-only. Resets game state (scores=0, currentRound=1, previousChameleon=null,
-- _gamesPlayedCounted=false, closedByHost=false), then starts the first round
-- (picks chameleon + starting player server-side; client provides topic +
-- grid + secret). Accepts both phase='lobby' (fresh start) and 'result'
-- (real play-again). Same pattern as huddle_hot_play_again.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_play_again(
  p_code         TEXT,
  p_active_topic TEXT,
  p_grid_items   JSONB,
  p_secret_index INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid             TEXT;
  v_state           JSONB;
  v_claimed_by      JSONB;
  v_claimed_count   INT;
  v_chameleon_id    TEXT;
  v_scores          JSONB;
  v_players         JSONB;
  v_starting_idx    INT;
  v_starting_id     TEXT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF jsonb_typeof(p_grid_items) <> 'array' OR jsonb_array_length(p_grid_items) <> 16 THEN
    RAISE EXCEPTION 'invalid_grid_items' USING ERRCODE = '22023';
  END IF;
  IF p_secret_index < 0 OR p_secret_index >= 16 THEN
    RAISE EXCEPTION 'invalid_secret_index' USING ERRCODE = '22023';
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.huddle_assert_host(v_state, v_uid);

  v_claimed_by := COALESCE(v_state->'claimedBy', '{}'::jsonb);
  SELECT count(*) INTO v_claimed_count FROM jsonb_object_keys(v_claimed_by);
  IF v_claimed_count < 3 THEN
    RAISE EXCEPTION 'need_at_least_3_players' USING ERRCODE = '42501';
  END IF;

  -- Reset scores to 0 for every claimed player
  v_scores := '{}'::jsonb;
  FOR v_chameleon_id IN SELECT key FROM jsonb_each_text(v_claimed_by) LOOP
    v_scores := jsonb_set(v_scores, ARRAY[v_chameleon_id], '0'::jsonb, true);
  END LOOP;

  -- Pick chameleon server-side (fresh game, no previous chameleon constraint)
  SELECT key INTO v_chameleon_id
  FROM jsonb_each_text(v_claimed_by)
  ORDER BY random() LIMIT 1;

  -- Pick starting player server-side
  v_players := COALESCE(v_state->'players', '[]'::jsonb);
  SELECT key INTO v_starting_id
  FROM jsonb_each_text(v_claimed_by)
  ORDER BY random() LIMIT 1;
  SELECT (ord::int - 1) INTO v_starting_idx
  FROM jsonb_array_elements(v_players) WITH ORDINALITY AS t(p, ord)
  WHERE p->>'id' = v_starting_id
  LIMIT 1;
  IF v_starting_idx IS NULL THEN v_starting_idx := 0; END IF;

  v_state := v_state || jsonb_build_object(
    'currentRound',         1,
    'previousChameleonId',  null,
    'scores',               v_scores,
    '_gamesPlayedCounted',  false,
    'closedByHost',         false,
    'chameleonId',          v_chameleon_id,
    'activeTopic',          p_active_topic,
    'gridItems',            p_grid_items,
    'secretIndex',          p_secret_index,
    'startingPlayerIdx',    v_starting_idx,
    'myVote',               null,
    'voteResults',          '{}'::jsonb,
    'mostVotedId',          null,
    'chameleonCaught',      false,
    'outcome',              null,
    'phase',                'splash',
    'phaseStartAt',         public.huddle_phase_start_ms()
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ----------------------------------------------------------------------------
-- huddle_cham_mark_game_counted
-- ----------------------------------------------------------------------------
-- Any claimant. Idempotently flips _gamesPlayedCounted=true (C1 fix mirror).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.huddle_cham_mark_game_counted(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           TEXT;
  v_state         JSONB;
  v_current_round INT;
  v_rounds        INT;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT state FROM public.chameleon_rooms WHERE code = $1 FOR UPDATE'
    USING p_code INTO v_state;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'room_not_found: %', p_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.huddle_is_claimant(v_state->'claimedBy', v_uid) THEN
    RAISE EXCEPTION 'not_claimant' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'phase') <> 'result' THEN
    RAISE EXCEPTION 'wrong_phase' USING ERRCODE = '42501';
  END IF;
  IF (v_state->>'_gamesPlayedCounted')::boolean IS TRUE THEN
    RETURN v_state;
  END IF;

  v_current_round := COALESCE((v_state->>'currentRound')::int, 1);
  v_rounds := COALESCE((v_state->>'rounds')::int, 1);
  IF v_current_round < v_rounds THEN
    RAISE EXCEPTION 'not_last_round' USING ERRCODE = '42501';
  END IF;

  v_state := jsonb_set(v_state, '{_gamesPlayedCounted}', 'true'::jsonb);
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb(COALESCE((v_state->>'revision')::int, 0) + 1)
  );

  UPDATE public.chameleon_rooms SET state = v_state WHERE code = p_code;
  RETURN v_state;
END;
$$;


-- ============================================================================
-- Tighten chameleon_rooms UPDATE policy: DENY all direct UPDATE
-- ============================================================================
DROP POLICY IF EXISTS "Claimant can update" ON public.chameleon_rooms;


-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.huddle_cham_reset_players(TEXT)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_set_setting(TEXT, TEXT, JSONB)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_start_round(TEXT, TEXT, JSONB, INT)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_dismiss_splash(TEXT)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_go_to_vote(TEXT)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_submit_vote(TEXT, TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_resolve_outcome(TEXT)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_play_again(TEXT, TEXT, JSONB, INT)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.huddle_cham_mark_game_counted(TEXT)                TO authenticated;

REVOKE EXECUTE ON FUNCTION public.huddle_cham_reset_players(TEXT)                   FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_set_setting(TEXT, TEXT, JSONB)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_start_round(TEXT, TEXT, JSONB, INT)   FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_dismiss_splash(TEXT)                  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_go_to_vote(TEXT)                      FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_submit_vote(TEXT, TEXT)               FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_resolve_outcome(TEXT)                 FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_play_again(TEXT, TEXT, JSONB, INT)    FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.huddle_cham_mark_game_counted(TEXT)               FROM anon, public;
