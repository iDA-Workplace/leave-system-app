-- ============================================================================
-- 按摩預約 × Slack：記下每一則「開放報名公告」發在哪裡
-- ============================================================================
--
-- 要先執行 20261020_massage_slack.sql。
--
-- 使用者決定：管理者編輯期數（日期、時段、名額、截止時間……）之後，頻道上
-- 原本那則開放報名公告直接改寫成最新內容，不另發新訊息；期數被刪除時改成
-- 「本期已取消」。Slack 要改寫一則訊息，需要它的頻道 ID 和 ts（訊息編號），
-- 所以發公告時記在這裡（Edge Function massage-notify）。
--
-- session_id 刻意不設 foreign key：期數被刪除之後，還要靠這一列知道要改哪一則
-- 公告、標題和日期是什麼。
--
-- 跟 massage_notify_log 一樣只有 service_role 讀寫：開了 RLS 但沒有任何規則。

create table if not exists public.massage_announcements (
  session_id   uuid primary key,
  channel      text not null,
  ts           text not null,
  title        text not null,          -- 最後一次寫進公告的標題（期數刪除後要用）
  session_date date not null,
  content      text not null,          -- 最後一次寫進公告的內容；跟最新內容不同才改寫
  posted_at    timestamptz not null default now(),
  updated_at   timestamptz,
  closed_at    timestamptz             -- 不再追蹤：期數已刪除（公告改成「本期已取消」）或公告已不在頻道上
);

alter table public.massage_announcements enable row level security;
revoke all on public.massage_announcements from anon, authenticated;
grant all on public.massage_announcements to service_role;
