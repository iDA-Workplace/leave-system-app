-- 刪除已經壞掉的排程 auto-deactivate-delegates
--
--
-- 這是什麼
--
-- 「代理審核設定」這個功能在 2026-08 依需求整個移除了，連同它的資料表
-- public.approval_delegates 一起刪掉（見 migrations/20260810_remove_approval_delegates.sql）。
--
-- 但當初漏了一件事：有一個 pg_cron 排程每天在跑
--
--   update public.approval_delegates set is_active = false where end_date < current_date
--
-- 表已經不在了，所以它每天執行、每天失敗。因為失敗只寫進 cron.job_run_details、
-- 不會通知任何人，所以一直沒被發現。
--
-- 它不影響任何功能（那個功能本來就不存在了），但留著有兩個壞處：
--   · cron.job_run_details 每天多一筆失敗紀錄，之後真的有排程壞掉時會被蓋過去
--   · 接手的人看到這個排程，會以為系統還有「代理審核」這個功能
--
--
-- 安全性
--
-- 這支只刪排程，不刪任何資料。而且會先確認 approval_delegates 真的已經不在 ——
-- 萬一那張表還在（代表移除沒做完），它會直接中止並要你先查清楚，不會把一個
-- 其實還有用的排程刪掉。
--
-- 可以重複執行：排程已經刪掉的話會安靜跳過，不會報錯。

do $$
declare
  jid bigint;
  table_still_there boolean;
begin
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'approval_delegates'
  ) into table_still_there;

  if table_still_there then
    raise exception '資料表 public.approval_delegates 還在，代表「代理審核」沒有被完全移除，這個排程可能還有用。先查清楚狀況，不要刪。';
  end if;

  select jobid into jid from cron.job where jobname = 'auto-deactivate-delegates';

  if jid is null then
    raise notice '找不到排程 auto-deactivate-delegates，可能已經刪過了，不需要再做。';
  else
    perform cron.unschedule(jid);
    raise notice '已刪除排程 auto-deactivate-delegates（jobid=%）。', jid;
  end if;
end $$;


-- 確認結果：剩下的排程應該只有 daily-leave-digest、daily-leave-job、
-- daily-leave-preview 這三個，沒有 auto-deactivate-delegates。
--
-- ⚠️ 查詢放在最後，因為 Supabase 的 SQL Editor 只會顯示「最後一段」的結果。
-- 上面 do 區塊的 raise notice 在網頁編輯器裡多半看不到，以這張表為準。
select jobname   as 排程名稱,
       schedule  as 執行時間_UTC,
       active    as 啟用中,
       command   as 執行內容
  from cron.job
 order by jobname;
