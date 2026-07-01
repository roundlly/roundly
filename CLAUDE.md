# Huddle (roundlly.com) — Project Knowledge Base

This file is auto-loaded by Claude Code at the start of every session in this repo. Keep it short and stable — it's the "day one onboarding sheet," not a running log. For day-to-day status and deep dives, see `memory/` and `project-docs/` in the Obsidian vault (`C:\Users\HUWAI\ClaudeVault`).

## What this product is

Huddle is a **same-room (couch co-op) party game** — players are physically together (living room, cafe), each on their own phone, using one shared game session. It is **not** a remote/online multiplayer game.

- Login is **required for every player** (Google OAuth) — no guest/anonymous play (this reversed an earlier "no login" plan on 2026-06-27).
- Reconnect is **same-device only** — a player rejoins from the same phone they started on.
- Deployed at **roundlly.com**. OAuth is configured for that domain, not the `vercel.app` preview URL — always test on the real domain.
- **Naming:** "Huddle" is the internal codename baked into code (functions, tables, localStorage) — real users never see it. "Roundlly" is the public brand name/domain — the only name users ever see. This is intentional, not a bug; don't try to unify them (see Architecture gotcha below for why renaming internal names is risky).

## Game modes

- **Cards (Mafia)** — narrator runs a script-first teleprompter screen (redesigned 2026-06-26). Secondary info lives behind a 3-button toolbar: Who's who · Rules · How to play.
- **Hot Seat** — includes multiple mini-modes, most recently **"Guess the Theme"** (added 2026-07-01, modeled on the Sidemen/More Time "Hot Seat" YouTube format), with a "giver goes next" turn rule and an animated How-to-Play.

## Architecture gotcha — read before touching lobby code

The shared lobby engine that Mafia (and other card-based modes) runs on was originally built for Liar's Cup and named accordingly. This has **three separate layers with different rename status** — don't assume all `liar*` naming means the same thing:

1. **Backend/data layer — still `liar*` today.** Table `liar_rooms` (holds Liar's Cup AND Mafia rooms), RPCs `huddle_liar_*`, realtime channel `liar_room:`, localStorage keys `huddle.liar.*`, URL token `game=liar`. Historically treated as permanent/do-not-touch — **but that guidance was explicitly revised 2026-06-30**: with zero real players yet (pre-launch), renaming this layer is now considered acceptable *if* code+SQL are changed together in one pass; it just hasn't been prioritized. Don't assume it's untouchable dogma, but also don't rename it casually/partially — see `huddle-card-lobby-engine` in project memory before touching it.
2. **JS engine functions/state — ALREADY renamed to `cardLobby*` (done 2026-06-30).** `cardLobbyState`/`cardLobbyMe` and ~14 engine functions (`cardLobbyBootstrap`, `cardLobbyWireSync`, `cardLobbyClaimSeat`, etc., in `app-07-liar.js`/`app-08-mafia.js`/`app-09-shared-sheets-liar-cup.js`) are the actual shared-engine code — verified current in the code, not just claimed in memory. Don't be confused by the many remaining `liar*` identifiers in the same files (roughly 300+ in `app-09` alone by rough count — exact count is tool-dependent, don't cite a precise figure) — most of those are legitimately Liar's-Cup-*game* code (`openLiarLobby`, `liarStartGame`, Liar's-Cup SFX) that's correctly named, not leftover engine debt.
3. **DOM ids / CSS classes — NOT yet renamed** (`#screen-liar-lobby`, `#liar-seats`, `.liar-*`). Deferred as cosmetic/lower-priority; renaming these needs an HTML+JS+CSS lockstep pass. Fine to tackle later, not urgent.

See `huddle-card-lobby-engine` in project memory for the full reference (5-world classification of ~400 refs, exact commit hashes, adversarial-pass gotchas).

## Tech stack

