-- ============================================================================
-- 只能在「測試」專案執行：清空所有按摩資料，重新來過
-- ============================================================================
--
-- 正式環境裡「抽過籤的期數不能刪、異動紀錄不能改」是刻意的保護；測試時
-- 常常需要重來，所以這支會暫時關掉那兩道保護、清空、再打開。
--
-- 防呆：只要登入帳號裡有任何一個不是 @example.com 的（也就是可能有真的
-- 同仁），就停止、什麼都不做。
--
-- 清完之後如果還要示範資料，再執行一次 03_seed_test_data.sql 的話會被它的
-- 防呆擋下（帳號已經存在）—— 直接在網頁上用「測試管理員」開新的一期即可。

do $$
begin
  if exists (select 1 from auth.users where email not like '%@example.com') then
    raise exception '這個專案有不是 @example.com 的帳號，看起來不是測試專案，已停止。';
  end if;

  alter table public.massage_sessions disable trigger massage_sessions_guard;
  alter table public.massage_events disable trigger massage_events_no_update;

  truncate public.massage_notify_log, public.massage_jobs, public.massage_events,
           public.massage_signups, public.massage_sessions;

  alter table public.massage_sessions enable trigger massage_sessions_guard;
  alter table public.massage_events enable trigger massage_events_no_update;

  raise notice '按摩資料已清空（帳號、負責人設定保留）。';
end $$;
