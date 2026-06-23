# Phase 2 Progress & Handoff

> Resume point for continuing the shared-engine work in a new chat.
> Last updated: 2026-06-22. Read this first, then `PHASE2_FINDINGS.md` and `ARCHITECTURE_REVIEW.md`.

## The goal (recap)
Each of the 4 games (Hot Seat, Chameleon, Liar, Mafia) had its own copy of the same
plumbing — **17 "families" × 4 games = ~68 near-duplicate functions**. Phase 2 replaces
each set of 4 copies with **one shared `huddle*` helper**, killing the duplication that
causes "fix one bug, the others stay broken."

## ✅ Done — 10 of 17 families merged (all verified)
Shared helpers all live in `app-01-core-hotseat.js` near the top:

| # | Family | Shared helper | Verified by |
|---|--------|---------------|-------------|
| 1 | CancelLeaveGrace | `huddleCancelLeaveGrace(timers, sessionId)` | smoke + mp |
| 2 | StartLeaveGrace | `huddleStartLeaveGrace(timers, sessionId, graceMs, onConfirm)` | smoke + mp |
| 3 | ReadUrlRoom | `huddleReadUrlRoom(gameToken)` | smoke + functional |
| 4 | SyncUrlToRoom | `huddleSyncUrlToRoom(code, gameToken)` | smoke + functional |
| 5 | ResetPresenceState | `huddleResetPresenceState(timers, sessions)` | smoke + functional |
| 6 | LoadRoom (3 of 4) | `huddleFetchRoomState(table, code)` — Mafia stays separate | smoke + mp |
| 7 | GetSessionId | `huddleGetSessionId(me)` — all 4 games | smoke + mp (28/28) + manual phones |
| 8 | Bootstrap | `huddleBootstrap(me, logLabel)` — all 4 games | smoke + mp (28/28) + manual phones |
| 9 | LeaveRoom (3 of 4) | `huddleLeaveRoom(opts)` — Hot/Cham/Liar; Mafia stays separate (narrator model). Per-game `preLeave`/`teardown`/`context` callbacks preserve each game's exact behavior | smoke 9/9 + mp 28/28 (mp clicks the RPC, not the button — do a 2-phone Leave tap too) |
| 10 | ConfirmUserGone (3 of 4) | `huddleConfirmUserGone(sessionId, opts)` — Hot/Cham/Liar; Mafia separate (narrator election + passes seat id). Folded in Cham/Liar's `*HandleConfirmedDisconnect` indirection helpers | smoke 9/9 + mp 28/28 (NB: mp tests explicit-leave, not the 60s disconnect path — behavior-preserving refactor) |

**GetSessionId/Bootstrap merge notes (2026-06-23):**
- All 4 `<game>Bootstrap`/`<game>GetSessionId` now delegate to the shared pair. Each game passes its own `me` object (kept separate because each holds extra per-game fields). The `tab_` fallback was **KEPT** (deliberate safety net for offline / 429 anon rate-limit — it is NOT dead code).
- **Mafia normalized**: added a `bootstrapped` flag to `mafiaMe` (it previously guarded on `sessionId` and could return `null`); now identical behavior to the other 3.
- **Latent bug fixed**: `huddleAfterSignIn` (app-03) rebound hot/cham/liar to the new auth id after Google/password sign-in but **never `mafiaMe`** → "claimed seat mismatch" for Mafia on anon→account sign-in mid-lobby. Now rebinds all 4 in lockstep; sign-out resets `mafiaMe.bootstrapped` too. Confirmed on real phones.
- Regression tool added: `tmp/check-sessionid.js` (proves all 4 resolve to a real UUID, ~1 anon sign-in).
- Identity-convergence verified: every game's mp `distinct identities` line shows real auth UUIDs, no `tab_`.

