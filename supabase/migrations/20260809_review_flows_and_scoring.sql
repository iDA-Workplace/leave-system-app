-- Per user's final confirmation (2026-08-07), on top of the 20260808 migration:
--
-- 1. Annual review evaluation now runs through a configurable multi-step
--    approval-style chain, exactly like leave requests' approval_flows /
--    approval_flow_steps -- except configured by each department's
--    supervisor/boss in 部門考核設定 (NOT the admin backend), and each step's
--    evaluator can be any specific person (not restricted to a role label).
-- 2. Score questions now carry a "相關事例" (example/reasoning) free-text note
--    alongside the numeric score, filled in by whoever assigns that score
--    (the employee on self-assessment, each evaluator on their step).
--    "差距分析" (gap analysis) from the old spreadsheet was explicitly
--    dropped -- not implemented.
-- 3. Final score is normalised to 0-100 (previously the old spreadsheet used
--    a fixed "sum of 12 questions ÷ 1.2" formula; generalised here to
--    100 x score / (score-question count x 10) so it still works with
--    departments' free-form question counts).
-- 4. users.english_name added -- admin-managed like the other 員工資訊 fields.
--
-- Run once, by hand, in the Supabase Dashboard's SQL Editor.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / guarded).

alter table public.users
  add column if not exists english_name text;

create table if not exists public.review_flows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);
comment on column public.review_flows.department is
  '部門 (matches users.department). NULL = 全公司預設流程, used as the fallback when a participant''s department has no dedicated flow.';

create table if not exists public.review_flow_steps (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.review_flows(id) on delete cascade,
  step_order int not null,
  evaluator_id uuid references public.users(id),
  unique (flow_id, step_order)
);

alter table public.annual_review_participants
  add column if not exists flow_id uuid references public.review_flows(id),
  add column if not exists current_step int not null default 1,
  add column if not exists final_score numeric;
comment on column public.annual_review_participants.flow_id is
  '該員工這次考核所走的簽核鏈，新增參與者時從該部門的 review_flows 快照下來，之後流程跑到一半即使部門的流程設定被改掉也不受影響。';
comment on column public.annual_review_participants.current_step is
  '目前輪到簽核鏈第幾關評分，員工自評送出後從 1 開始；每一關評分送出後 +1；跑完所有關卡後 supervisor_submitted 才會是 true。';
comment on column public.annual_review_participants.final_score is
  '換算後的 0-100 最終分數 (跑完所有關卡後計算並存檔，之後即使模板題目異動也不影響歷史紀錄)。';

alter table public.review_evaluations
  add column if not exists step_order int,
  add column if not exists example_note text;
comment on column public.review_evaluations.step_order is
  '這筆評分屬於簽核鏈第幾關 (對應 annual_review_participants.current_step 送出當下的值)。';
comment on column public.review_evaluations.example_note is
  '評核人為這一題評分寫下的理由／相關事例。';

-- IMPORTANT: the app used to upsert per-question evaluation rows on
-- ON CONFLICT (participant_id, question_id), which assumed exactly one
-- evaluator per participant. With a multi-step flow, step 2's evaluator
-- upserting the same question_id would silently overwrite step 1's score
-- instead of creating its own row. Replace that constraint with one that
-- also includes step_order. (The overall/is_overall row, where question_id
-- is NULL, is handled by the app doing a delete-then-insert per step
-- instead of relying on a DB constraint, since a NULL column can't be
-- usefully part of a plain unique constraint.)
do $$
declare
  con record;
begin
  for con in
    select tc.constraint_name
    from information_schema.table_constraints tc
    where tc.table_name = 'review_evaluations'
      and tc.table_schema = 'public'
      and tc.constraint_type = 'UNIQUE'
      and tc.constraint_name in (
        select kcu.constraint_name
        from information_schema.key_column_usage kcu
        where kcu.table_name = 'review_evaluations'
          and kcu.table_schema = 'public'
        group by kcu.constraint_name
        having array_agg(kcu.column_name::text order by kcu.column_name::text) = array['participant_id', 'question_id']
      )
  loop
    execute format('alter table public.review_evaluations drop constraint %I', con.constraint_name);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'review_evaluations' and table_schema = 'public'
      and constraint_name = 'review_evaluations_participant_question_step_key'
  ) then
    alter table public.review_evaluations
      add constraint review_evaluations_participant_question_step_key
      unique (participant_id, question_id, step_order);
  end if;
end $$;

alter table public.review_responses
  add column if not exists example_note text;
comment on column public.review_responses.example_note is
  '員工為自己這一題自評分數寫下的理由／相關事例。';
