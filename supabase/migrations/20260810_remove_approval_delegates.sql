-- Per user's explicit request (2026-08-07): remove 代理審核設定 (delegate
-- approval) entirely, including its database table.
--
-- IMPORTANT: the RLS policy added in
-- 20260807_approver_update_leave_requests_rls.sql references
-- approval_delegates directly inside its USING clause (the "someone
-- standing in for that approver today" branch). That must be recreated
-- WITHOUT that clause before the table is dropped -- otherwise the DROP
-- fails outright, since a policy that reads from a table counts as a
-- dependency on it.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: guarded / idempotent.

drop policy if exists approvers_can_update_leave_requests on public.leave_requests;

create policy approvers_can_update_leave_requests
  on public.leave_requests for update
  to authenticated
  using (
    -- the requester themself (withdraw, resubmit, etc.)
    auth.uid() = requester_id
    -- the person assigned as approver for this request's current step
    or exists (
      select 1 from public.approval_flow_steps afs
      where afs.flow_id = leave_requests.flow_id
        and afs.step_order = leave_requests.current_step
        and afs.approver_id = auth.uid()
    )
    -- admins can always intervene
    or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin)
  )
  with check (true);

drop table if exists public.approval_delegates;
