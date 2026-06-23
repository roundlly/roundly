-- ============================================================
-- Feedback board — shared posts + voting
-- ============================================================
-- Run this once in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/dpgexpaqjrgzbwmuohcp/sql/new
-- All statements are idempotent (`if not exists`, `or replace`, etc.)
-- so re-running this script is safe.
-- ============================================================

-- ---------- Tables ----------

create table if not exists public.feedback_posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  category    text not null check (category in ('bug','idea','word','other')),
  text        text not null check (char_length(text) > 0 and char_length(text) <= 500),
  lang        text not null default 'en',
  edited      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists feedback_posts_category_created_idx
  on public.feedback_posts (category, created_at desc);
create index if not exists feedback_posts_user_id_idx
  on public.feedback_posts (user_id);

create table if not exists public.feedback_votes (
  post_id     uuid not null references public.feedback_posts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists feedback_votes_user_id_idx
  on public.feedback_votes (user_id);

-- ---------- updated_at trigger ----------

create or replace function public.feedback_posts_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists feedback_posts_touch on public.feedback_posts;
create trigger feedback_posts_touch
  before update on public.feedback_posts
  for each row execute function public.feedback_posts_touch();

-- ---------- Row Level Security ----------

alter table public.feedback_posts enable row level security;
alter table public.feedback_votes enable row level security;

-- Posts: every signed-in user (including anonymous) can read all posts.
drop policy if exists "feedback_posts_select_all" on public.feedback_posts;
create policy "feedback_posts_select_all"
  on public.feedback_posts for select
  to authenticated
  using (true);

-- Posts: you can insert only rows that belong to you.
drop policy if exists "feedback_posts_insert_own" on public.feedback_posts;
create policy "feedback_posts_insert_own"
  on public.feedback_posts for insert
  to authenticated
  with check (user_id = auth.uid());

-- Posts: you can edit only your own posts (and cannot change the owner).
drop policy if exists "feedback_posts_update_own" on public.feedback_posts;
create policy "feedback_posts_update_own"
  on public.feedback_posts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Posts: you can delete only your own posts.
drop policy if exists "feedback_posts_delete_own" on public.feedback_posts;
create policy "feedback_posts_delete_own"
  on public.feedback_posts for delete
  to authenticated
  using (user_id = auth.uid());

-- Votes: everyone can read so we can show counts.
drop policy if exists "feedback_votes_select_all" on public.feedback_votes;
create policy "feedback_votes_select_all"
  on public.feedback_votes for select
  to authenticated
  using (true);

-- Votes: you can insert only rows that belong to you.
drop policy if exists "feedback_votes_insert_own" on public.feedback_votes;
create policy "feedback_votes_insert_own"
  on public.feedback_votes for insert
  to authenticated
  with check (user_id = auth.uid());

-- Votes: you can delete only your own votes (used for "unlike").
drop policy if exists "feedback_votes_delete_own" on public.feedback_votes;
create policy "feedback_votes_delete_own"
  on public.feedback_votes for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------- Realtime ----------
-- Add both tables to the supabase_realtime publication so the client gets
-- live INSERT/UPDATE/DELETE events. Wrapped in DO blocks because `add table`
-- errors if the table is already in the publication — re-runs stay clean.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feedback_posts'
  ) then
    alter publication supabase_realtime add table public.feedback_posts;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feedback_votes'
  ) then
    alter publication supabase_realtime add table public.feedback_votes;
  end if;
end $$;
