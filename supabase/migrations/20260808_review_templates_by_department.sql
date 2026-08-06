-- Annual review redesign (per user request, 2026-08-06): question sets are
-- now scoped by department instead of role, and the whole HR
-- calibration/publish governance layer is removed -- supervisors/boss now
-- fully own their department's review process (editing questions, setting
-- the review period, scoring employees) with no admin gate in between.
--
-- This migration only adds the new department column; it does NOT drop
-- the old calibration_status/published_at/acknowledged_at/has_dispute/
-- dispute_comment columns on annual_review_participants, or the
-- supervisor_template_id/boss_template_id columns on annual_reviews --
-- those are simply no longer read or written by the app going forward.
-- Leaving them in place is harmless and avoids a destructive migration.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / guarded).

alter table public.review_templates
  add column if not exists department text;

comment on column public.review_templates.department is
  '部門 (matches users.department). NULL = 全公司預設模板, used as the fallback when a participant''s department has no dedicated template.';
