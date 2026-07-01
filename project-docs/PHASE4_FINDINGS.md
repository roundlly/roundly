# Phase 4 — SQL Hygiene & DB-Drift: Findings & Plan

> Date: 2026-06-23 · **Audit only. No SQL written, no DB or client changes made.**
> Method: catalogued the 27 `.sql` files + every client RPC call site, then **probed the
> LIVE Supabase DB** (never trusting the files). Probes were run as the *real* client role —
> an anonymous sign-in JWT (`role: authenticated`), the same identity the app uses — so
> results reflect what real users actually hit, not the bare `anon` key.

---

## 0. Headline (the thing that matters)

**The live database has drifted AHEAD of the repo's `.sql` files.** Several functions were
fixed directly in Supabase out-of-band, and their *current* source exists in **no `.sql`
file at all.** The practical consequences:

1. **All three originally-flagged "bugs" are NON-bugs in the live DB today.** Each was a real
   problem at some point, but the live DB already has a working version. The repo notes
   describing them were *hypotheses* ("likely DB drift", "probably also broken"), and probing
   the live DB falsifies them. This is the exact lesson the project keeps re-learning:
   **"defined in a `.sql` file" ≠ "applied", and "absent from every `.sql` file" ≠ "not applied".**
2. **The real Phase 4 problem is hygiene, not outages:** files that no longer match live,
   duplicate/superseded migrations, dead server-side RPC surface, and one *latent* ambiguous
   overload that isn't currently reachable but should be cleaned up.
3. **To produce a trustworthy consolidated migration set we need the live function _source_**
   (one read-only query, below) — because for the drifted functions the repo simply doesn't
   contain what's running.

---

## 1. Verdicts on the flagged issues (with live-probe evidence)

| # | Flagged issue | Verdict | Live-probe evidence |
|---|---------------|---------|---------------------|
| 1 | `huddle_mafia_regenerate_room` — "Refresh code" errors / never applied | **NOT a bug.** Exists & works. | Created a throwaway room `QA7X`, called `regenerate_room(p_old_code=QA7X, p_new_code=QA7Y)` → **HTTP 200**; row was renamed (a later `close_room(QA7X)` → `room_not_found`, `QA7Y` present). Live sig is `(p_old_code, p_new_code)` — **not** the file's `(p_code, p_include_detective)`. |
| 2 | `huddle_hot_handle_disconnect` — defined in no `.sql`, "silently does nothing" | **NOT a bug.** Exists & runs. | Probe with the client's exact params `(p_code, p_gone_session_id)` → `room_not_found` (executed). Client (app-01:405-407) calls it correctly. It's just **missing from the repo files** (live ahead). Same for `huddle_cham_handle_disconnect` → **HTTP 204** (ran). |
| 3 | `huddle_mafia_start_game` — multiple overloads, ambiguous | **Real, but LATENT** (not an active outage). | 1-arg call `{p_code}` → `PGRST203` ambiguous; the message dumps **exactly two** live overloads: `(p_code)` and `(p_code,p_include_detective,p_include_child,p_include_mafia_leader,p_variant)`. **However** `openMafiaLobby` forces `mafiaCardsMode=true` (app-08:405; classic mode was removed), so the client *always* sends the 5-arg form, which resolves cleanly (`room_not_found` on probe). The 1-arg path is only reachable from the known-broken `e2e-mafia-test.js`. |

**Bonus check (issue list speculated a 1/2/3/5-arg mess):** live has only **2** overloads, not four.
The stray `(p_code)` overload was re-introduced *after* `mafia_optional_roles_v2.sql` (which
explicitly drops it), almost certainly by later re-running `mafia_rules_gate.sql` /
`mafia_detective_return.sql` (both `CREATE` a `start_game(TEXT)`).

**No disconnect bug in any game.** All four exist and run: hot/liar/mafia → `room_not_found`,
cham → `204`. (mafia uses `(p_code, p_player_id)`, matching app-08:161; the others use
`(p_code, p_gone_session_id)`.)

---

## 2. Drift map — where LIVE ≠ the repo files

These are the functions whose **running definition is not** (or no longer) **in any `.sql` file**.
A consolidated migration set is *wrong* until these are reconciled against live source.

