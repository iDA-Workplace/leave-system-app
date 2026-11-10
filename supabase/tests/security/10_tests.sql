-- migrations/20261110_security_lockdown.sql 的測試。
-- 每一項都是「網站真的會做的操作要能成功」或「偷改要被擋下來」。
-- 被擋下來有兩種樣子：權限規則擋的 → rows=0（Postgres 不報錯）；觸發器擋的 → err:42501。

-- ── 人物與資料 ──
-- emp1 員工（流程 A）、sup1 主管（流程 A 第 1 關）、boss 老闆（流程 A 第 2 關；自己用沒有關卡的流程 N）
-- sup2 主管（不在任何流程）、hr HR、admin 管理員（不是 HR）
insert into public.approval_flows (id, name, is_default) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '流程 A', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', '流程 N（不需審核）', false);
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'emp1@x', '{"full_name":"emp1"}'),
  ('00000000-0000-0000-0000-000000000002', 'sup1@x', '{"full_name":"sup1"}'),
  ('00000000-0000-0000-0000-000000000003', 'boss@x', '{"full_name":"boss"}'),
  ('00000000-0000-0000-0000-000000000004', 'sup2@x', '{"full_name":"sup2"}'),
  ('00000000-0000-0000-0000-000000000005', 'hr@x',   '{"full_name":"hr"}'),
  ('00000000-0000-0000-0000-000000000006', 'admin@x','{"full_name":"admin"}');
update public.users set role = 'supervisor' where id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004');
update public.users set role = 'boss', default_flow_id = 'aaaaaaaa-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-000000000003';
update public.users set is_finance = true where id = '00000000-0000-0000-0000-000000000005';
update public.users set is_admin = true where id = '00000000-0000-0000-0000-000000000006';
insert into public.approval_flow_steps (flow_id, step_order, approver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 1, '00000000-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 2, '00000000-0000-0000-0000-000000000003');
insert into public.leave_types (id, name) values ('bbbbbbbb-0000-0000-0000-000000000001', '事假');

-- 先確認：修正前這些洞真的存在（證明測試抓得到）
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('修正前：員工能把自己改成管理員',
  t.run($$update public.users set is_admin = true where id = '00000000-0000-0000-0000-000000000001'$$) = 'rows=1');
reset role;
update public.users set is_admin = false where id = '00000000-0000-0000-0000-000000000001';

-- ── 套用修正 ──
\i supabase/migrations/20261110_security_lockdown.sql

-- 每張測試假單由這個函式建立（以管理者身分，不受權限影響）
create function t.new_leave(p_requester uuid, p_flow uuid, p_status text default 'pending',
                            p_step integer default 1, p_registered_by uuid default null) returns uuid
language sql security definer as $$
  insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status, current_step, registered_by)
  values (p_requester, 'bbbbbbbb-0000-0000-0000-000000000001', p_flow, current_date, current_date, '原本的事由', p_status, p_step, p_registered_by)
  returning id
$$;
grant execute on function t.new_leave(uuid, uuid, text, integer, uuid) to authenticated;
create function t.leave(p uuid) returns public.leave_requests language sql security definer as $$
  select * from public.leave_requests where id = p
$$;
grant execute on function t.leave(uuid) to authenticated;
create function t.usr(p uuid) returns public.users language sql security definer as $$
  select * from public.users where id = p
$$;
grant execute on function t.usr(uuid) to anon, authenticated;
create table t.ids (k text primary key, v uuid);
grant all on t.ids to authenticated;

-- ════ 1. 員工資料 ════
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('U1 員工不能把自己改成管理員',
  t.run($$update public.users set is_admin = true where id = '00000000-0000-0000-0000-000000000001'$$) = 'rows=0'
  and not (t.usr('00000000-0000-0000-0000-000000000001')).is_admin);
select t.ok('U2 員工不能把自己改成 HR／老闆',
  t.run($$update public.users set is_finance = true, role = 'boss' where id = '00000000-0000-0000-0000-000000000001'$$) = 'rows=0'
  and (t.usr('00000000-0000-0000-0000-000000000001')).role = 'employee');
select t.ok('U3 員工不能改別人的資料',
  t.run($$update public.users set department = 'x' where id = '00000000-0000-0000-0000-000000000002'$$) = 'rows=0');
select t.ok('U4 員工不能自己新增員工資料',
  t.run($$insert into public.users (id, full_name) values ('00000000-0000-0000-0000-000000000001', 'x')$$) like 'err:%');
select t.ok('U5 切換語言照常可以用',
  t.run($$select public.set_my_language('en')$$) = 'rows=1'
  and (t.usr('00000000-0000-0000-0000-000000000001')).language = 'en');
