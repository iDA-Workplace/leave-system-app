-- Hypothesis fix for: approver clicks 核准/拒絕, a leave_approvals row is
-- recorded and a success toast shows, but leave_requests.status never
-- actually changes -- the request stays in the pending queue forever and
-- the requester's own view still shows 審核中.
--
-- This session cannot read your project's actual RLS policies (no
-- service-role key), so this is an educated guess based on the symptom,
-- not a confirmed diagnosis: Supabase silently returns zero affected rows
-- when a row-level security policy blocks an UPDATE -- it does not raise
-- an error -- which matches exactly what you saw. The most common gap is
-- a leave_requests UPDATE policy that only lets the REQUESTER modify their
-- own row (e.g. "auth.uid() = requester_id"), with nothing granting the
-- assigned approver (a different user) permission to update someone
-- else's row to move it through the flow.
--
-- The app code has just been changed to surface the real error message if
-- this migration does NOT fix it -- next attempt will show a specific
-- toast instead of a false "success", which will tell us the real cause.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: guarded by an existence check.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leave_requests'
      and policyname = 'approvers_can_update_leave_requests'
  ) then
    create policy approvers_can_update_leave_requests
      on public.leave_requests for update
      to authenticated
      using (
        -- the requester themself (withdraw, resubmit, etc. -- in case no
        -- such policy exists yet either)
        auth.uid() = requester_id
        -- the person assigned as approver for this request's current step
        or exists (
          select 1 from public.approval_flow_steps afs
          where afs.flow_id = leave_requests.flow_id
            and afs.step_order = leave_requests.current_step
            and afs.approver_id = auth.uid()
        )
        -- someone standing in for that approver today
        or exists (
          select 1 from public.approval_flow_steps afs
          join public.approval_delegates ad on ad.original_approver_id = afs.approver_id
          where afs.flow_id = leave_requests.flow_id
            and afs.step_order = leave_requests.current_step
            and ad.delegate_user_id = auth.uid()
            and ad.is_active
            and current_date between ad.start_date and ad.end_date
        )
        -- admins can always intervene
        or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin)
      )
      with check (true);
  end if;
end $$;
