-- 20261020_massage_slack.sql 的測試（接在 10_tests.sql 之後跑，沿用它留下的資料）
truncate t.results;
reset role;

-- 清空，讓結果可預期
delete from public.massage_notify_log;
delete from public.massage_jobs;

-- 1. 權限：登入的人不能碰
set role authenticated;
do $$ begin
  perform public.massage_notify_claim(10);
  perform t.ok('slack: authenticated 不能 claim', false);
exception when insufficient_privilege then
  perform t.ok('slack: authenticated 不能 claim', true);
end $$;
do $$ begin
  perform count(*) from public.massage_jobs;
  perform t.ok('slack: authenticated 讀不到 massage_jobs', false);
exception when insufficient_privilege then
  perform t.ok('slack: authenticated 讀不到 massage_jobs', true);
end $$;
reset role;

-- 2. claim：一次拿一批、照順序；同一筆不會被拿兩次
set role service_role;
create temp table c1 as select id from public.massage_notify_claim(5);
create temp table c2 as select id from public.massage_notify_claim(5);
select t.ok('slack: 第一次拿到 5 筆', (select count(*) from c1) = 5);
select t.ok('slack: 第二次拿到的跟第一次不重複', not exists (select 1 from c1 join c2 using (id)));
select t.ok('slack: 依 id 由小到大',
  (select max(id) from c1) < (select min(id) from c2));

-- 3. 完成標記
select public.massage_notify_done(id) from c1;
select t.ok('slack: 標記完成', (select count(*) from public.massage_notify_log where sent_at is not null) = 5);

-- 4. 沒完成的、超過 5 分鐘 → 重試；完成的不會再出現
reset role;
update public.massage_notify_log set claimed_at = now() - interval '6 minutes';
set role service_role;
create temp table c3 as select id from public.massage_notify_claim(100000);
select t.ok('slack: 逾時沒完成的會再拿出來', (select count(*) from c2 join c3 using (id)) = 5);
select t.ok('slack: 已完成的不會再拿出來', not exists (select 1 from c1 join c3 using (id)));
reset role;
select t.ok('slack: 重試次數 +1',
  (select min(attempts) from public.massage_notify_log l join c2 on c2.id = l.event_id) = 2);

-- 5. 最多 3 次
update public.massage_notify_log set claimed_at = now() - interval '6 minutes', attempts = 3 where sent_at is null;
set role service_role;
select t.ok('slack: 試過 3 次就放棄', (select count(*) from public.massage_notify_claim(100000)) = 0);
reset role;

-- 6. 只看 2 天內
delete from public.massage_notify_log;
alter table public.massage_events disable trigger massage_events_no_update;
update public.massage_events set created_at = now() - interval '3 days' where id in (select id from c1);
alter table public.massage_events enable trigger massage_events_no_update;
set role service_role;
create temp table c4 as select id from public.massage_notify_claim(100000);
select t.ok('slack: 超過 2 天的不發', not exists (select 1 from c1 join c4 using (id)));
select t.ok('slack: 2 天內的都拿得到', (select count(*) from c4) = (select count(*) from public.massage_events) - 5);

-- 7. job：同一件事只做一次
select t.ok('slack: job 第一次 = true', public.massage_job_claim('ask_attendance:x'));
select t.ok('slack: job 第二次 = false', not public.massage_job_claim('ask_attendance:x'));
select t.ok('slack: 不同 job 互不影響', public.massage_job_claim('ask_attendance:y'));
reset role;

select name, pass, detail from t.results order by n;
select format('%s / %s 通過', count(*) filter (where pass), count(*)) from t.results;