select t.ok('U6 登入的人讀得到員工名單',
  (select count(*) from public.users) = 6);

select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('U7 管理員照常能改別人的部門、權限、流程（員工帳號管理）',
  t.run($$update public.users set department = '設計部', is_admin = false, default_flow_id = 'aaaaaaaa-0000-0000-0000-000000000001' where id = '00000000-0000-0000-0000-000000000004'$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('U8 HR 照常能改到職日（員工假期管理）',
  t.run($$update public.users set hire_date = '2024-01-01' where id = '00000000-0000-0000-0000-000000000001'$$) = 'rows=1');

set role anon;
select t.as_user(null);
select t.ok('U9 沒登入讀不到員工名單', (select count(*) from public.users) = 0);
select t.ok('U10 沒登入讀不到特休摘要', t.run($$select * from public.annual_leave_summary$$) = 'err:42501');
select t.ok('U11 沒登入不能新增員工資料',
  t.run($$insert into public.users (id, full_name) values ('00000000-0000-0000-0000-000000000009', 'x')$$) like 'err:%');
reset role;
select t.ok('U12 登入的人照常讀得到特休摘要',
  (select count(*) from (select 1) s where (select has_table_privilege('authenticated', 'public.annual_leave_summary', 'select'))) = 1);

-- 新帳號（例如有人自行註冊時偷帶 role = boss）
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000007', 'new@x', '{"full_name":"new","role":"boss"}');
select t.ok('U13 新帳號一律是員工，註冊時帶的角色不算',
  (t.usr('00000000-0000-0000-0000-000000000007')).role = 'employee'
  and (t.usr('00000000-0000-0000-0000-000000000007')).default_flow_id = 'aaaaaaaa-0000-0000-0000-000000000001');

-- ════ 2. 送出假單 ════
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('L1 員工送出假單（審核中）照常可以',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, status, current_step)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', current_date, current_date, 'pending', 1)$$) = 'rows=1');
select t.ok('L2 員工不能直接新增「已核准」的假單',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', current_date, current_date, 'approved')$$) = 'err:42501');
select t.ok('L3 員工不能新增假裝 HR 代登的假單',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, status, registered_by)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', current_date, current_date, 'pending', '00000000-0000-0000-0000-000000000005')$$) like 'err:%');
select t.ok('L4 員工不能替別人送假單',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, status)
          values ('00000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', current_date, current_date, 'pending')$$) like 'err:%');

-- ════ 3. 申請人自己改假單 ════
select t.ok('L5 員工不能把自己的假單改成已核准',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'err:42501');
select t.ok('L6 員工不能改自己假單的日期、事由',
  t.run(format($$update public.leave_requests set reason = '改過', end_date = current_date + 3 where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'err:42501');
select t.ok('L7 員工不能自己跳關',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'err:42501');
select t.ok('L8 撤回審核中的假單照常可以',
  t.run(format($$update public.leave_requests set status = 'withdrawn' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'rows=1');
select t.ok('L9 已核准的假單不能自己撤回（網站本來就只給撤回審核中的）',
  t.run(format($$update public.leave_requests set status = 'withdrawn' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'approved'))) = 'err:42501');
select t.ok('L10 員工把流程清空再自己核准 → 擋下',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', null))) = 'err:42501');
select t.ok('L11 員工用「不需審核」的流程送假單再自己核准 → 擋下（那不是他的流程）',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'))) = 'err:42501');
select t.ok('L12 員工不能替自己的假單新增審核紀錄',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000001', 1, 'approved')$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) like 'err:%');

-- 老闆：流程沒有關卡，送出後直接核准（LeaveForm 的做法）
select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('L13 老闆（不需審核）送出後自己核准照常可以',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002'))) = 'rows=1');

-- ════ 4. 簽核 ════
-- 兩關流程：sup1 第 1 關 → boss 第 2 關（Home.jsx 的做法：先新增審核紀錄，再改假單）
reset role;
insert into t.ids values ('two', t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'));
set role authenticated;

select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('A1 第 2 關的人不能搶先簽第 1 關',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'two'))) in ('rows=0', 'err:42501')
  and (t.leave((select v from t.ids where k = 'two'))).current_step = 1);
select t.ok('A2 第 2 關的人不能搶先新增第 1 關的審核紀錄',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000003', 1, 'approved')$$, (select v from t.ids where k = 'two'))) like 'err:%');

select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('A3 第 1 關不能直接核准（後面還有一關）',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$, (select v from t.ids where k = 'two'))) = 'err:42501');
select t.ok('A4 第 1 關簽核人不能改事由',
  t.run(format($$update public.leave_requests set reason = 'x' where id = %L$$, (select v from t.ids where k = 'two'))) = 'err:42501');
select t.ok('A5 第 1 關新增審核紀錄照常可以',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000002', 1, 'approved')$$, (select v from t.ids where k = 'two'))) = 'rows=1');
select t.ok('A6 第 1 關送到下一關照常可以',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'two'))) = 'rows=1');
select t.ok('A7 第 1 關簽完後不能再簽（已經不是他的關）',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000002', 2, 'approved')$$, (select v from t.ids where k = 'two'))) like 'err:%');

select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('A8 最後一關新增審核紀錄＋核准照常可以',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000003', 2, 'approved')$$, (select v from t.ids where k = 'two'))) = 'rows=1'
  and t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$, (select v from t.ids where k = 'two'))) = 'rows=1');
select t.ok('A9 核准後不能再改',
  t.run(format($$update public.leave_requests set status = 'rejected' where id = %L$$, (select v from t.ids where k = 'two'))) in ('rows=0', 'err:42501')
  and (t.leave((select v from t.ids where k = 'two'))).status = 'approved');

select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('A10 當關駁回照常可以（先新增紀錄再改狀態）',
  (select t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action, comment) values (%L, '00000000-0000-0000-0000-000000000002', 1, 'rejected', '人手不足')$$, x.id)) = 'rows=1'
      and t.run(format($$update public.leave_requests set status = 'rejected' where id = %L$$, x.id)) = 'rows=1'
     from (select t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001') as id) x));

select t.as_user('00000000-0000-0000-0000-000000000004');
select t.ok('A11 不在流程裡的主管不能改別人的假單（以前可以改任何欄位）',
  t.run(format($$update public.leave_requests set status = 'approved', reason = 'x' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'rows=0');
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('A12 管理員（不是簽核人、不是 HR）不能改別人的假單',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'err:42501');

-- ════ 5. HR 代登、確認、異議、HR 修改 ════
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('H1 HR 代登（已核准）照常可以',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, status, registered_by, ack_deadline)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', current_date, current_date, 'approved', '00000000-0000-0000-0000-000000000005', now() + interval '3 days')$$) = 'rows=1');
select t.ok('H2 HR 修改假單照常可以',
  t.run(format($$update public.leave_requests set reason = 'HR 修正', hours = 4 where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'approved'))) = 'rows=1');

reset role;
insert into t.ids values ('reg', t.new_leave('00000000-0000-0000-0000-000000000001', null, 'approved', 1, '00000000-0000-0000-0000-000000000005'));
insert into t.ids values ('reg2', t.new_leave('00000000-0000-0000-0000-000000000001', null, 'approved', 1, '00000000-0000-0000-0000-000000000005'));
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('H3 同仁確認 HR 代登的假單照常可以',
  t.run(format($$update public.leave_requests set acknowledged_at = now(), auto_acknowledged = false where id = %L$$, (select v from t.ids where k = 'reg'))) = 'rows=1');
select t.ok('H4 同仁對 HR 代登的假單提出異議照常可以',
  t.run(format($$update public.leave_requests set disputed_at = now(), dispute_reason = '那天有上班' where id = %L$$, (select v from t.ids where k = 'reg2'))) = 'rows=1');
select t.ok('H5 同仁不能改 HR 代登假單的日期、狀態',
  t.run(format($$update public.leave_requests set status = 'withdrawn', end_date = current_date + 5 where id = %L$$, (select v from t.ids where k = 'reg2'))) = 'err:42501');

-- ════ 6. 後台程式（Slack 互動、每日排程）════
reset role;
select t.as_user(null);
set role service_role;
select t.ok('S1 後台程式（service role）照常能改假單（Slack 核准、自動確認）',
  t.run(format($$update public.leave_requests set status = 'approved', auto_acknowledged = true where id = %L$$,
    t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'))) = 'rows=1');
select t.ok('S2 後台程式照常能新增假單（Slack 請假）',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', current_date, current_date, 'approved')$$) = 'rows=1');

-- ════ 7. 通知對象 ════
reset role;
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('N1 管理員現在能新增通知對象（以前寫不進去）',
  t.run($$insert into public.notification_targets (user_id) values ('00000000-0000-0000-0000-000000000002')$$) = 'rows=1');
select t.ok('N2 管理員能停用、移除通知對象',
  t.run($$update public.notification_targets set is_active = false$$) = 'rows=1'
  and t.run($$delete from public.notification_targets$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('N3 一般員工不能改通知對象',
  t.run($$insert into public.notification_targets (user_id) values ('00000000-0000-0000-0000-000000000001')$$) like 'err:%');

-- ════ 結果 ════
reset role;
select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
