-- Per user's confirmed design (2026-08-11): a dedicated 財務 permission
-- that owns 假期額度 + 入職日期, separate from 管理員 (who keeps the
-- system settings: 帳號/角色/審核流程/通知對象).
--
-- 1. users.is_finance -- an independent permission flag, exactly like
--    is_admin, so it can overlap with any role and be granted to more
--    than one person later. Set by admins in 員工帳號管理.
-- 2. user_leave_entitlements -- per-employee, per-leave-type quota.
--    mode = 'statutory' means "比照勞基法" (fall back to the company
--    default: annual_leave_summary for 特休, leave_types.annual_quota_hours
--    for everything else). mode = 'manual' means finance typed an explicit
--    number in quota_hours, which overrides the computed/default value.
--    Rows only exist for employees finance has actually touched -- absence
--    of a row is equivalent to 'statutory'.
--
-- UNITS: quota_hours is always HOURS, for every leave type. Leave usage is
-- already accumulated in hours everywhere in the app (same-day leave records
-- `hours` directly; multi-day leave is counted as workdays x 8), so hours is
-- the only unit that never needs converting at comparison time. The UI still
-- *inputs and displays* 特休 in days (labour law speaks in days) and converts
-- at the edge using the same 8-hour day the rest of the app assumes.
--
-- NOTE on confidentiality: the user accepted (choice "b-1") that hiding
-- users.hire_date from admins is UI-level only -- it stays on public.users,
-- so an admin could still read it through the API. This new table, being
-- new, IS properly locked down at the database level: only finance (and
-- each employee for their own row) can read it; admins cannot.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every statement is idempotent / guarded.

alter table public.users
  add column if not exists is_finance boolean not null default false;
comment on column public.users.is_finance is
  '財務權限：可管理員工假期額度與入職日期，並可匯出報表。與 is_admin 相互獨立、可同時成立。';

create table if not exists public.user_leave_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  mode text not null default 'statutory',
  quota_hours numeric,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id),
  unique (user_id, leave_type_id)
);
comment on table public.user_leave_entitlements is
  '個別員工談定的假期額度。沒有資料列 = 比照勞基法/公司預設。';
comment on column public.user_leave_entitlements.mode is
  '''statutory'' = 比照勞基法（用公司預設值）; ''manual'' = 用 quota_hours 的手動數字覆蓋。';
comment on column public.user_leave_entitlements.quota_hours is
  '手動額度，單位一律為「小時」（特休在畫面上以天顯示/輸入，存檔時 x8 換算）。mode = statutory 時為 NULL。';

alter table public.user_leave_entitlements enable row level security;

do $$
begin
  -- Finance manages everyone's entitlements. Admins are deliberately NOT
  -- granted access here -- that's the whole point of splitting the role.
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_leave_entitlements'
      and policyname = 'finance_can_manage_entitlements'
  ) then
    create policy finance_can_manage_entitlements
      on public.user_leave_entitlements for all
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance));
  end if;

  -- Every employee can read their OWN entitlement, so their 假單管理 /
  -- 請假申請 balance panels can show the agreed quota rather than the
  -- company default. Read-only: they cannot change their own quota.
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_leave_entitlements'
      and policyname = 'users_can_read_own_entitlements'
  ) then
    create policy users_can_read_own_entitlements
      on public.user_leave_entitlements for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- 全公司預設額度 (leave_types.annual_quota_hours) moves from 管理後台's
-- 假別管理 tab into finance's 員工假期管理 screen, so finance needs write
-- access to leave_types. Additive -- existing read policies are untouched.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'leave_types'
      and policyname = 'finance_can_update_leave_types'
  ) then
    create policy finance_can_update_leave_types
      on public.leave_types for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance));
  end if;

  -- Finance edits 入職日期, which lives on public.users.
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'users'
      and policyname = 'finance_can_update_users'
  ) then
    create policy finance_can_update_users
      on public.users for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance));
  end if;
end $$;
