<!-- Produced 2026-06-27 by a multi-agent research+design+review pass (browser lifecycle,
     party-app patterns, Supabase Realtime, plus a full read of this codebase), then
     stress-tested by two adversarial reviews. This is the post-review (v2) plan. -->

# Roundlly "Full Coverage" Plan — Definitive Architecture (v2, post-review)

*Nobody gets dropped for looking at their phone.*

---

## 1. The recommendation in one paragraph

Right now Roundlly deletes a player's seat 60 seconds after their phone's live connection drops — but on a phone the connection drops the instant the screen locks, so people get kicked just for checking a text. **The fix is to stop treating "your green dot went dark" as "you left the table."** We'll keep your seat reserved for a generous window, show you as **"Away"** instead of kicking you, and snap you back in the moment your phone wakes up. The headline change is tiny and safe: raise the kick-timer from 60 seconds to 5 minutes, plus three small companion fixes that must ship in the same release so the games don't freeze when someone's away. That single release — **Phase 1** — solves the actual pain for all four games with almost no new infrastructure. Bigger, more invasive ideas (a server "last seen" heartbeat, automatic reaping of truly-abandoned seats, turn timers, a kick button) are **deferred on purpose**: both independent reviews concluded they're heavier and riskier than the plan first assumed, and aren't needed to fix the user-facing problem. Build those later, only if real complaints appear.

---

## 2. Why this happens (in plain terms)

Roundlly is a *same-room* party game: everyone's at one table, each on their own phone. While they wait their turn, people glance at a text or lock the phone and set it down. That's normal — and today it quietly drops them.

- **A locked or backgrounded phone freezes the web page.** iPhones suspend it almost instantly; Android freezes it after a few minutes.
- **When the page freezes, its live link to our server silently dies** — the phone often doesn't even notice.
- **You cannot keep that link alive on a phone.** Every trick (background workers, silent audio, "keep screen on") is blocked by Apple/Google or kills the battery. This is settled; anyone who says "just keep the socket open" is wrong about mobile.

So the drop *will* happen. The job is to make the drop **harmless**, not to prevent it. Today the app waits 60 seconds and then deletes the seat — shorter than a bathroom break. That's the bug.

---

## 3. The core principle: membership (durable) vs. presence (soft "Away")

Picture two separate things:

| Think of it as… | What it really is | How long it lasts |
|---|---|---|
| **Your SEAT** (membership) | Your spot — name, turn, role, cards. Stored in the database, keyed to your stable identity. | **Durable.** Survives lock, background, even a full restart. |
| **Your DOT** (presence) | The live "connected right now" light. | **Flickery.** Blinks off the moment your phone locks. Normal and meaningless. |

The current bug is that **the flickery dot is allowed to delete the durable seat.** The fix: *your seat is yours until you do something deliberate to give it up.* The dot can blink all night; nobody touches your seat. A dark dot just shows a gentle **"💤 Away"** badge.

You only actually leave when: **(1)** you tap **Leave**, **(2)** the host kicks you, **(3)** you're genuinely gone for a long time, or **(4)** the game ends.

---

## 4. The recommended design + when a seat is actually freed (no ghost seats)

Three changes, smallest first:

**(a) Stop the wrongful kick.** Raise the kick-timer from 60s to 5 minutes, and render an **"Away"** badge instead of a silent countdown. Because the app already rebuilds the connection and re-announces the player the instant the phone wakes (`huddleResumeActiveRoom`, shipped Phase 0), a 5-minute window means a normal lock/background never reaches the kick at all — the player is back long before it fires.

**(b) Don't let the games freeze on an away player** (see §5). Keeping people in surfaces a second problem: if the game is *waiting on* the away player, it can stall forever. Each game gets an answer, shipped in the same release.

**(c) Reap truly-abandoned seats — but honestly.** This is where both reviews pushed hard, and the design changed. See the honesty note below.

### When is a seat *actually* freed?

