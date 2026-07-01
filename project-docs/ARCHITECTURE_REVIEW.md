# Huddle — Architecture & Maintainability Review

> Date: 2026-06-22 · Scope: read-only analysis. **No code was changed.**
> Every claim below is backed by a measurement from the actual codebase, not an assumption.

---

## 1. What the project actually is (measured)

| Fact | Value | How measured |
|------|-------|--------------|
| Whole app lives in one file | `index.html` | directory listing |
| Size of that file | **1,297,973 bytes (~1.3 MB), 24,336 lines** | `wc -l` |
| CSS (one `<style>` block) | lines **228–6285** (~6,000 lines) | tag scan |
| HTML markup | lines **6285–8624** (~2,300 lines) | tag scan |
| JavaScript (one `<script>` block) | lines **8624–24334** (~15,700 lines) | tag scan |
| Functions in that script | **600** | `grep -c "function "` |
| Top-level globals | **175** (93 mutable `let`/`var`) | grep |
| Inline `onclick=` handlers | **269** | grep |
| `innerHTML` assignments | **139** | grep |
| `getElementById` calls | **434** | grep |
| Realtime channel references | **142** | grep |
| Build step / bundler / modules | **none** — raw inline script, everything in one global scope | `package.json` (only puppeteer/ffmpeg tooling) |
| Automated tests | **1** (`e2e-mafia-test.js`, known-broken per project notes) | dir scan |
| Git history | **0 commits** ("branch master does not have any commits yet") | `git log` |

**Architecture in one sentence:** a single 24k-line HTML file containing ~15,700 lines of
browser JavaScript in one global scope, with no modules, no build step, no version history,
and effectively no automated tests — backed by ~30 hand-applied Supabase SQL migration files.

---

## 2. The three structural facts that cause "fix one bug, break another"

### 2.1 Copy-paste game engines (the #1 regression driver)

Each of the four games (Liar, Chameleon, Mafia, Hot Seat) has its **own near-identical copy**
of the same plumbing. Measured by counting same-verb / different-prefix functions:

```
4× WireSync         4× SyncUrlToRoom    4× StateReset       4× StartLeaveGrace
4× ResetPresenceState  4× ResetPlayers  4× Rerender         4× ReadUrlRoom
4× LoadRoom         4× LeaveRoom        4× JoinUrl          4× GetSessionId
4× FindRecentRoomCode  4× ConfirmUserGone  4× CancelLeaveGrace  4× Bootstrap
4× AutoClaimIfNeeded   3× StartGame     3× ClaimSeat        3× CloseRoom  … (and more)
```

So `liarWireSync`, `chamWireSync`, `mafiaWireSync`, `hotWireSync` are four hand-maintained
copies of the same realtime-sync logic. Same for presence, leave-grace, seat-claiming, room
loading, etc.

**Why this breaks things:** when you fix a presence/disconnect/seat bug in one game, the same
bug almost always exists in the other three copies. You must remember to patch all four — and
patch them *identically*. Miss one, or fix it slightly differently, and the games silently
diverge. This is textbook **shotgun surgery**: one logical change requires many scattered edits,
and the cost of forgetting is a new bug somewhere you weren't looking.

### 2.2 Many large mutable singletons in one shared scope

There are **9 separate mutable global state objects** living in the same scope, each touched by
dozens of functions:

```
liarState  (255 refs)   chamState (178)   friendsState (100)   mafiaState (75)
invitesState (65)       feedbackState (44)  adminFeedbackState (34)  adminStatsState (26)
state (the Hot-Seat/core object, 225 refs)
```

Plus 93 other mutable top-level `let`/`var` (timers, channel handles, debounce flags like
`_hotChannel`, `friendsSearchTimer`, `huddleUsernameDebounce`, `howtoTimer`, …).

**Why this breaks things:** any of 600 functions can read or write any of these globals. There
is no boundary that says "only the lobby code touches lobby state." A change to how `state.phase`
or a `_xxxChannel` handle is managed can have effects in code you never opened. Debugging means
asking "who else writes this?" across 15,700 lines.

### 2.3 HTML, behavior, and data are welded together

- **269 inline `onclick="someGlobalFn()"`** strings hard-wire markup to global function *names*.
  Rename or move a function and the button silently dies — no compiler, no test catches it.
- **139 `innerHTML =` assignments** rebuild UI from strings, mixing rendering, escaping, and
  logic. This is both a maintenance hazard and an **XSS exposure** anywhere user-supplied text
  (names, chat, feedback) is interpolated without escaping.
- **434 `getElementById`** calls reach directly into the DOM from anywhere, so render code and
  state code are not separable.

**Why this breaks things:** there is no seam between "what the data is" and "what the screen
shows." A change to a render string can change behavior; a change to logic can break a screen,
and nothing flags it until a human clicks the exact button on the exact screen.

---

## 3. Biggest maintainability risks (ranked)

