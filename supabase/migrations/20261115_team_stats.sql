-- ============================================================================
-- 團隊請假統計（第 2 階段第 4 步）：主管讀得到直屬部屬的特休手動額度
-- ============================================================================
--
-- 使用者 2026-11 決定：主管／副主管／老闆在左側選單「團隊請假統計」看直屬部屬
-- （users.manager_id = 自己）的請假統計，包含「特休使用狀況」。
--
-- 特休應有天數：HR 在「員工假期管理」手動指定過的，以手動的為準。但
-- user_leave_entitlements 原本只有「HR」和「本人」讀得到，主管讀不到 → 團隊統計
-- 會把那幾位顯示成依年資自動算的天數（跟 HR 看到的不一樣）。
--
-- 這支只加一條「讀」的規則：在職的人讀得到「直屬主管是自己」的同仁的額度。
-- 不能改（寫入仍然只有 HR）。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

drop policy if exists managers_can_read_reports_entitlements on public.user_leave_entitlements;
create policy managers_can_read_reports_entitlements
  on public.user_leave_entitlements for select
  to authenticated
  using (exists (
    select 1 from public.users u
     where u.id = user_leave_entitlements.user_id
       and u.manager_id = auth.uid()
  ));

-- 驗收：應該出現一列
select policyname as 規則, cmd as 動作
  from pg_policies
 where schemaname = 'public' and tablename = 'user_leave_entitlements'
   and policyname = 'managers_can_read_reports_entitlements';
