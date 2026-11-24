-- ============================================================================
-- 暫停「測試環境」的所有自動排程（只能在測試專案執行）
-- ============================================================================
--
-- 2026-11-18：正式系統上線後，測試環境（另一個 Supabase 專案＋「iDA TEST」Slack App）的排程
-- 還在跑，按摩通知等訊息照樣發到 Slack。使用者決定：測試環境與資料都留著，只把排程暫停，
-- 之後要測新功能時再打開。
--
-- 保險：排程內容裡出現正式專案的網址代碼（dwwswsqwgioneedpsbsu）就判定這是正式專案，
--       直接停下、什麼都不改。
--
-- 用法：Supabase 主控台左上角切到「測試專案」→ SQL Editor，整份貼上執行。可以重複執行。
-- 之後要恢復：執行最下面「恢復」那段（拿掉前面的 -- 再執行）。
-- ============================================================================

do $$
begin
  if exists (select 1 from cron.job where command like '%dwwswsqwgioneedpsbsu%') then
    raise exception '這是「正式專案」（排程裡有正式網址 dwwswsqwgioneedpsbsu），沒有做任何修改。請先在左上角切換到測試專案再執行。';
  end if;
  perform cron.alter_job(jobid, active := false) from cron.job where active;
end $$;

-- 驗收：每一列的「啟用中」都要是 false
select jobname as 排程名稱, schedule as 設定, active as 啟用中,
       substring(command from 'functions/v1/([A-Za-z0-9_-]+)') as 呼叫的function
  from cron.job
 order by jobname;

-- ── 恢復（之後要在測試環境測試時才用；拿掉前面的 -- 再執行）──
-- select cron.alter_job(jobid, active := true) from cron.job;