- **Supabase**: Postgres + RLS + Realtime (some tables need Realtime explicitly enabled via SQL — see `db/fix/*.sql`).
- **Vercel**: `npx vercel` deploys a **preview** only; `npx vercel --prod` deploys **live** to roundlly.com. The CLI uploads local files directly — no git commit required to deploy, so deployed state and git state can drift. Always verify what's actually live.

## Golden rules (learned the hard way on this project — do not repeat)

1. **Verify before judging.** Never call something junk, dead, unused, small, quick, or safe without actually checking (grep the whole codebase, read the code). Past sessions were confidently wrong more than once, including nearly deleting a real DB tool that looked like scrap.
2. **Fix the root cause, verify in the real app.** Don't ship a symptom-patch and call it done. Trace to the actual cause, and confirm the fix works in a real browser/phone before saying "fixed" — a past invite-flow bug took two wrong patches before the real cause (Supabase re-firing `SIGNED_IN` on tab focus) was found.
3. **Be the proactive senior.** The project owner is not a programmer and reports only symptoms — it's on me to diagnose root causes and flag bigger problems unprompted, not wait to be asked. Explain plainly: what we have / options / recommendation + why, not raw technical dumps.

## Definition of Done — check EVERY item before saying "done" or "fixed"

These are the exact failure patterns from past sessions (measured across 22 sessions of chat history). Walk the list explicitly at the end of every change; if an item doesn't apply, say why in one line.

1. **Verified in the real running app** (browser preview / phone-size viewport), not assumed. For bug fixes: reproduce the bug first, fix, then confirm the symptom is actually gone.
2. **Dark mode AND light mode** both checked for any UI change.
3. **Both languages (EN + TR)** — all new user-facing text goes through i18n (`app-02-i18n.js`), and the layout is checked with the longer language.
4. **All 4 games** when touching shared code (card-lobby engine, routing, shared sheets, theme, profile): Cards/Mafia, Hot Seat, Chameleon, Liar's Cup — or state explicitly which games are untouched and why that's safe.
5. **375px phone width** — players are on phones, not desktop browsers.
6. **Refresh mid-flow** — reload the page mid-lobby/mid-game; state must restore (screen-routing checklist in project memory).
7. **SQL migrations called out LOUDLY** — if the change needs a `db/fix/*.sql`, the final summary must say "NOT live until you run X in Supabase" (deploying code does not run SQL — see below).
8. **Multi-part requests** — restate every part of what was asked at the end and confirm each one was delivered.

## Database migrations are manual — deploys do NOT apply them

Schema/RLS changes are hand-written SQL files under `db/fix/NN_*.sql`. **Deploying code (`vercel --prod`) does not run these** — they must be executed manually in the Supabase SQL editor. A feature can look fully shipped (code deployed, no errors) while silently missing its required DB change. Before saying a feature is "live," check whether it has a pending `db/fix/*.sql` that hasn't been run yet.

## Working style for this project

The project owner is not a programmer — explain plainly (what we have / options / recommendation + why), don't dump raw technical detail. Diagnose root causes proactively rather than only patching reported symptoms; verify claims in the real app/browser before saying something is fixed, don't assume.

## Where to look for more

- `memory/huddle-game/huddle-status.md` — **start here** for current build/deploy status (what's shipped vs. pending).
- `memory/huddle-game/MEMORY.md` — full index of other topic files (past decisions, bugs, pivots, system constraints).
- `project-docs/` — architecture review and phase-by-phase planning reports.

**Note on the two paths above:** `memory/huddle-game/*` is Claude Code's own project memory store (lives outside the repo, auto-loaded into context each session). `project-docs/` **is a real subfolder of this repo since 2026-07-02** (the 7 planning docs were moved there from the repo root). The Obsidian vault (`C:\Users\HUWAI\ClaudeVault`) shows both LIVE via links (junction/symlinks) — what Saeed reads there is the real file, not a copy. The one exception: `knowledge-base/` in the vault holds only a pointer note, not a live copy of this CLAUDE.md.
