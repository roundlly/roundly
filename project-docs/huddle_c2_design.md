# C2 Security Fix — Design & Multi-Turn Plan

> **Status:** Turns 1, 2, 3a–c ✅ (Liar's Cup fully locked). Turns 4a–b ✅ (Hot Seat fully locked). Turn 5 ✅ (Chameleon fully locked). **C2 COMPLETE for all 3 games.** Auxiliary tables (profiles / feedback / friendships) pending separate work. **Policy correction:** apply `huddle_c2_policy_fix.sql` + `huddle_c2_policy_fix2.sql` before any policy claim is actually enforced.

> **⚠️ Turn 6 status CORRECTED 2026-07-02 (the "Pending" below is stale — do not treat this doc as the open-task tracker):**
> - **Feedback tables — DONE, verified live.** RLS enabled on both, captured verbatim from the live pg_policies snapshot of 2026-06-23 in `db/migrations/09_policies.sql`: `feedback_posts` has the full set (select-all, insert/update/delete-own, admin update/delete via `is_admin()`); `feedback_votes` has select-all + insert-own + delete-own only (no update/admin policies — by design, votes toggle via insert/delete).
> - **Social tables (`profiles`, `friendships`, + the later-added `room_invites`) — RLS policies are present live** (same 2026-06-23 snapshot; additionally a 2026-06-30 unauthenticated PostgREST probe confirmed `room_invites` RLS blocks anon inserts). **But** their CREATE TABLE DDL has zero repo coverage (confirmed by grep — no CREATE TABLE for any of the three; see the note at the bottom of `db/migrations/09_policies.sql` and `db/README.md` "Social subsystem" caveat) and no runnable policy SQL was ever generated for them. The raw policy *expressions* from the 2026-06-23 snapshot DO sit in the repo at `tools/live-policies.csv` (friendships ~13–16, profiles ~23–28, room_invites ~29–33) — possibly stale by now, so re-dump for authority, but a preliminary review can start from that CSV today. The policy *quality* has never been reviewed — "policies exist" is not the same as "policies are correct" (the CSV already shows e.g. duplicate policy pairs on `profiles` and a world-readable SELECT).
> - **The remaining open task** (snapshot the social DDL + policies into `db/`, and review them) is now tracked in the project memory's status file (`huddle-status`, entry dated 2026-07-02) — that tracker owns it, not this doc.

## ⚠️ Policy-name correction (must apply once)

Turn 1's `huddle_c2_rls.sql` DROPped policies named `"Public read/insert/update/delete"`, but the existing bootstrap policies in your project were actually named `<table>_select_all` / `_insert_all` / `_update_all` / `_delete_all`. The DROPs were no-ops. The original permissive policies are still active, and RLS evaluates policies as OR — so the permissive ones win, making Turns 1-3's policy restrictions effectively no-ops at the database level (RPCs still work because they use SECURITY DEFINER and bypass RLS entirely).

Apply **both** correction files in sequence:
1. `huddle_c2_policy_fix.sql` — drops `<table>_select_all` / `_insert_all` / `_update_all` / `_delete_all` (the `_all` convention used on most tables).
2. `huddle_c2_policy_fix2.sql` — drops `"hotseat insert"` / `"hotseat read"` / `"hotseat update"` (the space-naming convention used specifically on hotseat_rooms). Also defensively drops the same pattern on cham/liar in case they exist.

After both run, the enforced state matches what Turns 1-3 documented:
- `liar_rooms`: SELECT open, INSERT restricted (Turn 1 INSERT policy), **UPDATE denied** (Turn 3c lockdown).
- `hotseat_rooms` and `chameleon_rooms`: SELECT open, INSERT restricted, UPDATE restricted to claimants. Outsiders blocked.
> **Source plan:** `C:\Users\HUWAI\.claude\plans\i-need-a-full-dreamy-falcon.md` (finding #C2).

## Threat model

Today, the three game-room tables (`hotseat_rooms`, `chameleon_rooms`, `liar_rooms`) have **open RLS** — any user with the anon Supabase key can `select`/`insert`/`update` any row via direct REST API. With a room code (4 characters, easily brute-forceable), an attacker can:

- Steal another player's seat (`claimedBy[seatId] = attacker_id`)
- Read every player's private hand in Liar's Cup
- Set themselves as the winner / declare game over
- Change the secret word in Chameleon
- Reassign the Chameleon role mid-round
- Force-start or force-end a game from outside the lobby

Client-side checks (`hotIsHost()`, etc.) are bypassed by direct REST calls.

## Defense strategy: per-action RPC

The chosen approach (per user direction): every state mutation routes through a **server-side `SECURITY DEFINER` RPC function** that:

1. Verifies the caller's `auth.uid()` is allowed to perform the action (host? specific player? any claimant?)
2. Validates the new state transition against game rules (e.g. you can only play cards you actually hold)
3. Updates the row with service-role privilege

Client-side `*Persist()` (direct upsert) is **deprecated**. Once all actions for a game are migrated to RPCs, the row's RLS policies tighten to **deny direct UPDATE** for that table.

## Phased rollout (5 turns)

| Turn | Deliverable | Status |
|------|-------------|--------|
| **1** | Design doc, SQL skeleton (RLS + 4 universal RPCs), client error toast on `*Persist` | ✅ Shipped. Outsider attacks blocked. App still works for claimants via upsert. |
| **2** | Liar's Cup lobby actions wired to RPCs: `liarClaimSeat`, `liarLeaveRoom`, `liarLeaveGameOver`, `liarCloseRoom`. SQL: updated `huddle_claim_seat` for seat-switching. Added `huddleCallRPC` helper. | ✅ Shipped. Liar's Cup seat-stealing & host-spoofing via REST API now rejected at DB layer. |
| **3a** | Liar's Cup round mechanics: `liar_start_game`, `liar_start_first_turn`, `liar_play_cards` (validates card ownership server-side), `liar_call_liar`, `liar_play_again`. Server-side deck shuffle + deal. | ✅ Shipped. Card-ownership cheating now impossible. Hand dealing no longer client-controlled. |
| **3b** | Liar's Cup cup mechanics: `liar_start_sip`, `liar_take_sip` (server random chamber), `liar_after_sip` (folds finish_game and next-round-deal). | ✅ Shipped. Cup outcome no longer client-rig-able. Game end + cascade into next round entirely server-side. |
| **3c** | Liar's Cup lockdown: added `liar_handle_disconnect` (phase-aware cleanup), `liar_reset_players`, `liar_finish_solo`. Every game-action JS function now calls RPCs; zero `liarPersist()` callers outside dead code + room INSERT. Dropped `Claimant can update` policy on `liar_rooms` — direct UPDATE now denied at DB layer. | ✅ Shipped. Liar's Cup fully locked. Insider attacks via direct REST API now rejected. |
| **4a** | Hot Seat lobby + settings: new RPCs `hot_reset_players`, `hot_set_setting` (parametric for category/rounds/order/mode), `hot_apply_recommended`. Client wiring for `hotClaimSeat` / `hotLeaveRoom` / `hotLeaveGameOver` / `hotCloseRoom` to existing universal RPCs. | ✅ Shipped. Hot Seat lobby & settings server-validated. |
| **4b** | Hot Seat in-game: `hot_start_turn`, `hot_dismiss_splash`, `hot_end_round`, `hot_next_turn`, `hot_play_again` (also used for fresh-game start), `hot_mark_game_counted`. Dropped `Claimant can update` policy on `hotseat_rooms`. | ✅ Shipped. Hot Seat fully locked. Direct UPDATE rejected at DB. |
| **5** | Chameleon full RPC migration (~13 actions): `cham_reset_players`, `cham_set_setting`, `cham_start_round` (server picks chameleon + starting player), `cham_dismiss_splash`, `cham_go_to_vote`, `cham_submit_vote`, `cham_resolve_outcome` (host-only — fixes #H11), `cham_play_again`, `cham_mark_game_counted`. Dropped `Claimant can update` policy on `chameleon_rooms`. | ✅ Shipped. Chameleon fully locked. Server picks chameleon role (cheater cannot rig). Vote tally + scoring server-side. #H11 race fixed via host-only resolve. |
| **6** | Auxiliary tables: `profiles`, `feedback_posts`, `feedback_votes`, `friendships` RLS. | ⚠️ Stale — see the dated correction at the top of this doc. Feedback tables ✅ done live (2026-06-23, in `db/migrations/09_policies.sql`); social tables have live RLS but their DDL isn't in the repo + policies unreviewed — residual task tracked in `huddle-status` memory (2026-07-02). |

## Turn 1 deliverables

### SQL (`huddle_c2_rls.sql`)

- Enable RLS on `hotseat_rooms`, `chameleon_rooms`, `liar_rooms`
- Drop old open policies
- New policies:
  - **SELECT**: open (anyone can read by code — needed for QR/link join flow before claiming)
  - **INSERT**: `auth.uid()::text` must be in `NEW.state->'claimedBy'` values (room creator must include themselves)
  - **UPDATE** (Phase 1): `auth.uid()::text` must be in `OLD.state->'claimedBy'` values (any claimant can update). **Phase 2+ will replace with `deny all` once RPCs cover that game.**
  - **DELETE**: deny all
- Define universal RPC functions (callable now or in later turns):
  - `huddle_create_room(p_table TEXT, p_code TEXT, p_initial_state JSONB) → JSONB`
  - `huddle_claim_seat(p_table TEXT, p_code TEXT, p_player_id TEXT) → JSONB`
  - `huddle_leave_seat(p_table TEXT, p_code TEXT) → JSONB`
  - `huddle_close_room(p_table TEXT, p_code TEXT) → JSONB`

### Client (`index.html` minimal changes)

- Add `.catch()` + permission-denied toast on `hotPersist` / `chamPersist` / `liarPersist`
- Add i18n key `common.permissionDenied` (EN + TR)
- Leave direct upsert in place for now — governed by new claimant-only RLS

## Universal RPC contracts

### `huddle_create_room(p_table, p_code, p_initial_state)`

**Caller**: any authenticated user
**Validation**:
- `p_table` ∈ {`hotseat_rooms`, `chameleon_rooms`, `liar_rooms`}
- `p_code` is non-empty
- `p_initial_state->'claimedBy'` contains `auth.uid()` as a value
- `p_initial_state->>'hostId'` equals `auth.uid()::text`
- Row with `p_code` must not exist (raises if it does)

**Effect**: `INSERT INTO {p_table} (code, state) VALUES (p_code, p_initial_state)`. Returns the inserted state.

### `huddle_claim_seat(p_table, p_code, p_player_id)`

**Caller**: any authenticated user (not already a claimant — covers chicken-and-egg)
**Validation**:
- `p_table` allowlist
- Row exists
- `p_player_id` is not already claimed by another user (claim reject if owned by different uid)
- Self-reclaim of own seat is allowed (idempotent)

**Effect**: sets `state->'claimedBy'->>p_player_id = auth.uid()::text`; if `hostId` is null, also sets `hostId = auth.uid()`. Returns new state.

### `huddle_leave_seat(p_table, p_code)`

**Caller**: any authenticated user who currently holds a seat in the room
**Validation**:
- `p_table` allowlist
- Caller's `auth.uid()` is in `state->'claimedBy'` values
- Caller's playerId is derived from `state->'claimedBy'` (whichever seat maps to their uid)

**Effect**: deletes the caller's entry from `claimedBy`; if caller was `hostId`, transfers host to the lexicographically-lowest remaining claimant (or sets `hostId=null` if room is empty). Returns new state.

### `huddle_close_room(p_table, p_code)`

**Caller**: must be `state->>'hostId' = auth.uid()::text`
**Validation**: caller is host
**Effect**: sets `closedByHost=true`, `hostId=null`. Returns new state.

## Game-specific RPC plan (turns 2-4)

### Liar's Cup (Turn 2 — ~17 actions)

- `liar_start_round` (host only) — deal hands, set tableCard, advance roundCount
- `liar_start_first_turn` (host only) — phase='play'
- `liar_play_cards` (current player only) — validate card ownership, remove from hand, append to pile
- `liar_call_liar` (current player only) — set pendingLoser, phase='reveal'
- `liar_start_sip` (loser only) — initialize cup chamber pattern
- `liar_take_sip` (loser only) — set chamber, outcome, phase='cup-result' or 'tablecard'
- `liar_after_sip` (loser only) — filter alivePlayers, set winner, advance phase
- `liar_finish_game` — set winnerId, phase='result'
- `liar_play_again` (host only) — reset state
- `liar_regenerate_room` (host only) — update code

**Privacy concern**: server returns full state including all hands. Future hardening: per-player views that only return that player's hand.

### Hot Seat (Turn 3 — ~16 actions)

- `hot_set_category`, `hot_set_rounds`, `hot_set_order`, `hot_set_mode`, `hot_apply_recommended` (host only)
- `hot_pick_next_player_auto` (host only) — currentPlayerIdx, currentWord, phase='splash'
- `hot_pick_next_player_manual` (host only) — same effect, from picker
- `hot_dismiss_splash` (any) — phase='play', start turn timer
- `hot_end_round` (hot seat or helper, gated by outcome) — record outcome + duration
- `hot_next_turn` (host only) — advance round
- `hot_play_again` (host only) — reset
- `hot_reset_players` (host only) — clear non-self claims
- `hot_regenerate_room` (any) — update code

### Chameleon (Turn 4 — ~13 actions)

- `cham_set_topic`, `cham_set_rounds` (host only)
- `cham_reset_players` (host only)
- `cham_start_round` (host only) — pick chameleon, gridItems, secretIndex
- `cham_dismiss_splash` (host only) — phase='play'
- `cham_go_to_vote` (host only) — phase='vote'
- `cham_submit_vote` (voter only) — append to voteResults[target]
- `cham_resolve_outcome` — auto-fires after last vote; should be server-side
- `cham_play_again` (host only) — reset
- `cham_regenerate_room` (any) — update code

## Supabase dashboard checklist (operator: huddle owner)

Before running the SQL:

1. **Auth → Providers → Anonymous Sign-Ins → Enable.** (User confirmed already done.)
2. **Database → Tables → `hotseat_rooms`, `chameleon_rooms`, `liar_rooms`** — verify they exist.
3. **Decision: existing rooms.** If any rows already exist in the room tables, they were written under the OLD open RLS with random `tab_*` sessionIds (when anon-sign-in failed) OR real `auth.uid()` values. After Turn 1's SQL applies:
   - Rooms whose `claimedBy` contains real `auth.uid()` values → still writable by those users.
   - Rooms whose `claimedBy` contains only `tab_*` strings → no one can update them (orphaned). Recommend truncating the tables before applying. **No production data at risk yet — this is still prototype phase.**
4. **Run `huddle_c2_rls.sql`** in SQL Editor.
5. **Verify**:
   - SELECT a room as authenticated user → succeeds.
   - UPDATE a room as authenticated NON-claimant via REST API → fails with permission denied.
   - INSERT a room without including yourself in claimedBy → fails.

## Risks & rollback

- **If SQL is wrong or anon-auth flakes**: app breaks for everyone. Rollback = run `revert_huddle_c2.sql` (provided as a paired file in turn 1) that restores open policies.
- **If subsequent turns introduce bad RPCs**: those RPCs can be dropped + reverted to upsert path until fixed.
- **Per-game phased lockdown** means an incomplete migration is safe — a half-migrated game's leftover direct-upsert mutations still work under the Phase 1 UPDATE policy.

## Verification matrix

Add to each turn's PR:

| Verification | Turn 1 | Turn 2-4 |
|--------------|--------|----------|
| Authenticated claimant can play a full game | ✓ | ✓ |
| Unauthenticated user (no JWT) can't update | ✓ | ✓ |
| Outsider (auth'd, not a claimant) can't update | ✓ | ✓ |
| Insider claimant can't steal another seat | (still possible) | ✓ (RPC blocks) |
| Insider claimant can't read another's hand (Liar's) | (still possible — server returns full state) | (partial — hand readable but not modifiable; full per-view privacy = future) |
| Insider claimant can't change secret word (Cham) | (still possible) | ✓ (RPC blocks) |
