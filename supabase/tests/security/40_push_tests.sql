-- migrations/20261119_push_notifications.sql 的測試。接在 10_tests.sql 後面跑（00 → 10 → 40）。
-- 人物（10_tests.sql 建的）：emp1 員工、sup1 主管（流程 A 第 1 關）、boss 老闆（流程 A 第 2 關）、
-- sup2 主管、hr HR、admin 管理員

-- ── 考核資料表的替身（只留用得到的欄位） ──
create table public.annual_reviews (
  id uuid primary key default gen_random_uuid(), title text, status text default 'active',
  self_assessment_deadline date, evaluation_deadline date);
create table public.review_flow_steps (
  id uuid primary key default gen_random_uuid(), flow_id uuid, step_order int, evaluator_id uuid);
create table public.annual_review_participants (
  id uuid primary key default gen_random_uuid(), review_id uuid, user_id uuid, flow_id uuid,
  current_step int not null default 1, self_submitted boolean default false, supervisor_submitted boolean default false);
grant all on public.annual_reviews, public.review_flow_steps, public.annual_review_participants to authenticated;

-- 考核流程 R：第 1 關 sup1、第 2 關 boss
insert into public.annual_reviews (id, title) values ('dddddddd-0000-0000-0000-000000000001', '2026 年度考核');
insert into public.annual_reviews (id, title, status) values ('dddddddd-0000-0000-0000-000000000002', '已結束的考核', 'closed');
insert into public.review_flow_steps (flow_id, step_order, evaluator_id) values
  ('eeeeeeee-0000-0000-0000-000000000001', 1, '00000000-0000-0000-0000-000000000002'),
  ('eeeeeeee-0000-0000-0000-000000000001', 2, '00000000-0000-0000-0000-000000000003');
