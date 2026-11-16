-- ============================================================================
-- 「隔天請假名單」預告：下午 4:00 → 下午 1:00（2026-11 使用者決定）
-- ============================================================================
--
-- 只改排程時間，程式不用重新部署。上午 9:00 的「今日請假名單」不動。
--
-- 找的是「打 daily-leave-digest?scope=next 的那條排程」，不靠排程名稱（正式資料庫
-- 當初建立時取的名字不一定跟說明文件一樣）。只換「小時」那一欄：
-- pg_cron 用的是 UTC，台北 13:00 = UTC 05:00；分鐘、星期幾等其他欄位維持原樣。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

do $$
declare
  j record;
  n int := 0;
begin
  for j in select jobid, jobname, schedule from cron.job
            where command like '%daily-leave-digest%scope=next%' loop
    perform cron.alter_job(j.jobid, schedule := regexp_replace(j.schedule, '^(\S+)\s+\S+', '\1 5'));
    raise notice '已修改 %（原本 %）', j.jobname, j.schedule;
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception '找不到「隔天請假名單」的排程（打 daily-leave-digest?scope=next 的那一條），沒有做任何修改。請把這段訊息貼給開發者。';
  end if;
end $$;

-- 驗收：「隔天名單」那一列的「台北時間」要是 13:00；「今日名單」維持 09:00
select jobname as 排程名稱,
       schedule as 設定,
       case when command like '%scope=next%' then '隔天請假名單' else '今日請假名單' end as 內容,
       lpad(((split_part(schedule, ' ', 2)::int + 8) % 24)::text, 2, '0') || ':' || lpad(split_part(schedule, ' ', 1), 2, '0') as 台北時間
  from cron.job
 where command like '%daily-leave-digest%'
 order by 內容;
