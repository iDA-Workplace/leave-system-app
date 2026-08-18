-- Fix for: 員工帳號管理 → 編輯員工 → 儲存 shows "已更新使用者" (success),
-- but 部門/職稱/審核流程/管理員 never actually change in the table.
--
-- This one hides differently from the approval_flows bug: Postgres RLS
-- doesn't raise an error when an UPDATE's USING clause excludes every
-- targeted row -- it just reports success having touched 0 rows. The app
-- already went through invokeFunction('manage-users', {action:'update'})
-- for full_name/role/slack_user_id/is_active/hire_date (that edge
-- function runs with a service-role key, bypassing RLS entirely, which is
-- why those fields already save correctly and produce the success toast)
-- and then a *separate*, direct client-side
-- supabase.from('users').update(...) call for department/job_title/
-- default_flow_id/is_admin -- and that direct call is a normal
-- authenticated-role request, fully subject to RLS. There's most likely
-- no UPDATE policy on public.users letting an admin touch a *different*
-- user's row at all (only, at most, a "you can update your own row"
-- policy) -- so this update always silently affects zero rows.
--
-- Adds an UPDATE policy letting admins update any user's row. Additive
-- only -- doesn't touch or replace any existing policy (e.g. whatever
-- already lets someone update their own row from Settings).
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: guarded by an existence check.

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'users'
      and policyname = 'admins_can_update_users'
  ) then
    create policy admins_can_update_users
      on public.users for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;
end $$;
