# Phase 3 Progress & Handoff — Contain state · decouple DOM · close XSS

> Resume point for the Phase 3 refactor. Branch: `phase3-xss-dom-state`.
> Read `ARCHITECTURE_REVIEW.md` §6 first, then this. Phases 2 (client split + shared
> engine) and 4 (SQL) are COMPLETE. **No DB/SQL work happens in Phase 3.**

## The three concerns (from the architecture review)
1. **Close XSS** — route all user text through one escaping helper (the only LIVE bug).
2. **Decouple the DOM** — replace inline `onclick=` with event delegation, per screen.
3. **Contain state** — funnel writes to the 9 shared state objects through explicit update fns.

Owner-approved order: **XSS → onclick (per screen) → state (per game)**, smallest blast radius first.

## Verified foundational facts (the premise — re-confirmed against source)
- **10 files, ONE global scope, NO IIFE wrappers** (indentation is cosmetic). Loaded in numeric
  order via `<script src>` at `index.html:2565-2574`. Do NOT reorder/defer/modularize.
- Top-level `function foo(){}` → becomes `window.foo`. Top-level `const state = {…}` → global-lexical
  (reachable by name + `eval('state')`, but NOT a `window` property).
- **Public contract that must NOT be renamed/moved/closured:**
  - `smoke-test.js` checks ~40 function names exist as `window[name]` (but does NOT check any
    `onclick` points at them → **onclick wiring is invisible to smoke; hand-test on phones**).
  - `mp-test.js` reads BY NAME via `eval`: `state`, `chamState`, `liarState`, `mafiaState`,
    `mafiaMe.myId`, `_hotPresentSessions`/`_chamPresentSessions`/`_liarPresentSessions`/`_mafiaPresentSessions`,
    `hotGetSessionId`/`chamGetSessionId`/`liarGetSessionId`/`mafiaGetSessionId`, and fields
    `.claimedBy`/`.code`/`.phase`. → **These state objects + fields are PINNED.**
- **`t(key, params)` (app-02:2136) does NOT escape** — raw `str.split('{k}').join(params[k])`.
  `innerHTML = t('k', { name: userValue })` is a fresh vuln. A helper can't intercept this; only
  call-site discipline (pre-escape user params) closes it.