| Trigger | When | Status |
|---|---|---|
| Player taps **Leave** | Instantly (existing confirm dialog) | Works today |
| **Host kick** | Instantly, manual | Deferred to a later phase |
| **Game ends** | Natural cleanup | Works today |
| **Truly abandoned** (hard-kill, walked out, never came back) | After the abandonment window | See honesty note — *not* a simple timer |

### Honesty note (the thing the first plan got wrong)

The original plan reaped abandoned seats with a client "heartbeat" that writes a `last_seen` stamp every 25 seconds, then a server job that deletes any seat older than 5 minutes. **Review 1 (C1) showed this re-creates the exact bug:** the heartbeat *also* freezes when the phone locks, so `last_seen` measures "last time the screen was on," not "last time the player was alive." A 5-minute reap would then kick a phone sitting locked on the table — the 60-second bug on a longer fuse. **Review 1 (C2) showed the server job as specified can't even run**, because the disconnect routine it wanted to reuse requires a logged-in claimant, and a background server job has no such identity.

The honest conclusion both reviews converge on: **on a phone there is no signal that distinguishes "locked, still at the table" from "walked out the door."** So abandonment is *not reliably timer-detectable.* That reframes everything:

- The durable "last seen" stamp, if we build it, must be refreshed **on wake** (unlock / app-reopen / wifi-back), treated as best-effort, **not** as a 25-second interval we trust.
- The reaper must be a **purpose-built server function that runs as the database owner** (like the existing idle-room cleaner), with its own host-transfer logic — *not* the auth-gated disconnect routine.
- Because it can't tell locked-from-gone, its window must be **generous (10+ minutes)**, and the real answer to seat-squatting is the **host kick button** (a human decision), not an aggressive timer.

This is why the reap moves out of the "must-have" release and becomes an **optional later phase** (§6).

### Recommended numbers

| Setting | Today | Recommended | Why |
|---|---|---|---|
| Show "Away" badge after dot goes dark | none | **~12s** | Rides out a 2–3s wifi flap silently; table sees "Away" promptly. |
| Seat freed after live-connection loss (the kick-timer) | **60s** ❌ | **300s (5 min)** | Covers a locked phone, a TikTok detour, a bathroom trip; clears Android's own freeze point. |
| JWT/token refresh on wake | none | **before re-subscribe** | A long-backgrounded phone returns with an expired token and a dead socket; refresh first or the resume silently fails. |
| (Deferred) abandonment reap window | none | **10 min**, owner-set | Generous because it can't tell locked from gone; pair with host-kick. |

**Golden rule:** the "Away" badge must appear *well before* the kick-timer, and any abandonment reap must be *much longer* than the kick-timer. Never lengthen "keep them in" without lengthening the reap in lockstep — that gives the worst of both worlds.

---

## 5. Game-by-game (no stalls, no role leaks)

> **Iron anti-cheat rule (non-negotiable):** we **never** move a player onto someone else's seat, and **never** read a hidden role from shared data. Each phone holds only its own seat and learns only its own role, server-side. "Host can advance the game" is fine; "host can take over your seat" is forbidden — it would leak who the Mafia/Chameleon is.

**Chameleon — the critical one.** The vote only resolves when *every* seated player has voted, so one away non-voter freezes the vote **permanently** — and with a 5-minute grace that freeze gets *longer*, not shorter. **This must ship with Phase 1.** The fix has nuance the reviews exposed:
- Resolve on **present players** instead of all seated players, **but** an away player must *still be voteable* — otherwise the Chameleon can dodge the vote by locking their phone right before it (Review 1, C3). Absent ≠ un-accusable.
- Re-check the resolve condition **when a player goes away**, not only when a vote is cast — otherwise the last-vote-then-someone-leaves case still hangs (Review 1, C3-B).
- Make a **host/stand-in force-resolve + a ~60s vote timer the *primary* backstop**, not a secondary nicety.

