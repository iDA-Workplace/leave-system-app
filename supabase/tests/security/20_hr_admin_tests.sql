-- migrations/20261112_hr_has_admin_functions.sql 的測試。
-- 接在 10_tests.sql 後面跑（用它建好的人物：emp1、sup1、boss、sup2、hr、admin）。
--
--   HR 要有管理員的功能：簽核流程、通知對象
--   考核資料：管理員不能寫了，HR 可以，主管照舊，一般員工不行
--   管理員原本能做的系統設定照常可以

-- ── 考核相關資料表的替身（欄位只留測試用得到的），套上原本的權限規則 ──
create table public.review_flows (id uuid primary key default gen_random_uuid(), name text);
create table public.review_flow_steps (id uuid primary key default gen_random_uuid(), flow_id uuid, step_order int);
create table public.annual_reviews (id uuid primary key default gen_random_uuid(), title text);
create table public.review_templates (id uuid primary key default gen_random_uuid(), name text);
create table public.review_template_questions (id uuid primary key default gen_random_uuid(), template_id uuid);
create table public.annual_review_participants (id uuid primary key default gen_random_uuid(), user_id uuid, final_score numeric);
create table public.review_evaluations (id uuid primary key default gen_random_uuid(), participant_id uuid, score numeric);
do $$ declare t text; begin
  foreach t in array array['review_flows','review_flow_steps','annual_reviews','review_templates',
                           'review_template_questions','annual_review_participants','review_evaluations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant all on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', 'sel_' || t, t);
  end loop;
end $$;
\i supabase/migrations/20260813_review_flows_rls.sql
\i supabase/migrations/20260816_review_manager_rls.sql
insert into public.annual_review_participants (id, user_id, final_score)
  values ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 80);

