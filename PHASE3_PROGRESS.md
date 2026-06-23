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
- Verified: **smoke 9/9, mp 28/28**.

## ⏳ REMAINING
- **XSS Step 1c (deferrable, no live bug):** point `escapeHTML`/`friendsEscape` at `huddleEscape`,
  and migrate the 6 MEDIUM (already-escaped) sites onto it. Hygiene/dedup only.
- **onclick → delegation, ONE screen per PR**, order (smallest blast radius first):
  sheet/modal backdrops → `screen-wheel-test` (12) + liar-lab chips (6) → admin screens
  (stats 6 / feedback 3) → the 4 game lobbies (5–6 each) → **friends/invite rows LAST**
  (args carry escaped user ids; intersects XSS). Pattern: one `addEventListener` on the screen
  root reading `data-action`/`data-arg`, strip that screen's inline `onclick`s only.
  **Each converted screen MUST be hand-clicked on two phones — smoke can't catch broken wiring.**
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
