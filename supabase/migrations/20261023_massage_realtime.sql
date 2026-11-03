-- ============================================================================
-- 按摩預約：開啟即時更新（Supabase Realtime）
-- ============================================================================
--
-- 要先執行 20261019_massage_booking.sql。
--
-- 首頁的「報名按摩」要在管理者新開一期、編輯一期、或有人報名／取消時自動
-- 更新，不用重新整理（使用者要求）。網頁是訂閱這兩張表的變動；表要加進
-- supabase_realtime 這個 publication，Supabase 才會把變動推給網頁。
--
-- 讀取權限照舊由 RLS 決定（這兩張表本來就是登入的人都能讀），不會因此多
-- 看到什麼。重複執行沒關係。

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'massage_sessions') then
    alter publication supabase_realtime add table public.massage_sessions;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'massage_signups') then
    alter publication supabase_realtime add table public.massage_signups;
  end if;
end $$;