| Function | Live signature (probed) | Repo `.sql` says | Drift |
|----------|------------------------|------------------|-------|
| `huddle_mafia_regenerate_room` | `(p_old_code text, p_new_code text)` | `(p_code, p_include_detective bool)` in `mafia.sql` | **Live ahead.** File def is a different, older function. Live source in no file. |
| `huddle_hot_handle_disconnect` | `(p_code text, p_gone_session_id text)` | *(none)* | **Live ahead.** Defined in no file. |
| `huddle_cham_handle_disconnect` | exists (returned 204) | *(none)* | **Live ahead.** Defined in no file. |
| `huddle_migrate_seat` | `(p_code, p_from_session_id, p_table)` | `(p_code, p_from_seat, p_to_seat)` in `migrate_seat.sql` | **Live ahead.** Client matches live (app-03:893-897). File is stale. |
| `huddle_mafia_start_game` | 2 overloads (see §1) | 6 files redefine it; `optional_roles_v2.sql` is the canonical 5-arg | **Live has a stray extra overload.** |

> Note: a minor cosmetic quirk — `regenerate_room` renames the row key but does **not** update
> the `code` field *inside* the JSON state. The client overwrites it locally (app-08:1423), so
> it's harmless today.

---

## 3. The 27 `.sql` files — catalogue

