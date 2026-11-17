-- ============================================================================
-- 請假名單（早上 9:00 今日、下午 1:00 隔天）暫停到 2027/1/1，當天自動恢復
-- ============================================================================
--
-- 2026-11 使用者決定：今天上線、Slack 切到正式群組，但系統 2027/1/1 才開放請假，
-- 這段期間系統裡沒有假單，名單只會一直發「沒有人請假」，會誤導大家。所以：
--   · 現在把 daily-leave-digest、daily-leave-preview 兩個排程「暫停」（不刪，設定都留著）
--   · 另外建一個一次性排程 resume-leave-digest-2027：2027/1/1 台北 08:00（UTC 00:00）
--     把上面兩個排程打開，然後把自己刪掉。1/1 那天不用做任何事。
--   · 按摩公告、逾期假單處理（daily-leave-job）、國定假日匯入都不受影響
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- 想提早恢復：執行最下面「手動恢復」那段（拿掉前面的 -- 再執行）。
-- ============================================================================

do $$
declare n int;
begin
  -- 1. 暫停兩個請假名單排程
  select count(*) into n from cron.job where jobname in ('daily-leave-digest', 'daily-leave-preview');
  if n <> 2 then
    raise exception '找不到 daily-leave-digest／daily-leave-preview 兩個排程（只找到 % 個），沒有做任何修改。請把這段訊息貼給開發者。', n;
  end if;
  perform cron.alter_job(jobid, active := false)
     from cron.job where jobname in ('daily-leave-digest', 'daily-leave-preview');

  -- 2. 一次性的「1/1 自動恢復」排程（已經建過就先刪掉重建）
  perform cron.unschedule(jobid) from cron.job where jobname = 'resume-leave-digest-2027';
  perform cron.schedule(
    'resume-leave-digest-2027',
    '0 0 1 1 *',                       -- UTC 每年 1/1 00:00 = 台北 08:00；下一次就是 2027/1/1
    $job$
      do $inner$
      begin
        if current_date >= date '2027-01-01' then
          perform cron.alter_job(jobid, active := true)
             from cron.job where jobname in ('daily-leave-digest', 'daily-leave-preview');
          perform cron.unschedule(jobid) from cron.job where jobname = 'resume-leave-digest-2027';
        end if;
      end $inner$;
    $job$
  );
end $$;

-- 驗收：兩個請假名單「啟用中」要是 false；resume-leave-digest-2027 要在、設定 0 0 1 1 *
select jobname as 排程名稱, schedule as 設定, active as 啟用中,
       case jobname
         when 'daily-leave-digest' then '早上 9:00 今日請假名單（暫停到 2027/1/1）'
         when 'daily-leave-preview' then '下午 1:00 隔天請假名單（暫停到 2027/1/1）'
         when 'resume-leave-digest-2027' then '2027/1/1 台北 08:00 自動恢復上面兩個，然後刪掉自己'
       end as 說明
  from cron.job
 where jobname in ('daily-leave-digest', 'daily-leave-preview', 'resume-leave-digest-2027')
 order by jobname;

-- ── 手動恢復（想提早恢復時才用；拿掉每行前面的 -- 再執行）──
-- select cron.alter_job(jobid, active := true) from cron.job where jobname in ('daily-leave-digest', 'daily-leave-preview');
-- select cron.unschedule(jobid) from cron.job where jobname = 'resume-leave-digest-2027';
