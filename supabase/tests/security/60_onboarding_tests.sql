-- migrations/20261121_slack_onboarding.sql 的測試。接在 10_tests.sql 後面跑（00 → 10 → 60）。
-- 人物：emp1 員工、sup1 主管、hr HR、admin 管理員

\i supabase/migrations/20261121_slack_onboarding.sql
\i supabase/migrations/20261121_slack_onboarding.sql

-- 後台程式（Slack）寫入一筆新人申請
set role service_role;
select t.ok('N1 後台程式（Slack）寫得進開通申請',
  t.run($$insert into public.onboarding_requests (slack_user_id, full_name, email, job_title, department)
          values ('U0NEWHIRE1', '新人甲', 'new1@x', '設計師', '設計部')$$) = 'rows=1');
select t.ok('N2 同一個 Slack 帳號重新送出：更新那一筆（不會多一筆）',
  t.run($$insert into public.onboarding_requests (slack_user_id, full_name, email) values ('U0NEWHIRE1', '新人甲（改）', 'new1@x')
          on conflict (slack_user_id) do update set full_name = excluded.full_name$$) = 'rows=1'
  and (select count(*) from public.onboarding_requests) = 1);
reset role;

set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('N3 HR 看得到待開通', (select count(*) from public.onboarding_requests) = 1);
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('N4 管理員看得到待開通', (select count(*) from public.onboarding_requests) = 1);
select t.ok('N5 管理員也不能直接改（要走 manage-users）',
  t.run($$update public.onboarding_requests set status = 'approved'$$) like 'err:%');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('N6 一般員工看不到', (select count(*) from public.onboarding_requests) = 0);
select t.ok('N7 一般員工不能新增（假冒新人）',
  t.run($$insert into public.onboarding_requests (slack_user_id, full_name, email) values ('U0FAKE', 'x', 'x@x')$$) like 'err:%');
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('N8 主管看不到', (select count(*) from public.onboarding_requests) = 0);
reset role;
set role anon;
select t.ok('N9 沒登入讀不到', t.run($$select * from public.onboarding_requests$$) like 'err:%');
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results where name like 'N_ %' order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
