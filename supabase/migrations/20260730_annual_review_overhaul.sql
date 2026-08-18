-- Epic H: Annual review overhaul (docs/design/phase1-foundation.md §1.2,
-- Epic H, flow 3.7; docs/design/phase2-screens.md B18-B22).
--
-- This is the schema this overhaul's frontend depends on. It does not exist
-- in the live database yet -- run this once, by hand, in the Supabase
-- Dashboard's SQL Editor (Project > SQL Editor > New query), BEFORE the new
-- /review/* and /admin/reviews/* screens are deployed. Until it's applied,
-- those screens will error on the columns added below.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / guarded).

-- 1. Direct-manager link on users.
--    Gap: batch-adding review participants needs to auto-resolve "this
--    person's manager" from data. Today the only related data is
--    approval_flow_steps, which encodes "who signs off this person's leave
--    requests" -- a different relationship that doesn't reliably answer
--    "who is this person's manager" (e.g. a flow can route to a director
--    two levels up, or to HR, not to the immediate manager).
alter table public.users
  add column if not exists manager_id uuid references public.users(id);

comment on column public.users.manager_id is
  'Direct supervisor for org-chart purposes. Distinct from approval_flow_steps (who signs off leave requests). Used by the annual review bulk-participant auto-match (B20).';

-- 2. Per-cycle deadlines, separate from the review's overall start_date/end_date span.
alter table public.annual_reviews
  add column if not exists self_assessment_deadline date,
  add column if not exists evaluation_deadline date;

comment on column public.annual_reviews.self_assessment_deadline is
  'Deadline for employees to submit their self-assessment (B18). NULL = no separate deadline, falls back to end_date.';
comment on column public.annual_reviews.evaluation_deadline is
  'Deadline for supervisors to submit their evaluation (B19). NULL = no separate deadline, falls back to end_date.';

-- 3. Governance state machine on participants: calibration -> publish -> ack.
--    Gap (see phase1-foundation.md 1.2): evaluator submits and the result was
--    instantly visible to the employee, with no HR calibration or formal
--    release step. These columns add that gate.
alter table public.annual_review_participants
  add column if not exists calibration_status text not null default 'pending',
  add column if not exists calibration_note text,
  add column if not exists published_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists has_dispute boolean not null default false,
  add column if not exists dispute_comment text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'annual_review_participants_calibration_status_check'
  ) then
    alter table public.annual_review_participants
      add constraint annual_review_participants_calibration_status_check
      check (calibration_status in ('pending', 'calibrated', 'returned'));
  end if;
end $$;

comment on column public.annual_review_participants.calibration_status is
  'pending = no evaluation yet, or evaluator submitted and awaiting HR calibration. calibrated = HR reviewed, eligible to publish. returned = HR sent back to the evaluator for changes (see calibration_note).';
comment on column public.annual_review_participants.published_at is
  'Set by HR when the result is formally released to the employee (B22). The employee must not see evaluator scores/comments before this is set (B18) -- enforce in the query layer / RLS, not just the UI.';
comment on column public.annual_review_participants.acknowledged_at is
  'Set when the employee clicks "confirm read" on a published result (B18).';
comment on column public.annual_review_participants.has_dispute is
  'Employee flagged the published result as disputed (B18); calibration_note / dispute_comment carries the reason, does not change scores.';
