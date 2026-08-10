-- Fix for: 管理後台 → 審核流程管理 → 新增流程 fails with
--   "new row violates row-level security policy for table approval_flows"
--
-- Now that the app surfaces real Supabase errors instead of swallowing
-- them (see the 考核管理/管理後台 error-handling fixes), this is a
-- confirmed diagnosis, not a guess: approval_flows (and very likely its
-- sibling approval_flow_steps, used by 設定審核人) has RLS enabled with a
-- SELECT policy (browsing/listing flows already worked) but no INSERT
-- policy for admins -- so every insert is denied by default.
--
-- This adds INSERT/UPDATE/DELETE policies for admins on both tables. It
-- does not touch or replace any existing policy (e.g. whatever already
-- lets everyone SELECT flows to fill dropdowns) -- Postgres RLS policies
-- are OR'd together, so this can only grant additional access, never take
-- any away.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every policy is guarded by an existence check.

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flows'
      and policyname = 'admins_can_insert_approval_flows'
  ) then
    create policy admins_can_insert_approval_flows
      on public.approval_flows for insert
      to authenticated
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flows'
      and policyname = 'admins_can_update_approval_flows'
  ) then
    create policy admins_can_update_approval_flows
      on public.approval_flows for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flows'
      and policyname = 'admins_can_delete_approval_flows'
  ) then
    create policy admins_can_delete_approval_flows
      on public.approval_flows for delete
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flow_steps'
      and policyname = 'admins_can_insert_approval_flow_steps'
  ) then
    create policy admins_can_insert_approval_flow_steps
      on public.approval_flow_steps for insert
      to authenticated
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flow_steps'
      and policyname = 'admins_can_update_approval_flow_steps'
  ) then
    create policy admins_can_update_approval_flow_steps
      on public.approval_flow_steps for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'approval_flow_steps'
      and policyname = 'admins_can_delete_approval_flow_steps'
  ) then
    create policy admins_can_delete_approval_flow_steps
      on public.approval_flow_steps for delete
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;
end $$;
