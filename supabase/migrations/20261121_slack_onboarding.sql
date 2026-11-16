-- ============================================================================
-- 新人從 Slack 自動申請開通帳號（2026-11 使用者決定）
-- ============================================================================
--
-- 流程：
--   1. 新人加入 Slack 的當下（team_join），bot 私訊歡迎訊息＋「填寫資料」按鈕
--   2. 新人填姓名、email（預先帶入 Slack 的 email，可改）、職稱、部門；Slack User ID 自動記下
--   3. 資料存進這張表（status = pending），bot 私訊所有在職的 HR 與管理員「有新人待開通」
--   4. 管理員或 HR 在「員工帳號管理 → 待開通」補上入職日期、審核流程、直屬主管，按「開通」
--      → manage-users 建立登入帳號（預設密碼）、標成 approved、bot 私訊新人登入方式
--   5. 填錯／不需要開通的可以「移除」（status = removed），新人之後重新送出會再出現
--
-- 這張表只有管理員與 HR 讀得到；寫入一律走後台程式（slack-interactions、manage-users），
-- 網頁不能直接改。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

create table if not exists public.onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null unique,
  full_name text not null,
  email text not null,
  job_title text,
  department text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'removed')),
  submitted_at timestamptz not null default now(),
  handled_by uuid references public.users(id) on delete set null,
  handled_at timestamptz,
  user_id uuid references public.users(id) on delete set null
);

comment on table public.onboarding_requests is
  '新人從 Slack 送出的開通申請（2026-11）。pending＝待開通、approved＝已開通（user_id 是建立的帳號）、removed＝管理員／HR 移除。';

alter table public.onboarding_requests enable row level security;
revoke all on public.onboarding_requests from anon, authenticated;
grant select on public.onboarding_requests to authenticated;
grant all on public.onboarding_requests to service_role;

drop policy if exists onboarding_requests_admin_hr_read on public.onboarding_requests;
create policy onboarding_requests_admin_hr_read on public.onboarding_requests
  for select to authenticated
  using (public.is_admin_user() or public.is_hr_user());


-- 驗收：兩列都要是「是」
select '開通申請資料表已建立' as 項目,
       case when to_regclass('public.onboarding_requests') is not null then '是' else '否' end as 結果
union all
select '只有管理員與 HR 讀得到',
       case when exists (select 1 from pg_policies where tablename = 'onboarding_requests' and policyname = 'onboarding_requests_admin_hr_read')
            then '是' else '否' end;
