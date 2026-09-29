-- HR 可以修改與刪除假單
--
--
-- 要解決的問題
--
-- 20260916_hr_registered_leave_dispute 讓同仁可以對 HR 代登記的假單「提出
-- 修改異議」，系統也會通知登記的那位 HR。但 HR 收到通知之後，系統裡沒有
-- 任何地方可以把那張假單改掉或刪掉 —— 話傳到了，接到話的人卻沒有工具。
--
-- 這支補上資料庫這一半：讓 HR 具備修改與刪除假單的權限。
--
--
-- 權限規則（2026-09 與使用者確認，刻意分成兩種）
--
--   代登記的假單（registered_by 有值）  只有「當初登記的那位 HR」能動
--   同仁自己送的假單（registered_by 為 NULL）  全體 HR 都能動
--
-- 為什麼要分：代登記是有主的 —— 誰登的誰負責，而且異議通知也只發給他，
-- 責任線一致。同仁自己送的假單沒有「登記者」這個概念，如果也套用同一條
-- 規則，結果會是「誰都不能動」，等於沒做。
--
-- ⚠️ 已知的取捨：代登記那位 HR 請假或離職時，他登的那些假單就沒有人能處理。
-- 這是使用者在了解風險後仍選擇的分法（同一個取捨也出現在異議通知上）。
-- 真的卡住時，可以用 service role 在 SQL Editor 直接處理。
--
--
-- 為什麼 update 與 delete 要分成兩條政策
--
-- Postgres 的 RLS 是「每種動作各自一條」，update 的政策管不到 delete。
-- 原本 leave_requests 上只有 update 政策、沒有任何 delete 政策 —— 所以在
-- 這支之前，不管是誰、在網頁上都刪不掉任何一張假單。
--
-- update 的既有政策（approvers_can_update_leave_requests）放行的是申請人、
-- 當關簽核人與管理員，沒有涵蓋 HR。permissive 政策之間是 OR 的關係，所以
-- 這裡新增一條就好，不用也不該去動原本那條。

-- ---------------------------------------------------------------------------
-- 共用的判斷條件（兩條政策用同一套邏輯）：
--   是 HR，而且（這張沒有登記者 或 登記者就是我）
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leave_requests'
      and policyname = 'finance_can_update_leave_requests'
  ) then
    create policy finance_can_update_leave_requests
      on public.leave_requests for update
      to authenticated
      using (
        exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance)
        and (registered_by is null or registered_by = auth.uid())
      )
      with check (
        exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance)
        and (registered_by is null or registered_by = auth.uid())
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leave_requests'
      and policyname = 'finance_can_delete_leave_requests'
  ) then
    create policy finance_can_delete_leave_requests
      on public.leave_requests for delete
      to authenticated
      using (
        exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance)
        and (registered_by is null or registered_by = auth.uid())
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 確認兩條政策都建好了（應該各出現一列）：
--
--   select policyname, cmd
--     from pg_policies
--    where schemaname = 'public' and tablename = 'leave_requests'
--      and policyname in ('finance_can_update_leave_requests',
--                         'finance_can_delete_leave_requests');
--
-- 提醒：簽核紀錄（leave_approvals）的外鍵是 on delete cascade，刪掉假單時
-- 它會自動跟著刪，不需要也不應該另外處理。
-- ---------------------------------------------------------------------------
