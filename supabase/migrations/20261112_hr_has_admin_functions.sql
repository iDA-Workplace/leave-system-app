-- ============================================================================
-- HR 擁有所有管理員的功能；管理員不再能改考核資料
-- ============================================================================
--
-- 使用者決定（2026-11，第 2 階段第 2 步）：
--   · HR 要有管理員的所有功能：員工帳號管理（含重設密碼）、簽核流程、通知對象、
--     假別英文名稱。（員工帳號、假別英文名稱 HR 在資料庫本來就能改，這支補其餘的）
--   · 管理員只管系統，不碰資料：匯出報表與請假統計已經只給 HR（上一階段）；
--     考核資料（週期、題目、參與者、主管評分、考核流程）原本資料庫讓管理員也能寫，
--     但網頁上管理員根本沒有入口 → 拿掉管理員，改成 HR 可以（使用者選的）。
--     主管／副主管／老闆照舊。
--   · 管理員照常保有：員工帳號管理、簽核流程、通知對象、假別英文名稱、員工福利設定。
--
-- 這支動到的權限規則：
--   1. approval_flows、approval_flow_steps 的新增／修改／刪除：管理員或 HR
--   2. notification_targets 的管理：管理員或 HR
--   3. is_review_manager()（考核資料的寫入判斷）：管理員 → HR
--   4. review_flows、review_flow_steps 的寫入規則：改成呼叫 is_review_manager()，
--      跟其他考核資料表同一套判斷（原本是各自寫死 is_admin）
--
-- 不在這支：
--   · 重設密碼是 Edge Function（admin-reset-password），要另外部署新版
--   · 假單的檢視範圍（誰看得到誰的假單、事由、附件）→ 第 2 階段第 6 步
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- 最後會列出「還有寫到 is_admin 的權限規則」，正常應該只剩三條（見檔案最後的說明）。
-- ============================================================================


-- 1. 簽核流程：管理員或 HR 都能新增、修改、刪除 ---------------------------------
--    原本的 admins_can_* 換成 admin_or_hr_can_*（同一條規則同時判斷兩種身分，
--    以後看權限表比較清楚，不會一個動作有兩條規則）
do $$
declare
  t text;
  op text;
begin
  foreach t in array array['approval_flows', 'approval_flow_steps'] loop
    foreach op in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on public.%I', format('admins_can_%s_%s', op, t), t);
      execute format('drop policy if exists %I on public.%I', format('admin_or_hr_can_%s_%s', op, t), t);
      if op = 'insert' then
        execute format('create policy %I on public.%I for insert to authenticated
                          with check (public.is_admin_user() or public.is_hr_user())',
                       format('admin_or_hr_can_%s_%s', op, t), t);
      elsif op = 'delete' then
        execute format('create policy %I on public.%I for delete to authenticated
                          using (public.is_admin_user() or public.is_hr_user())',
                       format('admin_or_hr_can_%s_%s', op, t), t);
      else
        execute format('create policy %I on public.%I for update to authenticated
                          using (public.is_admin_user() or public.is_hr_user())
                          with check (public.is_admin_user() or public.is_hr_user())',
                       format('admin_or_hr_can_%s_%s', op, t), t);
      end if;
    end loop;
  end loop;
end $$;


-- 2. 通知對象：管理員或 HR ---------------------------------------------------------
drop policy if exists admins_can_manage_notification_targets on public.notification_targets;
drop policy if exists admin_or_hr_can_manage_notification_targets on public.notification_targets;
create policy admin_or_hr_can_manage_notification_targets on public.notification_targets
  for all to authenticated
  using (public.is_admin_user() or public.is_hr_user())
  with check (public.is_admin_user() or public.is_hr_user());


-- 3. 考核資料的寫入判斷：主管／副主管／老闆，加上 HR（不再包含管理員） ---------------
--    annual_reviews、review_templates、review_template_questions、
--    annual_review_participants、review_evaluations 的寫入規則都呼叫這個函式
--    （20260816），改這裡就全部生效。
create or replace function public.is_review_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and ((u.is_finance and u.is_active is not false)
           or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
  );
$$;

comment on function public.is_review_manager() is
  '考核資料能不能寫：主管／副主管／老闆（對應 Review.jsx 的 EVALUATOR_ROLES）與 HR。'
  '2026-11 起不含管理員（管理員只管系統、不碰資料）。定義見 migration 20261112。';


-- 4. 考核流程（review_flows、review_flow_steps）改用同一個判斷 ---------------------
do $$
declare
  t text;
begin
  foreach t in array array['review_flows', 'review_flow_steps'] loop
    execute format('drop policy if exists %I on public.%I', 'evaluators_can_write_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'evaluators_can_update_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'evaluators_can_delete_' || t, t);
    execute format('create policy %I on public.%I for insert to authenticated
                      with check (public.is_review_manager())', 'evaluators_can_write_' || t, t);
    execute format('create policy %I on public.%I for update to authenticated
                      using (public.is_review_manager()) with check (public.is_review_manager())',
                   'evaluators_can_update_' || t, t);
    execute format('create policy %I on public.%I for delete to authenticated
                      using (public.is_review_manager())', 'evaluators_can_delete_' || t, t);
  end loop;
end $$;


-- ============================================================================
-- 驗收：還有寫到 is_admin 的權限規則
--
-- 正常應該只剩這三條（都是刻意保留的）：
--   admins_can_update_users              管理員管員工帳號（HR 有自己的 finance_can_update_users）
--   admins_can_update_leave_types        管理員改假別英文名稱（HR 有自己的 finance_can_update_leave_types）
--   approvers_can_update_leave_requests  裡面有管理員，但假單的保護觸發器（20261110）
--                                        會擋下管理員的任何修改，實際上改不了
-- 如果多出別的，請把結果貼給我。
-- （SQL Editor 只顯示最後一段的結果，所以這段放最後）
-- ============================================================================
select tablename as 資料表, policyname as 規則, cmd as 動作
  from pg_policies
 where schemaname = 'public'
   and (coalesce(qual, '') ilike '%is_admin%' or coalesce(with_check, '') ilike '%is_admin%')
   and coalesce(qual, '') not ilike '%is_admin_user()%'
   and coalesce(with_check, '') not ilike '%is_admin_user()%'
 order by 1, 2;
