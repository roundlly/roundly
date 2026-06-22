-- ============================================================
-- Room sync fix — create chameleon_rooms / liar_rooms tables
-- AND apply matching RLS + realtime publication.
-- ============================================================
-- Run this once in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/dpgexpaqjrgzbwmuohcp/sql/new
--
-- Background: hotseat_rooms already exists (your Hot Seat invites work).
-- chameleon_rooms and liar_rooms were never created, so every persist call
-- has been silently failing — that's why Chameleon invites land in an
-- empty room and Liar's Cup behaves the same way.
--
-- This script is idempotent. Safe to re-run.
-- ============================================================

-- ---------- Step 1: diagnostics — does the table exist? ----------

select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
          where p.schemaname='public' and p.tablename=c.relname) as policy_count,
       exists(
         select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename=c.relname
       ) as in_realtime_publication
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('hotseat_rooms','chameleon_rooms','liar_rooms');

-- ---------- Step 2: create the tables ----------
-- Shape mirrors what the JS upserts: `code` is the primary key, `state` is
-- the JSON snapshot of the room. `updated_at` is touched by a trigger so a
-- future cleanup job can drop stale rooms.

create table if not exists public.chameleon_rooms (
  code        text primary key,
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.liar_rooms (
  code        text primary key,
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists chameleon_rooms_updated_at_idx
  on public.chameleon_rooms (updated_at desc);
create index if not exists liar_rooms_updated_at_idx
  on public.liar_rooms (updated_at desc);

-- ---------- Step 3: updated_at triggers ----------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists chameleon_rooms_touch on public.chameleon_rooms;
create trigger chameleon_rooms_touch
  before update on public.chameleon_rooms
  for each row execute function public.touch_updated_at();

drop trigger if exists liar_rooms_touch on public.liar_rooms;
create trigger liar_rooms_touch
  before update on public.liar_rooms
  for each row execute function public.touch_updated_at();

-- ---------- Step 4: enable RLS ----------

alter table public.chameleon_rooms enable row level security;
alter table public.liar_rooms      enable row level security;

-- ---------- Step 5: policies ----------
-- Rooms are short-lived shared state identified by an unguessable code. Anyone
-- signed in (anonymous or full account) can read/write — same as hotseat_rooms.

-- chameleon_rooms
drop policy if exists "chameleon_rooms_select_all" on public.chameleon_rooms;
create policy "chameleon_rooms_select_all"
  on public.chameleon_rooms for select
  to authenticated
  using (true);

drop policy if exists "chameleon_rooms_insert_all" on public.chameleon_rooms;
create policy "chameleon_rooms_insert_all"
  on public.chameleon_rooms for insert
  to authenticated
  with check (true);

drop policy if exists "chameleon_rooms_update_all" on public.chameleon_rooms;
create policy "chameleon_rooms_update_all"
  on public.chameleon_rooms for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "chameleon_rooms_delete_all" on public.chameleon_rooms;
create policy "chameleon_rooms_delete_all"
  on public.chameleon_rooms for delete
  to authenticated
  using (true);

-- liar_rooms (same pattern)
drop policy if exists "liar_rooms_select_all" on public.liar_rooms;
create policy "liar_rooms_select_all"
  on public.liar_rooms for select
  to authenticated
  using (true);

drop policy if exists "liar_rooms_insert_all" on public.liar_rooms;
create policy "liar_rooms_insert_all"
  on public.liar_rooms for insert
  to authenticated
  with check (true);

drop policy if exists "liar_rooms_update_all" on public.liar_rooms;
create policy "liar_rooms_update_all"
  on public.liar_rooms for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "liar_rooms_delete_all" on public.liar_rooms;
create policy "liar_rooms_delete_all"
  on public.liar_rooms for delete
  to authenticated
  using (true);

-- ---------- Step 6: realtime publication ----------
-- Without this, live UPDATE/INSERT events never reach the client.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='chameleon_rooms'
  ) then
    alter publication supabase_realtime add table public.chameleon_rooms;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='liar_rooms'
  ) then
    alter publication supabase_realtime add table public.liar_rooms;
  end if;
end $$;

-- ---------- Step 7: verify ----------
-- After running everything above, this should return 3 rows, each with
-- rls_enabled=t, policy_count>=3, in_realtime_publication=t.

select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
          where p.schemaname='public' and p.tablename=c.relname) as policy_count,
       exists(
         select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename=c.relname
       ) as in_realtime_publication
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('hotseat_rooms','chameleon_rooms','liar_rooms');
