-- ============================================================================
-- 按摩預約 × Slack：記錄「哪些通知已經發過了」
-- ============================================================================
--
-- 要先執行 20261019_massage_booking.sql。
--
-- 通知怎麼發：每一個動作（報名、抽籤、釋出、遞補邀請……）本來就會寫一筆
-- massage_events。Edge Function `massage-notify` 每分鐘（以及網頁上做完動作
-- 的當下）把「還沒發過通知」的紀錄拿出來，看是哪一種事件、該通知誰，發完
-- 再標記成已發。
--
-- 為什麼不在資料庫裡直接打 Slack：資料庫函式在交易裡，Slack 慢或掛掉會
-- 拖住（甚至讓整個動作失敗）；而「名額有沒有釋出」不應該取決於 Slack
-- 有沒有回應。動作先成功，通知晚幾秒到。
--
-- 兩張表都只有 service_role（Edge Function）讀寫：開了 RLS 但沒有任何規則，
-- 網頁登入的人讀不到也寫不了。

-- 每一筆異動紀錄的通知狀態
create table if not exists public.massage_notify_log (
  event_id bigint primary key references public.massage_events(id) on delete cascade,
  claimed_at timestamptz not null default now(),   -- 哪一次執行拿去處理的
  attempts int not null default 1,
  sent_at timestamptz                              -- 處理完成（該發的都發了）
);

-- 不是由某一筆異動觸發、而是「時間到了」才做的事：開放報名公告、隔天問
-- 「有按到嗎？」、提醒負責人。job_key 例如 'ask_attendance:<signup id>'，
-- 寫進來就代表做過了，不會重複做。
create table if not exists public.massage_jobs (
  job_key text primary key,
  done_at timestamptz not null default now()
);

alter table public.massage_notify_log enable row level security;
alter table public.massage_jobs enable row level security;
revoke all on public.massage_notify_log from anon, authenticated;
revoke all on public.massage_jobs from anon, authenticated;
grant all on public.massage_notify_log, public.massage_jobs to service_role;

/**
 * 拿出一批還沒發通知的異動紀錄，並且「占住」它們。
 *
 * - 兩次執行剛好同時跑（排程 + 網頁觸發）：同一筆只會被其中一次拿到
 *   （insert ... on conflict 是原子的，晚到的那次什麼都拿不到）。
 * - 拿到之後 Edge Function 當掉、沒有標記完成：5 分鐘後會再被拿出來重試，
 *   最多 3 次。代價是那一筆有可能重複發一次，比起漏發「遞補邀請」好。
 * - 只看 2 天內的紀錄：剛部署、或排程停了很久之後重新啟動時，不會把一堆
 *   早就過時的通知一口氣補發出去。
 */
create or replace function public.massage_notify_claim(p_limit int default 50)
returns setof public.massage_events
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with cand as (
    select e.id
      from public.massage_events e
      left join public.massage_notify_log l on l.event_id = e.id
     where e.created_at > now() - interval '2 days'
       and (l.event_id is null
            or (l.sent_at is null and l.claimed_at < now() - interval '5 minutes' and l.attempts < 3))
     order by e.id
     limit p_limit
  ), claimed as (
    insert into public.massage_notify_log as l (event_id)
    select id from cand
    on conflict (event_id) do update
       set claimed_at = now(), attempts = l.attempts + 1
     where l.sent_at is null and l.claimed_at < now() - interval '5 minutes'
    returning l.event_id
  )
  select e.* from public.massage_events e join claimed c on c.event_id = e.id order by e.id;
end;
$$;

create or replace function public.massage_notify_done(p_event_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.massage_notify_log set sent_at = now() where event_id = p_event_id;
$$;

/** 占住一件「時間到才做」的事。回傳 true = 這次輪到你做；false = 已經做過（或別人正在做）。 */
create or replace function public.massage_job_claim(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.massage_jobs (job_key) values (p_key) on conflict (job_key) do nothing;
  return found;
end;
$$;

revoke all on function public.massage_notify_claim(int) from public, anon, authenticated;
revoke all on function public.massage_notify_done(bigint) from public, anon, authenticated;
revoke all on function public.massage_job_claim(text) from public, anon, authenticated;
grant execute on function public.massage_notify_claim(int) to service_role;
grant execute on function public.massage_notify_done(bigint) to service_role;
grant execute on function public.massage_job_claim(text) to service_role;
