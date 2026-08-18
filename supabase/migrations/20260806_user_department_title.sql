-- The Word-spec's 年度自評 screen requires showing 姓名/職稱/入職日/部門/評核年度
-- for the person being assessed. 職稱 (job title) and 部門 (department) don't
-- exist as columns anywhere yet -- this adds them as plain nullable text so
-- 員工帳號管理 can capture them and the review screens can display them.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor (same as the
-- other files in this folder). Safe to re-run.

alter table public.users
  add column if not exists department text,
  add column if not exists job_title text;

comment on column public.users.department is '部門, free text, set via 員工帳號管理.';
comment on column public.users.job_title is '職稱, free text, set via 員工帳號管理.';