**Plus (not part of the 17, but related fixes this effort produced):**
- Player-left **notice parity** across all 4 games (realtime seat-vanish detection → "{name} left the game."). Hot Seat + Chameleon also return host to lobby if a mid-game room drops <2.
- Fixed 2 real production bugs: missing DB function `huddle_hot_play_again` (Hot Seat couldn't start); the leave-notification gap.
- **Sign-out ghost-seat fix (2026-06-23):** `huddleSignOut` only did a LOCAL teardown and never released the seat server-side → other players saw a ghost seat until the 60s presence grace. Now sign-out fires `huddle_leave_seat` per game FIRST (like Leave), reading the code from the durable `huddleReadLastRoom` store (live state is cleared by the time you reach the Profile-screen Sign Out button). Verified on 2 phones.
- **Login confirmed Google-only by design (2026-06-23):** simplified `login-clean-cta`; old email/password/guest form logic in app-03 is dead code (targets removed HTML elements). Phase 4 cleanup candidate.

**Skip (already delegate to a shared helper — barely duplicated):** `JoinUrl`, `FindRecentRoomCode`.

## ⏳ Remaining ~7 families — TWO buckets

### Bucket A — need a BEHAVIOR DECISION (no multiplayer test needed)
- ~~**GetSessionId / Bootstrap**~~ — ✅ **DONE 2026-06-23** (see the Done table above). Unified to `huddleGetSessionId(me)`/`huddleBootstrap(me)`; `tab_` fallback kept as safety net; Mafia normalized + rebind bug fixed.
- ~~**ResetPlayers**~~ — 🗑️ **REMOVED ENTIRELY 2026-06-23** (owner decision). Briefly merged to `huddleResetPlayers(...)`, then the whole feature was deleted: Reset buttons (all 4 lobbies in index.html), the 5 reset functions, `huddleResetPlayers`, and the `lobby.reset*` i18n strings (EN+TR). Rationale: low value for an in-person game, blunt (kicks everyone), ambiguous label, and broken on Mafia (its `huddle_mafia_regenerate_room` RPC errors — likely DB drift). **Kept** `regenerateMafiaRoom` because the separate Mafia "Refresh code" button still uses it. ⚠️ NOTE: that Refresh-code button shares the same broken RPC, so it's probably also broken — separate DB-drift issue, not yet addressed.
- **StateReset** (default-state init per game) — genuinely differs (each game's default state shape is different) → leave as-is, NOT worth merging.
- ~~**Rerender**~~ — ✅ **RESOLVED 2026-06-23**: Hot/Cham/Liar already delegate to shared `huddleSyncGateRerender`; only the legitimately game-specific inner renderers remain; Mafia's is bespoke. Nothing left to merge — closed.

### Bucket B — need LIVE MULTIPLAYER verification (`npm run mp`)
- ~~**LeaveRoom**~~ — ✅ **DONE 2026-06-23** (table row 9): 3-of-4 merge to `huddleLeaveRoom(opts)`; Mafia separate. smoke 9/9 + mp 28/28.
- ~~**ConfirmUserGone**~~ — ✅ **DONE 2026-06-23** (table row 10): 3-of-4 merge to `huddleConfirmUserGone(sessionId, opts)`; Mafia separate. smoke 9/9 + mp 28/28.
`WireSync`, `AutoClaimIfNeeded` — the realtime core still left (the ONLY substantive
families remaining; `WireSync` is the biggest/hardest, do it last). Each is genuinely
divergent; merge ONE at a time and re-run `npm run mp` (28/28) + 2-phone test after each.
Do NOT merge these blind.
`LeaveRoom` is the natural next one (we were just deep in leave/sign-out logic).

## How to verify (any change)
```
npm run smoke    # expect 9/9  — app loads, functions/screens OK (never rate-limited)
npm run mp       # expect 28/28 — real 2-player multiplayer in all 4 games + leave notices
```
- `npm run mp` hits LIVE Supabase. **GOTCHA: anonymous sign-ins are rate-limited (HTTP 429).**
  Running mp many times in an hour exhausts the quota → it SKIPs or fails on auth (NOT a code bug).
  Wait ~1h to re-run cleanly. A lone 27/28 is just realtime timing — re-run once.
- **Manual (real proof):** `npx vercel --prod` (these are client changes — must redeploy),
  then on two phones at roundlly.com: join-with-code + mid-game leave in each game.

## Key facts for a new session
- App was split (Phase 1): `index.html` + `styles.css` + `app-01..10-*.js` (one global scope, load order matters — don't reorder/defer/module).
- Own git repo at the game folder. Branch `main`. Identity `huddle-dev <noncoder2@gmail.com>`.
- GitHub remote `origin = https://github.com/roundlly/roundly.git` (NOT pushed — account mismatch; backup only).
- Live site: Vercel project "huddle" → roundlly.com, deployed via `npx vercel --prod` (CLI, not GitHub).
- Tests: `smoke-test.js` (npm run smoke), `mp-test.js` (npm run mp, 28 checks).
- **DB drift is real** (Phase 4): repo `.sql` files ≠ live DB. Always probe the live DB; "defined in a .sql file" ≠ "applied."
