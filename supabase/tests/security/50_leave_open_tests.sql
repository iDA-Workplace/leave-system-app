-- migrations/20261120_leave_from_2027.sql 的測試。接在 10_tests.sql 後面跑（00 → 10 → 50）。
-- 人物（10_tests.sql 建的）：emp1 員工（流程 A）、sup1 主管（流程 A 第 1 關）、hr HR

-- 套用前先建一張 2026 的舊假單（測試資料），確認套用後它照常能走流程
truncate t.ids;
insert into t.ids values ('OLD', t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'));
update public.leave_requests set start_date = '2026-12-15', end_date = '2026-12-15' where id = (select v from t.ids where k = 'OLD');

\i supabase/migrations/20261120_leave_from_2027.sql
\i supabase/migrations/20261120_leave_from_2027.sql

set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('O1 同仁請 2026/12/31 的假：擋下',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-12-31', '2026-12-31', 'x', 'pending')$$) like 'err:%');
select t.ok('O2 跨年（12/31～1/4）：開始日在 2026，擋下',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-12-31', '2027-01-04', 'x', 'pending')$$) like 'err:%');
select t.ok('O3 請 2027/1/4（第一個上班日）：可以',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2027-01-04', '2027-01-04', 'x', 'pending')$$) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('O4 HR 代登 2026 的假：也擋下',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, reason, status, registered_by)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '2026-12-28', '2026-12-28', 'x', 'approved', '00000000-0000-0000-0000-000000000005')$$) like 'err:%');
select t.ok('O5 HR 把假單日期改到 2026：擋下',
  t.run(format($$update public.leave_requests set start_date = '2026-12-30', end_date = '2026-12-30' where id = %L$$, (select v from t.ids where k = 'OLD'))) like 'err:%');
select t.ok('O6 舊的 2026 假單：只改事由（日期沒動）照常可以',
  t.run(format($$update public.leave_requests set reason = '改事由' where id = %L$$, (select v from t.ids where k = 'OLD'))) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('O7 舊的 2026 假單：第 1 關主管核准（往下一關）照常可以',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'OLD'))) = 'rows=1');
reset role;
set role service_role;
select t.ok('O8 後台程式（Slack 請假）請 2026 的假：也擋下',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-20', '2026-11-20', 'x', 'pending')$$) like 'err:%');
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results where name like 'O%' order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
