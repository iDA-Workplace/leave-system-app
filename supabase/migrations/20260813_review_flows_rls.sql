-- Fix for: 部門考核設定 → 考核流程 → 新增流程 fails with
--   "new row violates row-level security policy for table review_flows"
--
-- review_flows and review_flow_steps are brand-new tables (created in
-- 20260809_review_flows_and_scoring.sql) that never got any RLS policies
-- at all -- unlike the older review_* tables (review_templates,
-- annual_reviews, etc.) which already worked because they've existed
-- since before this project's session and already had working policies.
-- With RLS enabled and zero policies, every operation is denied by
-- default, which matches the symptom exactly.
--
-- Unlike approval_flows (admin-only), 部門考核設定 is available to any
-- supervisor/deputy_supervisor/boss (see EVALUATOR_ROLES in Review.jsx),
-- not just users flagged is_admin -- so the write policies here check
-- role membership instead. SELECT is open to any authenticated user,
-- since every employee's own 年度自評/考核結果 screens need to resolve
-- their department's flow regardless of their role.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every policy is guarded by an existence check.

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flows'
      and policyname = 'anyone_can_select_review_flows'
  ) then
    create policy anyone_can_select_review_flows
      on public.review_flows for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flows'
      and policyname = 'evaluators_can_write_review_flows'
  ) then
    create policy evaluators_can_write_review_flows
      on public.review_flows for insert
      to authenticated
      with check (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flows'
      and policyname = 'evaluators_can_update_review_flows'
  ) then
    create policy evaluators_can_update_review_flows
      on public.review_flows for update
      to authenticated
      using (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ))
      with check (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flows'
      and policyname = 'evaluators_can_delete_review_flows'
  ) then
    create policy evaluators_can_delete_review_flows
      on public.review_flows for delete
      to authenticated
      using (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flow_steps'
      and policyname = 'anyone_can_select_review_flow_steps'
  ) then
    create policy anyone_can_select_review_flow_steps
      on public.review_flow_steps for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flow_steps'
      and policyname = 'evaluators_can_write_review_flow_steps'
  ) then
    create policy evaluators_can_write_review_flow_steps
      on public.review_flow_steps for insert
      to authenticated
      with check (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flow_steps'
      and policyname = 'evaluators_can_update_review_flow_steps'
  ) then
    create policy evaluators_can_update_review_flow_steps
      on public.review_flow_steps for update
      to authenticated
      using (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ))
      with check (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'review_flow_steps'
      and policyname = 'evaluators_can_delete_review_flow_steps'
  ) then
    create policy evaluators_can_delete_review_flow_steps
      on public.review_flow_steps for delete
      to authenticated
      using (exists (
        select 1 from public.users u where u.id = auth.uid()
          and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
      ));
  end if;
end $$;