**Keep — current/foundational (forward migration set):**
- `huddle_c2_rls.sql` — RLS bootstrap + universal RPCs (`create_room`, `claim_seat`, `leave_seat`, `close_room`, helpers). Foundation.
- `supabase-rooms-fix.sql` — creates `chameleon_rooms` / `liar_rooms` tables (+ trigger). Foundation.
- `supabase-feedback.sql` — feedback tables + trigger. Independent.
- `huddle_c2_policy_fix.sql` — drops `table_*_all` permissive policies (rls.sql's DROPs were no-ops). **Complements**, does not duplicate, policy_fix2.
- `huddle_c2_policy_fix2.sql` — drops *space-named* policies missed by policy_fix. Keep both.
- `huddle_c2_hot_lobby.sql`, `huddle_c2_hot_ingame.sql` — Hot Seat RPCs (+ lockdown DROP POLICY).
- `huddle_c2_cham.sql` — Chameleon RPCs (+ lockdown).
- `huddle_c2_liar.sql` **or** `huddle_c2_liar_ingame.sql` — **identical content; keep ONE.**
- `huddle_c2_liar_cup.sql` — cup RPCs.
- `huddle_c2_liar_wheel_spread.sql` — supersedes `start_sip` from liar_cup (deterministic spread).
- `huddle_c2_liar_anyone_can_call.sql` — supersedes `call_liar`/`after_sip` (rule change). **Apply after** liar_cup.
- `huddle_c2_liar_lockdown.sql` — `handle_disconnect`, `finish_solo` (+ dead `reset_players`) + lockdown.
- `huddle_c2_admin_stats.sql` — admin analytics + `is_admin` + admins table.
- `huddle_c2_mafia_optional_roles_v2.sql` — **canonical** `start_game` (5-arg, all defaulted) + `get_my_role`.
- `huddle_c2_mafia_rules_gate.sql` — `advance_beat` + the rules-gate `start_game(TEXT)` *(this is the stray overload — see §1)*.
- `huddle_c2_mafia_reset_to_lobby.sql` — `reset_to_lobby` (called).

**Superseded / redundant (do not include in the forward set; archive):**
- `huddle_c2_hot_ingame_SAFE.sql` — byte-identical to `hot_ingame.sql` minus the DROP POLICY; was a one-off "safe-apply" workaround. Redundant.
- `huddle_c2_liar_ingame.sql` (or `liar.sql`) — the duplicate of the pair above.
- `huddle_c2_feedback_admin.sql` — `is_admin` + admins table, **superseded by** `admin_stats.sql`.
- `huddle_c2_mafia.sql` — base Mafia; its `start_game`, `regenerate_room`, `get_my_role` are all superseded, and it carries the dead classic-engine RPCs (§4). Mostly superseded.
- `huddle_c2_mafia_detective_return.sql`, `huddle_c2_mafia_optional_roles.sql`, `huddle_c2_mafia_variant.sql` — three intermediate `start_game` signatures, all superseded by `optional_roles_v2.sql`.

**Special:**
- `huddle_c2_rollback.sql` — **emergency rollback** (re-opens RLS). Keep as a labelled break-glass script, exclude from the forward set.
- `huddle_c2_mafia_set_ready.sql` — defines `set_ready`, which the client **never calls** (§4).
- `huddle_c2_migrate_seat.sql` — **stale** (see §2); live differs.

---

## 4. Dead server-side RPC surface (defined in files, called nowhere in the client)

Verified by grepping every `app-*.js` for both literal `'name'` and the `rpcName:` variable form:

- **Classic-Mafia night engine (8):** `huddle_mafia_advance_beat`, `_mafia_kill`, `_detective_query`,
  `_doctor_save`, `_resolve_night`, `_record_vote`, `_eliminate`, `_play_again` — the old
  auto-resolved Mafia. The current game is narrator-driven ("cards"), so these are unused.
- **`huddle_mafia_set_ready`** — never called (rules-gate "ready" flow appears unwired client-side).
- **`huddle_hot_reset_players`, `huddle_cham_reset_players`, `huddle_liar_reset_players`** — the
  Reset feature was deleted in Phase 2.

> These are *harmless* while they sit in the DB (nothing calls them). Dropping them is optional
> cleanup, not a fix — and a `DROP FUNCTION` is the kind of destructive change to do deliberately,
> in its own clearly-labelled migration, only with your sign-off.

**Not dead (extractor false-positives, corrected):** `huddle_migrate_seat` (app-03:893),
`huddle_liar_handle_disconnect` (app-07:200, via `rpcName:`), and the SQL-internal helpers
(`huddle_is_claimant`, `huddle_assert_room_table`, `huddle_assert_host`, `huddle_phase_start_ms`,
`huddle_shuffle_jsonb`, `huddle_mafia_assert_narrator`, trigger fns) which are called by other
functions, not the client.

---

## 5. The blocker for a *safe* migration set

A consolidated, ordered migration set is only trustworthy if it reproduces **what's actually
running**. For the drifted functions in §2 the repo does **not** contain the live source, and
PostgREST can't dump function bodies. So step 1 must be: **you run one read-only query** in the
Supabase SQL editor and paste the output back. It changes nothing:

```sql
-- Read-only. Dumps the true source of every Huddle function in the live DB.
select p.oid::regprocedure::text                         as signature,
       pg_get_functiondef(p.oid)                         as definition
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
  and (p.proname like 'huddle\_%' or p.proname in ('is_admin','admin_stats','touch_updated_at','feedback_posts_touch'))
order  by 1;
```

A quick policy snapshot is also useful (to confirm the lockdown + that DELETE is denied, which
my probe observed on `mafia_rooms`):

```sql
select tablename, policyname, cmd, qual, with_check
from   pg_policies where schemaname = 'public' order by tablename, cmd;
```

---

## 6. Proposed plan (nothing executed — awaiting your decisions)

**Step 1 — Capture live truth (you run the read-only dump in §5; I do nothing destructive).**
Gives ground truth for the drifted functions so the migration set matches reality.

**Step 2 — Build ONE ordered, documented migration set** (`db/migrations/00xx_*.sql`) that, applied
top-to-bottom on a fresh DB, reproduces the live schema: foundation → policies → per-game RPCs →
canonical Mafia (`optional_roles_v2` + the reconciled `start_game`) → the drift-reconciled
functions from the dump. Each file gets a header (purpose, order, supersedes). I propose the
repo SQL becomes the source of truth from here on. Superseded files (§3) move to `db/archive/`.

**Step 3 — Fix the latent `start_game` ambiguity** *(safe, server-only, needs the dump to confirm
behavior)*. Likely a one-liner `DROP FUNCTION IF EXISTS public.huddle_mafia_start_game(text);`
**iff** the dump confirms the 5-arg-with-defaults body reproduces what the 1-arg body does
(the rules-gate landing). If the two bodies differ in important ways, I'll propose a single
merged canonical function instead. No client change, no redeploy. I propose the SQL; you apply it.

**Step 4 (optional) — Dead-code cleanup** (§4) in a separate, clearly-labelled migration:
`DROP` the 8 classic-engine RPCs + `set_ready` + 3 `reset_players`. Default is **leave them**
(harmless); only do this if you want a clean surface.

No client changes are needed for any of the above, so `npm run smoke` / `npm run mp` stay green
by construction. If Step 3/4 turns out to need a client tweak, I'll gate it on those tests + your
`npx vercel --prod` deploy.

---

## 7. Decisions I need from you

1. **Run the read-only dump (§5)?** It's the linchpin for an accurate migration set. (Strongly recommended.)
2. **Issue #1 (Refresh code):** it works today — so **no fix and keep the button**, correct?
   (Optional tidy-ups available: the latent client return-unwrapping in `regenerateMafiaRoom`,
   and the cosmetic internal-`code` quirk — both low priority.)
3. **Issue #3 (ambiguity):** OK to ship the safe `DROP (text)` overload fix once the dump confirms
   behavior parity?
4. **Dead code (§4):** drop the 11 unused functions, or leave them in place?
5. Housekeeping: one throwaway test room `QA7Y` (mafia_rooms, `closedByHost=true`) remains —
   Mafia RLS denies client DELETE, so it needs a one-line delete in the SQL editor if you want it gone.
```
delete from public.mafia_rooms where code = 'QA7Y';
```
