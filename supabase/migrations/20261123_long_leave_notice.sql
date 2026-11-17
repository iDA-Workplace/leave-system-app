-- ============================================================================
-- 長假預告：3 個上班日以上的假，開始前約兩個月在群組提醒一次（2026-11 使用者決定）
-- ============================================================================
--
-- 目的：同仁請長假（或主管、老闆請長假）時，專案同事可以提早交接，要請示、報備的事
-- 可以在對方休假前處理。
--
-- 使用者決定的規則：
--   · 長假＝已核准、3 個上班日以上（扣掉週末與國定假日）
--   · 開始前約兩個月（8 週）提醒一次；太晚才核准的（離開始不到兩個月）一樣要提醒 ——
--     就在核准後的下一個上班日早上補發
--   · 早上 9:00 發到請假群組（SLACK_LEAVE_CHANNEL），同一天有好幾位就合併成一則
--   · 在家工作（WFH）也要，跟請假分開列
--   · 每張假單只提醒一次；HR 改了日期的話，會照新的日期重新提醒
--
-- 這支做的事：
--   1. leave_requests.long_notice_sent_at：這張假單的長假預告已經發過的時間
--   2. 日期被改掉時自動清掉這個記號（重新預告）
--   3. 新增排程 long-leave-notice：週一～週五 台北 09:00，呼叫 daily-leave-digest?scope=long
--      （照抄現有 daily-leave-digest 排程的寫法，只改網址，金鑰不用重打）
--
-- ⚠️ 要先部署新版 daily-leave-digest，再執行這支（否則 9:00 呼叫到舊版，會被當成今日名單多發一則）。
--    「今日／隔天請假名單」暫停到 2027/1/1 的設定不受影響；這個新排程現在就啟用，
--    但 2027 年以前不會有假單，所以實際上不會發任何訊息。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

-- 1. 記號
alter table public.leave_requests add column if not exists long_notice_sent_at timestamptz;
comment on column public.leave_requests.long_notice_sent_at is
  '長假預告已經發到群組的時間（2026-11）。日期被修改時會自動清空，照新的日期重新預告。';

-- 2. 日期改了 → 重新預告
create or replace function public.leave_requests_reset_long_notice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date then
    new.long_notice_sent_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_requests_reset_long_notice on public.leave_requests;
create trigger leave_requests_reset_long_notice
  before update of start_date, end_date on public.leave_requests
  for each row execute function public.leave_requests_reset_long_notice();

-- 3. 排程：照抄 daily-leave-digest 那一條，網址加上 ?scope=long
do $$
declare
  src text;
  cmd text;
begin
  select command into src from cron.job where jobname = 'daily-leave-digest';
  if src is null then
    raise exception '找不到 daily-leave-digest 排程，沒有建立長假預告排程。請把這段訊息貼給開發者。';
  end if;
  if (length(src) - length(replace(src, '/daily-leave-digest''', ''))) / length('/daily-leave-digest''') <> 1 then
    raise exception 'daily-leave-digest 排程的網址寫法跟預期不同，沒有建立長假預告排程。請把這段訊息貼給開發者。';
  end if;
  cmd := replace(src, '/daily-leave-digest''', '/daily-leave-digest?scope=long''');

  perform cron.unschedule(jobid) from cron.job where jobname = 'long-leave-notice';
  perform cron.schedule('long-leave-notice', '0 1 * * 1-5', cmd);   -- UTC 01:00 = 台北 09:00，週一～週五
end $$;


-- 驗收：三列都要是「是」
select '假單有「長假預告已發」記號' as 項目,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'leave_requests' and column_name = 'long_notice_sent_at')
            then '是' else '否' end as 結果
union all
select '改日期會重新預告',
       case when exists (select 1 from pg_trigger where tgname = 'leave_requests_reset_long_notice') then '是' else '否' end
union all
select '長假預告排程（週一～週五 09:00、網址帶 scope=long）',
       case when exists (select 1 from cron.job where jobname = 'long-leave-notice' and schedule = '0 1 * * 1-5'
                                                  and command like '%daily-leave-digest?scope=long%' and active)
            then '是' else '否' end;
