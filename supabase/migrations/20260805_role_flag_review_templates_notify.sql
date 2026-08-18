-- Enterprise redesign round (per user-supplied Word spec, 2026-08-04):
-- 1. Admin becomes an overlay flag instead of a mutually-exclusive role,
--    so a user can be e.g. "員工 + 管理員" or "主管 + 管理員" at once.
-- 2. Annual review cycles can assign a different question template per
--    role (employee / supervisor / boss), so 主管 and 老闆 can have
--    different questionnaire content each year.
--
-- (核准通知對象 turned out to already exist as `notification_targets` /
-- AdminPanel's NotificationTargets screen -- no schema change needed there.)
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / guarded).

-- 1. is_admin overlay flag.
alter table public.users
  add column if not exists is_admin boolean not null default false;

comment on column public.users.is_admin is
  'Overlay permission: grants 管理後台 access regardless of the primary role column. A user keeps their primary role (employee/supervisor/deputy_supervisor/boss) and can additionally be an admin.';

-- Backfill: existing role='admin' rows had no other real role recorded,
-- so they become plain employees with the admin flag set. Whoever manages
-- 員工帳號管理 should revisit these rows afterwards and correct the primary
-- role if the person is actually a supervisor/boss who also administers.
update public.users set is_admin = true where role = 'admin';
update public.users set role = 'employee' where role = 'admin';

-- 2. Per-role review templates on a cycle.
alter table public.annual_reviews
  add column if not exists supervisor_template_id uuid references public.review_templates(id),
  add column if not exists boss_template_id uuid references public.review_templates(id);

comment on column public.annual_reviews.template_id is
  'Template used for employee self-assessment. Also the fallback for supervisor/boss when their dedicated template column below is NULL.';
comment on column public.annual_reviews.supervisor_template_id is
  'Template used for supervisor self-assessment this cycle. NULL falls back to template_id.';
comment on column public.annual_reviews.boss_template_id is
  'Template used for boss self-assessment this cycle. NULL falls back to template_id.';