| # | Risk | Severity | Evidence |
|---|------|----------|----------|
| 1 | **Quadrupled game logic** — 17+ function families copied 4× across games | CRITICAL | function-family scan above |
| 2 | **No version control history** — 0 commits, so no diff/blame/bisect/rollback safety net | CRITICAL | `git log` |
| 3 | **No automated test net** — the one e2e test is broken; every fix is verified by hand | CRITICAL | dir scan + project notes |
| 4 | **One 24k-line file** — exceeds editor/tooling/your-own-working-memory limits; merge-hostile | HIGH | `wc -l` |
| 5 | **175 globals / 9 shared singletons** — no module boundaries, unbounded blast radius | HIGH | grep |
| 6 | **269 inline onclick + 139 innerHTML** — refactor-fragile wiring + XSS surface | HIGH | grep |
| 7 | **~30 ad-hoc SQL files** with `policy_fix`/`policy_fix2`, `optional_roles`/`_v2`, plus several the client no longer calls (dead server-side surface) | MEDIUM | dir listing + project notes |

---

## 4. Highest-coupling / highest-regression-risk areas (where to be most careful)

1. **The realtime/presence/seat layer** (`*WireSync`, `*StartLeaveGrace`, `*ConfirmUserGone`,
   `*ClaimSeat`, the `_*Channel` handles). 142 channel references, duplicated 4×. This is where
   "fixed disconnect in Liar, Mafia still drops players" lives.
2. **The screen dispatcher / `goTo` flow** (68 references) feeding one shared `state.phase`/`view`.
   Routing for all games funnels through shared paths, so a routing tweak for one game can
   re-route another.
3. **`state` + the per-game `*State` singletons** — the most-referenced symbols in the file;
   any change here is felt widely.
4. **Auth + seat-migration lifecycle** (already flagged in project notes as having had 5 coupled
   bugs) — sign-in/out, anon→Google migration, and lobby openers must stay in lockstep by hand.

---

## 5. What specifically makes future bug fixes difficult

1. **A fix is rarely local.** Because logic is copied per game, the "real" fix is 4 edits, not 1.
   Nothing tells you the other 3 copies exist or that they drifted.
2. **No blast-radius containment.** With 175 globals and 9 shared state objects in one scope, any
   function can affect any other. You cannot reason about a change from the change alone.
3. **No safety net to catch the breakage.** No tests + no git history = the only detector is you
   manually clicking, and the only undo is manual. A regression introduced today may surface days
   later with no diff to inspect.
4. **The file is too big to hold in working memory** (yours or any tool's). Finding "the other
   place this happens" is a 15,700-line search every time.
5. **Editing markup is risky** because 269 buttons depend on exact global function names and 139
   render sites mix logic into strings — rename-safety and find-all-references don't exist.

**Net:** the structure *itself* is the dominant cause of the regressions you're seeing. This is
not primarily a "write more careful code" problem; it's that the architecture gives every change
a large, invisible blast radius and removes every automatic way to catch the fallout.

---

## 6. Recommended plan (proposed — nothing executed yet)

Sequenced so each step *reduces* regression risk before the next, lowest-risk-first. Steps 0–2
are reversible safety nets that change **no behavior**.

**Phase 0 — Safety nets first (no code logic changes)**
- Initialize git history: make a first commit of the current working app so there is a baseline to
  diff against and roll back to. (Highest value, near-zero risk.)
- Add a tiny smoke checklist or revive a minimal e2e path (load app → open each game lobby →
  claim seat → start) so future changes have *something* automatic catching breakage.

**Phase 1 — Make the file navigable without changing behavior**
- Split the single `<script>` into multiple files by concern (core/state, realtime, each game,
  profile/auth, admin) loaded as ES modules, OR extract them into separate `.js` files referenced
  from the page. Pure cut/paste + import wiring; no logic rewrite. This alone makes "find the
  other 3 copies" trivial and shrinks the working set per task.
- Do the same for CSS (split the 6k-line style block by feature).

**Phase 2 — Kill the quadruplication (the actual cure for cross-game regressions)**
- Extract ONE shared realtime/lobby engine (sync, presence, leave-grace, seat-claim, room load)
  and have all four games call it with a small per-game config. Migrate one game at a time,
  verifying after each, so a fix lives in exactly one place from then on.

**Phase 3 — Contain state and decouple the DOM**
- Wrap each game's state behind a small module with explicit update functions (no more "any
  function writes any global").
- Replace inline `onclick=` with event delegation / `addEventListener`, and route user text
  through a single escaping helper to close the `innerHTML` XSS gaps.

**Phase 4 — SQL hygiene**
- Catalog the ~30 SQL files, mark which are superseded/dead (e.g. `policy_fix` vs `policy_fix2`,
  classic-Mafia RPCs no longer called), and consolidate into an ordered, documented migration set.

Each phase is independently shippable and each *lowers* the chance that the next fix breaks
something. I recommend doing Phase 0 immediately regardless of what else you decide.

---

## 7. Approval gate

Per your instruction, **I have not changed any code.** Awaiting your decision on:
1. Whether the diagnosis matches what you're experiencing.
2. Which phase(s) to proceed with, and in what order.
3. Whether to start with Phase 0 (git baseline + smoke test) as a no-risk first step.