-- 先確認修正前：管理員能改考核分數、HR 不能管簽核流程（證明測試抓得到）
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('修正前：管理員能改考核分數',
  t.run($$update public.annual_review_participants set final_score = 81$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('修正前：HR 不能新增簽核流程的關卡',
  t.run($$insert into public.approval_flow_steps (flow_id, step_order, approver_id)
          values ('aaaaaaaa-0000-0000-0000-000000000002', 1, '00000000-0000-0000-0000-000000000002')$$) like 'err:%');
reset role;

-- ── 套用修正 ──
\i supabase/migrations/20261112_hr_has_admin_functions.sql

set role authenticated;

-- ════ 1. 簽核流程 ════
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('F1 HR 能新增簽核流程',
  t.run($$insert into public.approval_flows (id, name) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'HR 建的流程')$$) = 'rows=1');
select t.ok('F2 HR 能改流程名稱',
  t.run($$update public.approval_flows set name = 'HR 改名' where id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$) = 'rows=1');
select t.ok('F3 HR 能新增、修改、刪除流程的關卡',
  t.run($$insert into public.approval_flow_steps (flow_id, step_order, approver_id)
          values ('aaaaaaaa-0000-0000-0000-0000000000f1', 1, '00000000-0000-0000-0000-000000000002')$$) = 'rows=1'
  and t.run($$update public.approval_flow_steps set approver_id = '00000000-0000-0000-0000-000000000004'
              where flow_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$) = 'rows=1'
  and t.run($$delete from public.approval_flow_steps where flow_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$) = 'rows=1');
select t.ok('F4 HR 能刪除流程',
  t.run($$delete from public.approval_flows where id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$) = 'rows=1');

select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('F5 管理員照常能新增、改名、刪除簽核流程與關卡',
  t.run($$insert into public.approval_flows (id, name) values ('aaaaaaaa-0000-0000-0000-0000000000f2', '管理員建的')$$) = 'rows=1'
  and t.run($$update public.approval_flows set name = 'x' where id = 'aaaaaaaa-0000-0000-0000-0000000000f2'$$) = 'rows=1'
  and t.run($$insert into public.approval_flow_steps (flow_id, step_order, approver_id)
              values ('aaaaaaaa-0000-0000-0000-0000000000f2', 1, '00000000-0000-0000-0000-000000000002')$$) = 'rows=1'
  and t.run($$delete from public.approval_flow_steps where flow_id = 'aaaaaaaa-0000-0000-0000-0000000000f2'$$) = 'rows=1'
  and t.run($$delete from public.approval_flows where id = 'aaaaaaaa-0000-0000-0000-0000000000f2'$$) = 'rows=1');

select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('F6 一般員工不能新增流程、不能改關卡',
  t.run($$insert into public.approval_flows (name) values ('員工建的')$$) like 'err:%'
  and t.run($$update public.approval_flow_steps set approver_id = '00000000-0000-0000-0000-000000000001'$$) = 'rows=0');
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('F7 主管（不是管理員、不是 HR）不能改簽核流程',
  t.run($$update public.approval_flow_steps set approver_id = '00000000-0000-0000-0000-000000000002'$$) = 'rows=0');

-- ════ 2. 通知對象 ════
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('N4 HR 能新增、停用、移除通知對象',
  t.run($$insert into public.notification_targets (user_id) values ('00000000-0000-0000-0000-000000000002')$$) = 'rows=1'
  and t.run($$update public.notification_targets set is_active = false$$) = 'rows=1'
  and t.run($$delete from public.notification_targets$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('N5 管理員照常能管通知對象',
  t.run($$insert into public.notification_targets (user_id) values ('00000000-0000-0000-0000-000000000002')$$) = 'rows=1'
  and t.run($$delete from public.notification_targets$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('N6 一般員工照樣不能改通知對象',
  t.run($$insert into public.notification_targets (user_id) values ('00000000-0000-0000-0000-000000000001')$$) like 'err:%');

-- ════ 3. 員工帳號（HR 本來就能改，確認沒有被影響）════
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('U9 HR 能改別人的部門、流程、管理員勾選（員工帳號管理）',
  t.run($$update public.users set department = 'HR 改的', is_admin = false, default_flow_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          where id = '00000000-0000-0000-0000-000000000004'$$) = 'rows=1');
select t.ok('U10 HR 能幫自己勾管理員', -- 使用者決定：不限制
  t.run($$update public.users set is_admin = true where id = '00000000-0000-0000-0000-000000000005'$$) = 'rows=1');
reset role;
update public.users set is_admin = false where id = '00000000-0000-0000-0000-000000000005';
set role authenticated;

-- ════ 4. 考核資料 ════
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('R1 管理員不能再改考核分數',
  t.run($$update public.annual_review_participants set final_score = 99$$) = 'rows=0');
select t.ok('R2 管理員不能新增主管評分、考核週期、考核流程',
  t.run($$insert into public.review_evaluations (participant_id, score) values ('cccccccc-0000-0000-0000-000000000001', 1)$$) like 'err:%'
  and t.run($$insert into public.annual_reviews (title) values ('x')$$) like 'err:%'
  and t.run($$insert into public.review_flows (name) values ('x')$$) like 'err:%');
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('R3 HR 能寫考核資料（分數、週期、考核流程）',
  t.run($$update public.annual_review_participants set final_score = 82$$) = 'rows=1'
  and t.run($$insert into public.annual_reviews (title) values ('HR 建的')$$) = 'rows=1'
  and t.run($$insert into public.review_flows (id, name) values ('dddddddd-0000-0000-0000-000000000001', 'HR 建的')$$) = 'rows=1'
  and t.run($$insert into public.review_flow_steps (flow_id, step_order) values ('dddddddd-0000-0000-0000-000000000001', 1)$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('R4 主管照常能寫考核資料（分數、考核流程的修改與刪除）',
  t.run($$update public.annual_review_participants set final_score = 83$$) = 'rows=1'
  and t.run($$update public.review_flow_steps set step_order = 2$$) = 'rows=1'
  and t.run($$delete from public.review_flow_steps$$) = 'rows=1'
  and t.run($$delete from public.review_flows$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('R5 老闆照常能寫考核資料',
  t.run($$update public.annual_review_participants set final_score = 84$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('R6 一般員工不能寫考核資料',
  t.run($$update public.annual_review_participants set final_score = 100$$) = 'rows=0'
  and t.run($$insert into public.review_flows (name) values ('x')$$) like 'err:%');
reset role;
update public.users set is_active = false where id = '00000000-0000-0000-0000-000000000005';
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('R7 已停用的 HR 不能寫考核資料',
  t.run($$update public.annual_review_participants set final_score = 1$$) = 'rows=0');
reset role;
update public.users set is_active = true where id = '00000000-0000-0000-0000-000000000005';

-- ════ 5. 驗收查詢：還寫著 is_admin 的規則只剩刻意保留的 ════
select t.ok('V1 驗收查詢只列出刻意保留的規則',
  (select array_agg(policyname::text order by policyname) from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ilike '%is_admin%' or coalesce(with_check, '') ilike '%is_admin%')
      and coalesce(qual, '') not ilike '%is_admin_user()%'
      and coalesce(with_check, '') not ilike '%is_admin_user()%')
  = array['admins_can_update_users', 'approvers_can_update_leave_requests'],
  '（替身裡沒有 admins_can_update_leave_types，正式資料庫會多那一條）');

-- ════ 結果 ════
select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