## Audit numbers (current post-Phase-2 split; 28-agent audit, sites re-verified by hand)
- **innerHTML: 135 sites** — 58 none / 64 low / 6 medium (already escaped) / **5 HIGH render fns**.
- **onclick: 272 inline handlers** — 205 in `index.html` (116 distinct target fns) + 67 emitted
  inside JS innerHTML strings. Only app-04 friends rows (8) splice user data into args (already
  `friendsEscape`'d).
- **state: 9 shared objects + ~75 mutable globals** (13 channel handles, 12 identity trackers,
  4 presence sets [contract], rest timers/flags). Write counts: `state` 52 (hardest — whole-object
  `Object.assign` in WireSync, runtime-added fields, cross-file writers in app-03/06), `chamState` 30,
  `mafiaState` 31, `liarState` 28 (written across app-07/08/09), `friendsState` 38, `invitesState` 30,
  feedback/admin trio 29. All have cross-file writers.

## ✅ DONE — XSS Step 1 (commit `fix(security): escape user display names…`)
The only live bug was **stored cross-user XSS via player `display_name`** (no charset validation,
only `.trim()`), interpolated raw into innerHTML at 5 sites:

| Site | Render | Fix |
|------|--------|-----|
| `app-08:899` | narrator roster row | `huddleEscape(name)` |
| `app-08:966` | role-card teammates | `.map(seatId => huddleEscape(mafiaSeatNameFor(seatId)))` |
| `app-08:1140` | lobby seat grid | `huddleEscape(mafiaSeatNameFor(seatId))` |
| `app-08:1348` | narrator picker | `huddleEscape(mafiaSeatNameFor(seatId))` |
| `app-01:1787` | hot-seat helper hero | `t('play.describeIt', { name: huddleEscape(playerDisplay.name) })` |

- Added canonical **`huddleEscape(s)`** to the shared layer (app-01, near line 150). 5-char map
  identical to `escapeHTML`/`friendsEscape` (both KEPT for now), + null-guard.
- `mafiaSeatNameFor` root cause: all 4 Mafia sites forgot the wrapper the Liar render (`app-08:2037`)
  already applies to the same value. `narratorName` (`app-08:1075`) was already safe (textContent).
- Owner decision: **escaping only** this pass (no input-validation on the save path — fast-follow later).
- Verified: **smoke 9/9, mp 28/28** + real two-phone test (profile + Mafia seat grid + Hot Seat hero all show literal `<b>…</b>`, no bold/popup).

## ✅ DONE — XSS Step 1c (commit `refactor(security): consolidate escapeHTML + friendsEscape…`)
Consolidated to ONE escaping implementation. There were three escapers with identical 5-char maps;
`escapeHTML` (app-05) and `friendsEscape` (app-04) are now one-line **aliases** of the canonical
`huddleEscape` (app-01). The ~105 existing call sites (63 + 42) are left untouched — lowest blast
radius — and now route through `huddleEscape`, including the 6 already-safe MEDIUM innerHTML sites.
Output byte-identical for real values (`escapeHTML(null)` now renders `''` not `'null'` — improvement).
The only inline `.replace` escaper chain was `friendsEscape`'s own body, so no other sites needed
changing. Verified: **smoke 9/9, mp 28/28**. (The alias names can be fully removed in a later
mechanical pass if ever desired — not necessary.)

## ✅ DONE — DOM delegation step 1: ADMIN cluster (commit `refactor(dom): convert admin screens…`)
First onclick→delegation conversion. **Established the reusable pattern** for every remaining screen:

**The engine** (app-01, folded into the EXISTING global `document` click listener at ~line 1233,
next to the pre-existing `data-go` nav delegation):
- `data-action="fnName"` + optional `data-arg="x"` → calls `window.fnName(x)` (or no-arg). One
  listener covers static AND dynamically-rendered elements, and coexists with not-yet-converted
  inline `onclick` during the migration (the branch only acts on `[data-action]` elements).
- `data-action-self` → fires only when the click lands directly on the element. Used on sheet
  backdrops; **replaces** the old inner `onclick="event.stopPropagation()"` (which had to be removed
  or it would stop the bubble before the document listener — so action buttons inside the sheet would
  die). Backdrop pattern: `<div class="sheet-backdrop" data-action="closeX" data-action-self>`.
- Runtime/typed args (e.g. `adminStatsLoad(adminStatsState.period, true)`) don't fit declarative
  `data-arg` → add a tiny zero-arg wrapper fn (`adminStatsRefresh` / `adminFeedbackRefresh`).

**Converted:** 17 static handlers (index.html admin home/feedback/stats + the 2 sheets) + 5 dynamic
(app-05 render output). Zero inline `on*` left in the admin DOM. All function names kept (smoke green).

**Verified:** smoke 9/9, mp 28/28, **`node tmp/verify-admin-delegation.js` 6/6** (drives real clicks:
`data-arg`, `goTo` wiring, both backdrop self-guards, no leftover handlers, no errors). Extend that
script per future screen — it's the only automated catch for wiring (smoke never clicks buttons).
⚠️ `goTo('admin')` is **access-gated** → admin screens only open for an owner/admin account.

## ✅ DONE — DOM delegation step 2: HOT SEAT LOBBY (commit `refactor(dom): convert Hot Seat lobby…`)
Converted screen-lobby (back/refresh/how-to/settings-toggle/leave/start), the app-01 settings render
(showInfo/setRounds/setOrder/applyRecommended/openModeSheet/openCategorySheet), and the app-03
empty-seat **invite tile**. **Gotchas found (apply to the other lobbies):**
- The invite tile is rendered from a THIRD file (app-03 `renderLobbyPlayers`), not the lobby markup —
  the verify script's leftover-scan caught it. Each game renders its own: hot=app-03:1557,
  cham=app-06:558, mafia=app-08:1111, liar=app-08:2009. The claimed-seat tile is display-only + escaped.
- `setRounds` needed `r = Number(r)` — `data-arg` is a string but the fn sets `state.rounds` + sends it
  to the RPC where the number type matters. Watch for other number/typed args per lobby.
- The QR `onerror="handleQrError()"` is left inline (load error, not a click — delegation N/A).
- **DEFERRED:** the shared Mode/Category sheets (`pickMode`/`pickCategory`) still use inline onclick
  (work via coexistence). Convert in a later sheets pass.
- Verify tool renamed `verify-admin-delegation.js` → **`tmp/verify-delegation.js`** (one section per
  screen; now 15 checks). Run it after each conversion.

## ⏳ REMAINING
- **onclick → delegation, ONE screen per PR.** Hot Seat lobby done; **next: Chameleon → Liar → Mafia
  lobbies.** ⚠️ These three differ from Hot Seat: they have **tap-to-claim seat buttons** (carry a
  seat-id arg) — the most critical multiplayer buttons, highest care, must hand-test the claim flow on
  two phones. Then: `screen-wheel-test` (lab) + liar-lab chips → the deferred Mode/Category + other
  sheets → **friends/invite rows LAST** (args carry escaped user ids; intersects XSS).
  Use the `data-action`/`data-action-self` pattern; extend `tmp/verify-delegation.js` per screen.
  **Each converted screen MUST be hand-clicked on two phones — smoke/mp never click buttons.**
- **CADENCE (owner choice 2026-06-24):** verify Hot Seat lobby + admin on real devices BEFORE
  converting the 3 seat-claim lobbies.
- **state containment (riskiest, least urgent — owner decision whether to do this cycle):** keep the
  global-lexical binding + field names verbatim (pinned by mp-test), funnel writes through explicit
  `set(patch)` fns, optional dev-only `Proxy` to assert. Order: `liarState` → `chamState` →
  `mafiaState` → `state` (last). NOTE `state` has whole-object `Object.assign(state, incoming)` in
  WireSync + runtime-added fields — a naive allowlist update fn would corrupt multiplayer.

## How to verify (any change)
```
npm run smoke   # expect 9/9   (never rate-limited)
npm run mp      # expect 28/28 (LIVE Supabase; anon sign-ins 429-limited — a lone 27/28 is a
                #               first-room timing flake, re-run once; wait ~1h if it SKIPs on auth)
```
Then deploy (`npx vercel --prod`) and hand-test on two phones at roundlly.com.
