# Phase 2 — Findings & Why the Naive Plan Is Unsafe

> Date: 2026-06-22 · Analysis only. **No game code changed.**
> Tool: `tools/analyze-dup.js` (extracts all 4 game copies of each duplicated
> function family, normalizes away game-specific names, diffs them).

## The original Phase 2 idea
"Extract ONE shared lobby/realtime engine so the copy-pasted game logic
(`liarWireSync`/`chamWireSync`/`mafiaWireSync`/`hotWireSync`, etc.) lives in one
place." This assumed the four copies are **the same code**, so merging is a safe
cut/paste like Phase 1.

## What the evidence shows
Across the 17 four-times-duplicated families, after normalizing away game-specific
identifiers:

| Result | Count | Families |
|--------|-------|----------|
| **Identical** (safe to merge) | **1** | `CancelLeaveGrace` |
| **Diverged** (NOT safe to blindly merge) | **16** | `WireSync`, `LoadRoom`, `Bootstrap`, `GetSessionId`, `StartLeaveGrace`, `ConfirmUserGone`, `SyncUrlToRoom`, `ReadUrlRoom`, `JoinUrl`, `FindRecentRoomCode`, `StateReset`, `ResetPlayers`, `ResetPresenceState`, `Rerender`, `LeaveRoom`, `AutoClaimIfNeeded` |

The divergence is **substantive, not cosmetic**. Confirmed examples:
- **`GetSessionId`** — Hot Seat & Chameleon mint a random `tab_xxxx` id; Liar & Mafia
  use the real **Supabase auth user id** (via `Bootstrap`). Same name, different identity model.
- **`Rerender`** — Hot/Cham/Liar are one-liners delegating to an already-shared helper
  `huddleSyncGateRerender(...)`; **Mafia's is a 40-line Cards-mode router**. Totally different.

## What this means
The four games **drifted apart over time** — each got fixes/tweaks the others didn't.
That drift IS the "fix one, break another" disease. But it also means:

> Merging the diverged families is **not a mechanical refactor — it is a redesign**
> that must DECIDE the correct unified behavior per family (e.g. "should Hot Seat now
> use auth ids like Liar?"). That changes behavior, and it touches **live realtime /
> presence / seat-claim code** — exactly the code the current smoke test CANNOT exercise.

## The verification gap (the real blocker)
`npm run smoke` checks page-load, function existence, and screen rendering. It does
**not** test: two players in one room, realtime sync, a player leaving (leave-grace),
seat claiming across devices, host migration. A unification bug in any of those would
**not** be caught by our current safety net — and could break the live game for real users.

## Note: a shared layer already exists
The author already began this work — there is a `huddle*` shared layer
(`huddleSyncGateRerender`, `huddleCallRPC`, `huddleConfirm`, auth helpers, …). The
direction is right; it's just incomplete, and the per-game functions diverged.

## Recommended safe path for Phase 2 (revised)
Do **not** blind-merge. Instead, lowest-risk-first:

1. **Build a 2-player multiplayer test harness FIRST** (the missing safety net):
   two headless browser sessions join one room; assert they see each other, a leave is
   detected, seat-claim works. This makes every later unification *verifiable*.
   (Caveat: it exercises the real Supabase backend, creating throwaway rooms — needs the
   owner's OK, and a cleanup step.)
2. **Then unify ONE family at a time**, behind that harness, deciding unified behavior
   deliberately and migrating one game at a time. Start with the genuinely-identical
   `CancelLeaveGrace` as the pattern, then the closest-aligned families (e.g. the
   Hot/Cham/Liar trio that already shares `huddleSyncGateRerender`), leaving Mafia
   (most diverged) for last.
3. **Manual multiplayer test by the owner** after each family: open the live site on two
   phones/tabs, play each game, confirm joining/leaving/seat-claim still work.

## Decision needed from the owner
Phase 2 is bigger and riskier than Phase 1 and cannot be fully auto-verified. Choose:
- **A (recommended):** build the multiplayer test harness first, then unify incrementally.
- **B:** merge only the 1 provably-identical family now (`CancelLeaveGrace`), tiny win, still needs a manual multiplayer sanity check.
- **C:** pause Phase 2 — keep the Phase 1 gains, revisit later.
