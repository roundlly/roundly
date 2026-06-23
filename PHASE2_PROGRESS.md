# Phase 2 Progress & Handoff

> Resume point for continuing the shared-engine work in a new chat.
> Last updated: 2026-06-22. Read this first, then `PHASE2_FINDINGS.md` and `ARCHITECTURE_REVIEW.md`.

## The goal (recap)
Each of the 4 games (Hot Seat, Chameleon, Liar, Mafia) had its own copy of the same
plumbing — **17 "families" × 4 games = ~68 near-duplicate functions**. Phase 2 replaces
each set of 4 copies with **one shared `huddle*` helper**, killing the duplication that
causes "fix one bug, the others stay broken."

## ✅ Done — 6 of 17 families merged (all verified)
Shared helpers all live in `app-01-core-hotseat.js` near the top:

| # | Family | Shared helper | Verified by |
|---|--------|---------------|-------------|
| 1 | CancelLeaveGrace | `huddleCancelLeaveGrace(timers, sessionId)` | smoke + mp |
| 2 | StartLeaveGrace | `huddleStartLeaveGrace(timers, sessionId, graceMs, onConfirm)` | smoke + mp |
| 3 | ReadUrlRoom | `huddleReadUrlRoom(gameToken)` | smoke + functional |
| 4 | SyncUrlToRoom | `huddleSyncUrlToRoom(code, gameToken)` | smoke + functional |
| 5 | ResetPresenceState | `huddleResetPresenceState(timers, sessions)` | smoke + functional |
| 6 | LoadRoom (3 of 4) | `huddleFetchRoomState(table, code)` — Mafia stays separate | smoke + mp |

**Plus (not part of the 17, but related fixes this effort produced):**
- Player-left **notice parity** across all 4 games (realtime seat-vanish detection → "{name} left the game."). Hot Seat + Chameleon also return host to lobby if a mid-game room drops <2.
- Fixed 2 real production bugs: missing DB function `huddle_hot_play_again` (Hot Seat couldn't start); the leave-notification gap.

**Skip (already delegate to a shared helper — barely duplicated):** `JoinUrl`, `FindRecentRoomCode`.

## ⏳ Remaining ~9 families — TWO buckets

### Bucket A — need a BEHAVIOR DECISION (no multiplayer test needed)
- **GetSessionId / Bootstrap** — how each game IDs a player on a device.
  - Hot Seat/Chameleon historically used a random `tab_xxxx` id; Liar/Mafia used the real Supabase auth user id.
  - **BUT anonymous sign-ins are now ENABLED** (owner did this 2026-06-22), so all 4 games now get a real auth id in practice — the random fallback is effectively dead code.
  - **NEXT TASK (owner wants this):** verify all 4 games now resolve to a real auth UUID (a quick headless check: open each lobby, read `<game>GetSessionId()`, confirm it's a UUID not `tab_…`). If yes → unify to `huddleGetSessionId()` / `huddleBootstrap()` and delete the dead fallback. Verify with `npm run mp`.
- **StateReset / ResetPlayers** — each game's default state shape differs → genuinely not a mechanical merge; needs a decision on a shared shape (likely NOT worth it).
- **Rerender** — Hot/Cham/Liar already delegate to shared `huddleSyncGateRerender`; Mafia's is bespoke → little left to merge.

### Bucket B — need LIVE MULTIPLAYER verification (`npm run mp`)
`WireSync`, `LeaveRoom`, `ConfirmUserGone`, `AutoClaimIfNeeded` — these are the realtime
core. Each is genuinely divergent; merge ONE at a time and re-run `npm run mp` (28/28)
after each. Do NOT merge these blind.

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