**Liar's Cup — a hidden third kick-path.** Liar has its *own* "sole survivor" check (an ~8s + 3s poll) that declares a winner when only one player looks present. It's independent of the kick-timer, so the moment Phase 1 lands, a table where two players lock their phones for ~10s would **end the game and crown the third** while everyone's still sitting there (Review 1 H4, Review 2 Hotspot C). **This retune ships in Phase 1**, not later — raise its grace to match and gate it on real presence. Liar's existing stand-in logic is otherwise good; add the same stand-in fallback to *playing cards* so an away current player can't stall.

**Hot Seat — host/active-player stall.** If the host is away at "Next turn / Play again," everyone's stuck. **Important correction from Review 1 (H1):** a *client-side* stand-in that just drives the buttons is unsafe — the database still thinks the away host is host, so the stand-in's action can be rejected, or when the host returns you get two devices both acting as host (double-advance, stomped scores). The fix must be a **real, server-side host migration** with a deterministic rule (lowest connected seat) and a single source of truth — the returning host simply becomes a normal player. A gentle ~90s round timer can let any present player advance.

**Mafia — narrator-driven, no software turns.** An away *player* freezes nothing (badge only — already correct). The risk is the **narrator** going away. Rules:
- The narrator merely being *away* must **never** end the game; their teleprompter state is restored on return.
- A **"hand off narrator"** action is the only recovery for a genuinely-lost narrator — but the reviews found two holes (Review 1 H5): (1) if the host auto-migrated to a Mafia member, that player could hand the narrator role to themselves and read every role, so hand-off needs **explicit acceptance by the new narrator**, not silent seizure; (2) the narrator's progress lives only in the original phone's local storage, so handing off the *pointer* gives the new device a blank screen — narrator progress must be **persisted server-side** for hand-off to actually work. Because of these, hand-off is **deferred** until it can be built safely.
- Add a narrator-only **"mark player as left"** control so the human running the table can remove someone who actually walked out (Review 1 M2) — the longer grace means "Away" alone can't tell the narrator who's truly gone.

---

## 6. Phased rollout

**Phase 0 — already done this session.** Instant reconnect-on-wake (`huddleResumeActiveRoom` re-subscribes + re-announces on wake/online/back-forward cache); the `?room=` reconnect veil (commit `0398638`); stable identity on `auth.uid`; idle-whole-room janitor (`db/fix/04`). This foundation is what makes a 5-minute window actually reliable.

**Phase 1 — the one release that fixes the real pain. Effort: SMALL. Win: nobody gets kicked for locking their phone, and no game freezes because of it.** Ship these together:
1. Raise the four kick-timers 60s → 300s (four one-line edits).
2. Chameleon present-only-but-still-voteable tally + force-resolve + 60s timer (mandatory companion).
3. Liar sole-survivor poll retune (mandatory companion — else Liar self-contradicts in ~11s).
4. "Away" badge from the existing present-set, ~12s debounce (cosmetic).
5. JWT/token refresh at the top of the resume path (one line; prevents dead-socket-after-long-background).
*This is Review 2's "Minimal Phase 1" — ~80% of the benefit, almost no new infrastructure.*

**Phase 2 — anti-freeze hardening for host/active-player. Effort: MEDIUM. Win: a game never wedges when the host or current player is away.** Real server-side host migration (Hot Seat / Chameleon), play-card stand-in for Liar, narrator "mark player as left" for Mafia, optional gentle turn timers, the "about to be removed" nudge.

**Phase 3 — durable abandonment reaping (OPTIONAL). Effort: LARGE. Win: truly-abandoned seats free up automatically; no permanent ghost seats.** The wake-touch `last_seen` stamp + a purpose-built owner-run janitor with a generous (10-min) window. **Build only if real ghost-seat / capacity complaints appear** — the existing 12h whole-room cleaner already prevents permanent room buildup, and in a same-room game a ghost seat until the next round is a social problem the host-kick solves.

**Phase 4 — connection hardening + manual controls. Effort: MEDIUM.** `worker: true` + heartbeat-callback reconnect (detect a dead socket faster), host **kick** button, and safe Mafia narrator hand-off (server-side narrator progress + explicit acceptance).

