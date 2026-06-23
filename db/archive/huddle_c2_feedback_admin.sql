-- ============================================================
-- Feedback admin — admins table, is_admin() gate, post status,
-- and RLS policies that let admins update/delete any post.
-- ============================================================
-- Run this once in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/dpgexpaqjrgzbwmuohcp/sql/new
-- All statements are idempotent — safe to re-run.
-- ============================================================

-- ---------- 1. Admins table ----------
-- Email-keyed (not user_id-keyed) so we can add an admin BEFORE they ever
-- sign in. The is_admin() function resolves the current user's email at
-- query time, so this stays correct even if the user's auth.users.id
-- changes (re-sign-up, etc).

create table if not exists public.admins (
  email      text primary key,
  added_at   timestamptz not null default now()
);

insert into public.admins(email)
values ('saeedabdulaziz132@gmail.com')
on conflict (email) do nothing;

-- Lock the admins table down — only the SECURITY DEFINER function reads it.
alter table public.admins enable row level security;
-- No SELECT policy = nobody can read it from client. Intentional.

-- ---------- 2. is_admin() function ----------
-- SECURITY DEFINER so it can read auth.users (clients can't directly).
-- STABLE so Postgres can cache its result inside one query — important
-- because RLS evaluates this on every row.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.admins a
    join auth.users   u on lower(u.email) = lower(a.email)
    where u.id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------- 3. Feedback post status columns ----------

alter table public.feedback_posts
  add column if not exists status text not null default 'new'
    check (status in ('new','done'));

alter table public.feedback_posts
  add column if not exists admin_actioned_at timestamptz;

-- Index so the admin board can filter+sort by status quickly.
create index if not exists feedback_posts_status_created_idx
  on public.feedback_posts (status, created_at desc);

-- ---------- 4. RLS policies for admin moderation ----------
-- These are ADDITIONAL policies — the existing user policies (insert own,
-- update own, delete own) still apply. Postgres OR-merges policies of the
-- same command type, so an admin satisfies UPDATE/DELETE either way.

-- Admin can update ANY post (status flips, future admin metadata).
drop policy if exists "feedback_posts_admin_update" on public.feedback_posts;
create policy "feedback_posts_admin_update"
  on public.feedback_posts for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Admin can delete ANY post (spam, abuse).
drop policy if exists "feedback_posts_admin_delete" on public.feedback_posts;
create policy "feedback_posts_admin_delete"
  on public.feedback_posts for delete
  to authenticated
  using (public.is_admin());

-- Admin can read all posts — already covered by the existing
-- "feedback_posts_select_all" policy (authenticated users read all).
-- No new SELECT policy needed.

-- ---------- 5. Sanity check ----------
-- Uncomment and run separately to verify the gate works for your account.
-- After you sign in once with saeedabdulaziz132@gmail.com, this should
-- return true. Anyone else gets false.
--
--   select public.is_admin();
