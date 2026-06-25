# Huddle database — consolidated SQL (Phase 4)

**Source of truth: the LIVE Supabase DB**, captured 2026-06-23 via a `pg_get_functiondef`
dump (64 functions) + a `pg_policies` snapshot. This replaces the ~27 ad-hoc, drifted
`.sql` files that used to live in the repo root (now in [`archive/`](archive/)).

The repo's old files had **drifted from the live DB in both directions** — some defined
functions the live DB had already replaced, and the live DB ran functions defined in *no*
file. These files were generated from what's actually running, so they match reality.
See [`../PHASE4_FINDINGS.md`](../PHASE4_FINDINGS.md) for the full audit.

## What to actually run

- **On the existing production DB:** only [`fix/00_drop_ambiguous_start_game.sql`](fix/00_drop_ambiguous_start_game.sql).
  That's the single real change Phase 4 makes — it removes a stray duplicate
  `huddle_mafia_start_game(text)` overload that makes a bare `{p_code}` call ambiguous
  (`PGRST203`). Safe, server-only, no redeploy. Everything else under `migrations/` already
  matches live (the files are `CREATE OR REPLACE`, so re-running them is a harmless no-op).

- **Guest display names (later change):** also apply [`fix/01_add_guest_name_rpc.sql`](fix/01_add_guest_name_rpc.sql)
  — adds `huddle_set_guest_name()` so no-account players' typed names show on their seats.
  Additive, idempotent (`CREATE OR REPLACE`), server-only. The app graceful-degrades until applied.

- **Mafia reconnect safety (later change):** also apply [`fix/02_mafia_disconnect_no_autoeliminate.sql`](fix/02_mafia_disconnect_no_autoeliminate.sql)
  — replaces `huddle_mafia_handle_disconnect` so a mid-game disconnect is a no-op instead of
  moving the player to `deadIds` + running a win-check that could end the game and leak roles.
  Lobby still frees the seat. Idempotent (`CREATE OR REPLACE`), server-only. The client already
  stops calling it mid-game, so the app is safe until applied.

- **Mafia narrator survives sign-in (later change):** also apply [`fix/03_migrate_narrator_uid.sql`](fix/03_migrate_narrator_uid.sql)
  — `huddle_migrate_seat` now also moves `narratorUid` (not just `claimedBy` + `hostId`) when the
  migrating session was the narrator. Without it, a host signing in with Google mid-lobby leaves
  `narratorUid` on the dead anon id → the narrator dashboard is stuck on "Loading roles…" and
  `start_game` mis-deals roles. Reproduced in `tmp/repro-mafia-signin.js`. Idempotent, server-only.

- **To rebuild from scratch** (new project / disaster recovery): run `migrations/*.sql` in
  filename order, then `fix/00`.

## Layout

```
db/
  fix/
    00_drop_ambiguous_start_game.sql   the Phase 4 change to apply to prod
    01_add_guest_name_rpc.sql          adds huddle_set_guest_name (guest display names)
    02_mafia_disconnect_no_autoeliminate.sql  disconnect no longer auto-eliminates/ends a Mafia game
    03_migrate_narrator_uid.sql        seat migration also moves narratorUid (host Google sign-in)
  migrations/                          ordered from-scratch build (reflects live)
    01_tables.sql                      tables, indexes, triggers, realtime publication
    02_helpers.sql                     is_claimant / asserts / time / shuffle / is_admin / trigger fns
    03_universal_room_rpcs.sql         create / claim / leave / close / migrate seat
    04_hotseat_rpcs.sql
    05_chameleon_rpcs.sql
    06_liar_rpcs.sql
    07_mafia_rpcs.sql                  canonical 5-arg start_game (1-arg dropped via fix/00)
    08_admin_analytics.sql             admin_stats
    09_policies.sql                    RLS enable + policies (runs last; references fns above)
  archive/                             the 27 historical hand-applied files (kept for history)
```

## Ordering / dependencies

Tables → functions → policies. Policies reference `huddle_is_claimant()` and `is_admin()`,
so `09_policies.sql` runs after `02_helpers.sql`. Function bodies (plpgsql) are not validated
against each other at create time, so `03–08` can be applied in any order among themselves.

## Known caveats (honest scope)

- **Function bodies (02–08) are byte-exact from the live dump.** `01_tables.sql` and
  `09_policies.sql` are reconstructed from the foundation files + the policy snapshot — table
  DDL was not dumped from live, so for a true from-scratch restore, verify column types and
  constraints against the live DB. (One known reconciliation: `mafia_roles.role` CHECK was
  widened to include `mafia_leader` and `child`, matching what `start_game` inserts.)
- **Dead-but-retained functions:** the classic-Mafia night engine (`advance_beat`,
  `mafia_kill`, `detective_query`, `doctor_save`, `resolve_night`, `record_vote`, `eliminate`,
  `mafia_play_again`), `mafia_set_ready`, and the three `*_reset_players` are no longer called
  by the client but are kept here because they're still live (owner chose to leave them).
- **Social subsystem** (profiles / friendships / room_invites) is out of scope — present live,
  but its table DDL isn't in this repo.

## Regenerating

The function files are produced by `tmp/build-migration-set.js` from the two CSV dumps
(`tmp/live-functions.csv`, `tmp/live-policies.csv`). To refresh after future live changes:
re-run the dump queries (in `../PHASE4_FINDINGS.md` §5), re-export the CSVs, and
`node tmp/build-migration-set.js`.