insert into public.annual_review_participants (id, review_id, user_id, flow_id, current_step, self_submitted) values
  -- emp1：還沒交自評（emp1 的待辦 1）
  ('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 1, false),
  -- sup2：交了自評、在第 1 關（sup1 的待辦 1）
  ('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-000000000001', 1, true),
  -- hr：已結束的考核、沒交自評（不算）
  ('cccccccc-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000005', 'eeeeeeee-0000-0000-0000-000000000001', 1, false);

-- 假單：emp1 一張審核中（流程 A 第 1 關 = sup1 的待辦 1）、一張已核准
delete from public.leave_approvals;
delete from public.leave_requests;   -- 10_tests.sql 留下的假單不算
truncate t.ids;
insert into t.ids values
  ('L1', t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')),
  ('L2', t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'approved'));

\i supabase/migrations/20261119_push_notifications.sql
-- 可以重複執行
\i supabase/migrations/20261119_push_notifications.sql

-- ════ 1. 舊資料的「已通知」記號 ════
select t.ok('B1 現有名單都標成「已通知填自評」（不補發）',
  not exists (select 1 from public.annual_review_participants where invite_notified_at is null));
select t.ok('B2 已交自評、等第 1 關的：第 1 關標成已通知（不補發）',
  (select turn_notified_key from public.annual_review_participants where id = 'cccccccc-0000-0000-0000-000000000002') = 'eeeeeeee-0000-0000-0000-000000000001:1');
select t.ok('B3 還沒交自評的：不標記（之後交出時第 1 關要收到通知）',
  (select turn_notified_key from public.annual_review_participants where id = 'cccccccc-0000-0000-0000-000000000001') is null);

-- ════ 2. 圖示數字 ════
select t.ok('C1 sup1（主管）＝ 待簽核假單 1 ＋ 待評分考核 1 ＝ 2', public.app_badge_count('00000000-0000-0000-0000-000000000002') = 2);
select t.ok('C2 emp1（員工）＝ 待填自評 1', public.app_badge_count('00000000-0000-0000-0000-000000000001') = 1);
select t.ok('C3 boss（第 2 關，還沒輪到）＝ 0', public.app_badge_count('00000000-0000-0000-0000-000000000003') = 0);
select t.ok('C4 hr：已結束的考核不算 ＝ 0', public.app_badge_count('00000000-0000-0000-0000-000000000005') = 0);
update public.users set role = 'employee' where id = '00000000-0000-0000-0000-000000000002';
select t.ok('C5 一般員工就算在流程裡也不算簽核／評分（跟網頁上的鈴鐺一致）', public.app_badge_count('00000000-0000-0000-0000-000000000002') = 0);
update public.users set role = 'supervisor' where id = '00000000-0000-0000-0000-000000000002';
update public.users set is_active = false where id = '00000000-0000-0000-0000-000000000001';
select t.ok('C6 停用的帳號 ＝ 0', public.app_badge_count('00000000-0000-0000-0000-000000000001') = 0);
update public.users set is_active = true where id = '00000000-0000-0000-0000-000000000001';

set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('C7 網頁查自己的數字（my_app_badge_count）', public.my_app_badge_count() = 2);
select t.ok('C8 網頁不能直接查別人的數字', t.run($$select public.app_badge_count('00000000-0000-0000-0000-000000000001')$$) like 'err:%');
select t.as_user(null);
select t.ok('C9 沒登入 ＝ 0', public.my_app_badge_count() = 0);
reset role;
set role anon;
select t.ok('C10 anon 不能呼叫', t.run($$select public.my_app_badge_count()$$) like 'err:%');
reset role;

-- ════ 3. 裝置訂閱 ════
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('S1 開啟通知（記下這台裝置）',
  t.run($$select public.save_push_subscription('https://push.example/ep1', 'pk', 'au', 'iPhone')$$) = 'rows=1');
select t.ok('S2 看得到自己的裝置', (select count(*) from public.push_subscriptions) = 1);
select t.ok('S3 不能直接寫資料表（只能走函式）',
  t.run($$insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('00000000-0000-0000-0000-000000000001', 'https://x', 'a', 'b')$$) like 'err:%'
  and t.run($$update public.push_subscriptions set user_id = '00000000-0000-0000-0000-000000000002'$$) like 'err:%');
select t.ok('S4 網址不是 https 的擋下來',
  t.run($$select public.save_push_subscription('http://evil', 'pk', 'au')$$) like 'err:%');
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('S5 別人看不到我的裝置', (select count(*) from public.push_subscriptions) = 0);
select t.ok('S6 別人刪不掉我的裝置',
  t.run($$select public.remove_push_subscription('https://push.example/ep1')$$) = 'rows=1'
  and (select count(*) from public.push_subscriptions where endpoint = 'https://push.example/ep1') = 0);
reset role;
select t.ok('S6b （確認）那台裝置還在、還是 emp1 的',
  (select user_id from public.push_subscriptions where endpoint = 'https://push.example/ep1') = '00000000-0000-0000-0000-000000000001');
set role authenticated;
select t.ok('S7 同一台裝置換人登入開通知：改成新的人',
  t.run($$select public.save_push_subscription('https://push.example/ep1', 'pk2', 'au2', 'iPhone')$$) = 'rows=1');
reset role;
select t.ok('S7b （確認）只有一筆、是 sup1 的',
  (select count(*) from public.push_subscriptions) = 1
  and (select user_id from public.push_subscriptions) = '00000000-0000-0000-0000-000000000002');
set role authenticated;
select t.ok('S8 關閉通知：刪掉自己的', t.run($$select public.remove_push_subscription('https://push.example/ep1')$$) = 'rows=1');
reset role;
select t.ok('S8b （確認）刪掉了', (select count(*) from public.push_subscriptions) = 0);
set role authenticated;
select t.as_user(null);
select t.ok('S9 沒登入不能開通知', t.run($$select public.save_push_subscription('https://push.example/ep2', 'pk', 'au')$$) like 'err:%');

-- ════ 4. 推播金鑰 ════
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('K1 網頁（連 HR 都）讀不到推播金鑰', t.run($$select * from public.push_config$$) like 'err:%');
reset role;
set role anon;
select t.ok('K2 anon 讀不到推播金鑰、也讀不到裝置', t.run($$select * from public.push_config$$) like 'err:%'
  and t.run($$select * from public.push_subscriptions$$) like 'err:%');
reset role;
set role service_role;
select t.ok('K3 後台（service role）讀寫得到', t.run($$insert into public.push_config (public_key, private_jwk) values ('x', '{}')$$) = 'rows=1');
reset role;

-- ════ 結果 ════
select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