---

## 7. Risks + a concrete 2-phone test plan

**Risks & edge cases:**
- **Chameleon vote deadlock (CRITICAL):** present-only tally + force-resolve **must** ship with the grace bump, with away players still voteable and a re-check on leave.
- **Liar's hidden third kick-path (CRITICAL):** retune in Phase 1 or it ends rounds for locked phones in ~11s.
- **Host-migration race (HIGH):** never use a client-only stand-in for writes that change score/phase — migrate `hostId` server-side, single source of truth.
- **Two devices / one Google account (HIGH, open decision):** same `auth.uid` on phone + tablet means "Leave" on one can free the seat the other is using. Needs a stated policy (see Decision 6).
- **"My seat vanished" on return (HIGH):** if a reaped player re-opens, route them to an explicit "your seat was given up — rejoin?" screen; never silently re-fetch a role on a seat that may have been reassigned.
- **Write amplification (MEDIUM):** if Phase 3 is built, the `last_seen` stamp must **not** live in the synced room state (20 players × 25s would storm every client and reset the idle timer); use a separate, non-broadcasting store.
- **2-player graceful-end:** with 5-minute seats, the "drop to lobby when <2 present" check should key on *present* count, not seated count, or a lone remaining player stares at a frozen game.
- **Don't break back-forward cache:** never add an `unload` handler; keep using `visibilitychange` / `pagehide` / `pageshow` only.

**2-phone test plan** (A = host, B = second player; run per game):

| # | Do on Phone B | Expected |
|---|---|---|
| 1 | Lock 10s, unlock | Never shows Away (or flickers back); seat kept; live instantly |
| 2 | Lock 2 min, unlock | Shows **"Away"** during; snaps back on unlock; seat kept; no "left" toast |
| 3 | Lock 6 min, unlock | Seat kept (Phase 1, no reaper); B resumes cleanly. *(Phase 3 only: reaped after 10 min → routed to rejoin screen, no half-dead state)* |
| 4 | TikTok 90s, back | Same as #2 |
| 5 | Wifi off 90s, then on | Offline banner; on reconnect seat kept, state refetched & correct |
| 6 | **Host (A)** locks at a host-only step | Game does **not** freeze; control migrates server-side; on A's return no double-advance |
| 7 | **Active player away** (Hot Seat guesser / Chameleon non-voter / Liar current player) | No wedge: Chameleon resolves present-only/timer (away player still voteable); Hot Seat advances; Liar stand-in plays |
| 8 | Mafia: narrator locks 2 min, returns | Game intact, teleprompter restored, no "Game ended" |
| 9 | Mafia: narrator marks a walked-out player as left | Player removed; **no role leak** |
| 10 | B taps **Leave** | Seat freed immediately + "{name} left" toast |
| 11 | Both phones lock at once, both return in grace | Both kept, both resume; no double-reap, no host confusion |
| 12 | Chameleon: Chameleon player locks phone right before vote | Still gets voted on (can't dodge by going Away) |

---

## 8. Decisions for the owner (with my recommended default)

1. **Kick-timer: 2, 5, or 10 minutes?** → **Default: 5 minutes.** Safely past every phone's background behavior; a ghost seat in a same-room lobby costs little.
2. **Add gentle turn timers on blocking steps?** → **Default: Yes**, but only Chameleon-vote and Hot-Seat-next-turn, generous and auto-advancing (Phase 2).
3. **Build the abandonment reaper (Phase 3) now, or wait for complaints?** → **Default: Wait.** It's a genuine build-new project and can't reliably tell locked from gone; the 12h whole-room cleaner + host-kick cover it.
4. **Add a host "Kick player" button?** → **Default: Yes** (Phase 4) — the right answer to seat-squatting, and the only safe fix for a public-cafe QR room.
5. **Should a cafe lobby be lockable (no new joins after seating) / join rate-limited?** → **Default: Yes, add lobby-lock** before any public-cafe pilot — a stranger scanning the QR from the sidewalk can otherwise fill a 20-seat room (Review 1 C4). Rate-limiting can wait.
6. **Two devices, one Google account: replace-the-older, or block double-join?** → **Default: "second device replaces the first"** (untrack/redirect the older one) — simplest and matches user intent.
7. **"Away" badge delay: ~12s or instant?** → **Default: ~12s** (rides out brief flaps).
8. **Mafia narrator hand-off now, or after server-side narrator progress?** → **Default: After** (Phase 4) — handing off today gives the new narrator a blank screen and risks a role leak.

---
---

## Technical Appendix (for the implementer)

### A0 — Architecture invariant
Source of truth = `<game>_rooms.state.claimedBy` keyed on stable `auth.uid` + the server-validated `huddle_claim_seat`. Presence (`leave` event) is a **soft hint only** and must never trigger durable seat removal — on mobile `leave` only fires after the server heartbeat timeout, and the frozen client can't self-report. Confirmed: `auth.uid` is stable across reconnect, which is what makes reclaim-on-return work with zero RPC change.

### A1 — Phase 1 (SMALL, low-risk; ship as one release)

**Kick-timers** — four constants `60000` → `300000`:
- `HOT_LEAVE_GRACE_MS` — `app-01-core-hotseat.js:393`
- `CHAM_LEAVE_GRACE_MS` — `app-06-chameleon.js:223`
- `LIAR_LEAVE_GRACE_MS` — `app-07-liar.js:155`
- `MAFIA_LEAVE_GRACE_MS` — `app-08-mafia.js:121`

The existing `huddleStartLeaveGrace`/`huddleConfirmUserGone` machinery (`app-01:420-461`) is unchanged in shape — only the duration. `huddleResumeActiveRoom` (`app-10:16`) already cancels the timer on wake by re-`track()`-ing, so the elected peer's `*_handle_disconnect` RPC effectively never fires for a normal background.

**Chameleon (MANDATORY companion)** — at `app-06:1089-1094` the resolve gate is `votedCount >= claimed.length`. Change to present-only, **but keep absent players voteable**, and re-evaluate on presence-leave, not only on vote-submit:
- Resolve when `votedCount >= presentClaimed.length` (present = in `_chamPresentSessions`).
- Absent players remain in the candidate/accusable set (do **not** drop them from voteable — closes the lock-phone-to-dodge cheat).
- Call the resolve check from the presence-sync/leave handler too.
- Add `CHAM_VOTE_TIMEOUT_MS = 60000` host/stand-in force-resolve firing `huddle_cham_resolve_outcome` as the primary backstop.
- Note: `resolve_outcome` is host-gated server-side — until A2 lands real host migration, gate the force-resolve on the current DB host only (don't fake a stand-in for a write).

**Liar sole-survivor poll (MANDATORY companion)** — `liarCheckIfSoleSurvivor` (`app-07:359-383`) declares a winner at `presentAlive.length === 1` gated on an ~8s grace, independent of `LIAR_LEAVE_GRACE_MS`. Raise its grace to match (or gate it on the same present/`last_seen` rule) so it can't fire on a merely-Away phone. Same file: `liarStartSoloPoll` at `app-07:348`.

**Away badge** — derive from the per-game present-set (`_hotPresentSessions` etc., `app-01:391`). In each seat render, if `sessionId ∉ presentSessions` show "💤 Away". Add a ~12s debounce (`AWAY_BADGE_DELAY_MS = 12000`) before flipping to Away. Compute on **observer** devices (Review 1 L2). Suppress the "{name} left" seat-vanish toast (`app-01:574-587`) for presence-leave; keep it only for real `claimedBy` deletions.

**JWT refresh on resume** — at the top of `huddleResumeActiveRoom` (`app-10:16`): `await sb.auth.getSession()` (refresh if needed) **before** `wireSync(true)`. Preserve the existing `<game>LoadRoom(code)` → `wireSync` ordering (`postgres_changes` does not replay missed events; the load is the required authoritative refetch).

### A2 — Phase 2 (MEDIUM): anti-freeze for host/active-player

**Real server-side host migration (do NOT use client stand-in for writes).** When the host's grace fires, the elected peer's `*_handle_disconnect` RPC already transfers host via the lowest-seat rule (`04_hotseat_rpcs.sql:205-265`) and bumps revision — make that the single source of truth. Returning host becomes a normal player (no migrate-back). Host-only RPCs continue to authorize on the *current* DB `hostId`, so there's exactly one writer and no double-fire (closes Review 1 H1 / the H11 race at `app-06:1087`).

- **Hot Seat:** `nextTurn`/`hotPlayAgain` (`app-01:1642/1972`) remain host-gated; rely on the migrated `hostId`, not a client election. Optional ~90s round timer.
- **Liar:** add the existing `liarShouldITakeAction(currentPlayerId)` gate (used at `app-07:180`) to `liarPlaySelectedCards` (`app-09:1123-1127`) so an away current player can't stall play.
- **Mafia:** add `huddle_mafia_mark_left(p_code, p_seat)` (narrator-authz; removes seat / marks dead; no role read).
- **2-player graceful-end:** `gracefulEnd` keys on `claimedBy` shrinking (`app-01:667`); re-key on **present** count so a lone remaining player isn't stuck behind 5-min seats.
- **"About to be removed" nudge:** only meaningful if Phase 3's stamp exists and is observer-visible; otherwise defer (Review 1 M4 — a frozen device can't render its own nudge).

### A3 — Phase 3 (LARGE, OPTIONAL): durable abandonment reaping

Build only on real complaints. Key corrections from review:
- **`last_seen` is wake-touched, not interval-trusted.** Refresh on `visibilitychange→visible` / `pageshow` / `online` inside `huddleResumeActiveRoom`; a 25s interval is best-effort only. A locked phone writes nothing, so the stamp ≈ "last foreground moment" (Review 1 C1) — the reaper must therefore be generous.
- **Storage off the hot path (Review 1 M1 / Review 2 Hotspot A):** put `last_seen` in a **separate column/table that does not bump `revision` and does not echo via `postgres_changes`.** Never in synced `state` JSON (20×25s would storm 20 clients and constantly reset the `db/fix/04` idle timer). Include a per-device token so one device of a shared account leaving doesn't reap the other's seat (Review 1 H2).
- **Janitor is build-new, NOT an extension of `db/fix/04`** (Review 2 decisive finding: fix/04 is whole-room, `updated_at`-driven, 12h, and pg_cron is opt-in/manual). Write a new `SECURITY DEFINER` function that runs as owner (like `huddle_cleanup_idle_rooms`), iterates rooms, prunes seats whose `last_seen` is older than the window (**10 min**, generous because it can't tell locked from gone), with **inlined** host-transfer — it **cannot** reuse `huddle_*_handle_disconnect`, which raises `not_authenticated`/`not_claimant` for a worker with no `auth.uid()` (Review 1 C2; confirmed `04_hotseat_rpcs.sql:218-230`). `revoke ... from anon, authenticated` as fix/04 does. Confirm pg_cron is enabled first.
- **Touch needs a valid JWT** (Review 1 M3): a long-backgrounded phone returns with an expired token; the first touch fails and the seat looks stale during the refresh window. Sequence on resume: refresh session → touch (retry once on `not_authenticated`) → `wireSync`.
- **"My seat vanished" handler (Review 1 H3):** on resume, if `restoreMeId` (`app-01:570`) yields null while the device believes it's seated, route to an explicit "your seat was given up — rejoin?" screen. For Mafia, never silently re-`get_my_role` on a possibly-reassigned seat.

### A4 — Phase 4 (MEDIUM): connection hardening + manual controls

- Supabase client: `realtime: { worker: true, heartbeatIntervalMs: 15000, heartbeatCallback: s => { if (s==='timeout'||s==='disconnected') sb.realtime.connect(); } }`. `worker:true` keeps heartbeats off the throttled main thread (browser-only — valid here; this is vanilla JS, not React Native). Never call `realtime.disconnect()` (suppresses auto-reconnect).
- **Host kick:** `huddle_<game>_kick_seat(p_code, p_seat)` (host-only authz), reusing the disconnect RPC's seat-removal + host-transfer body.
- **Mafia narrator hand-off (now safe):** first persist narrator stage/round **server-side** (today it's localStorage-only, `app-08:702/712`), then `huddle_mafia_handoff_narrator(p_code, p_new_seat)` moving only the `narratorUid` pointer — with **explicit acceptance by the new narrator** (don't let an auto-migrated, possibly-Mafia host seize it). New narrator fetches via existing `huddle_mafia_get_narrator_state` (already rejects non-narrators, `app-08:1138`). No reseat — preserves the anti-cheat invariant.
- **Cafe safety (Decision 5):** lobby-lock (no new joins after game start; most games already enforce this by phase) before public-QR pilots.

### A5 — Constants summary

| Constant | File:line | Old | New | Phase |
|---|---|---|---|---|
| `HOT_LEAVE_GRACE_MS` | app-01:393 | 60000 | **300000** | 1 |
| `CHAM_LEAVE_GRACE_MS` | app-06:223 | 60000 | **300000** | 1 |
| `LIAR_LEAVE_GRACE_MS` | app-07:155 | 60000 | **300000** | 1 |
| `MAFIA_LEAVE_GRACE_MS` | app-08:121 | 60000 | **300000** | 1 |
| `AWAY_BADGE_DELAY_MS` (new) | per game | — | **12000** | 1 |
| `CHAM_VOTE_TIMEOUT_MS` (new) | app-06 | — | **60000** | 1 |
| Liar solo-poll grace | app-07:348 | 8000 | **raise to ≥ kick-timer / gate on present** | 1 |
| abandonment reap window (new janitor) | db/fix (new file) | — | **600s** | 3 (optional) |
| `last_seen` wake-touch | resume path | — | **on wake only** | 3 (optional) |

### A6 — Relevant files (all absolute)
`app-01-core-hotseat.js` (grace 393, election 400-408, confirm-gone 420-461, restoreMeId ~570, seat-vanish toast 574-587, host-only turn ctrl 1642/1972, gracefulEnd 667), `app-06-chameleon.js` (resolve gate 1089-1094, grace 223, claimed 829-832), `app-07-liar.js` (stand-in 167-180, solo-poll 344-383, grace 155), `app-09-shared-sheets-liar-cup.js` (play cards 1123-1127, visibilitychange 2140), `app-08-mafia.js` (narrator/localStorage 702-712, disconnect 119-177, grace 121, narrator-state RPC 1138, game-ended overlay ~989), `app-10-boot.js` (resume 16-34, pageshow/online 49-91), `db/fix/04_cleanup_idle_rooms.sql` (whole-room only, auth-locked — do NOT extend for per-seat; model the new janitor on it), `db/migrations/04_hotseat_rpcs.sql` (disconnect RPC requires claimant `auth.uid`, 218-230; host-transfer body 205-265), `db/fix/02_*.sql` (Mafia mid-game no-op invariant to preserve).

### A7 — Unresolved by the reviews (genuine owner/engineering calls)
- **Abandonment on mobile is not reliably timer-detectable** — there is no client signal separating "locked, present" from "gone." Phase 3's reap is therefore inherently a heuristic with a generous window + host-kick as the real fix. Accept this tradeoff or don't build Phase 3.
- **Two-devices-one-account** policy (Decision 6) — no purely-technical "right" answer; pick replace-older vs. block-double-join.
- **Public-cafe abuse** (Decision 5) — lobby-lock vs. rate-limit vs. both is a product call tied to the cafe pilot timeline.
