-- migrations/20261117_leave_privacy.sql 的測試。接在 10_tests.sql 後面跑。
-- 人物（10_tests.sql 建的）：emp1 員工（流程 A）、sup1 主管（流程 A 第 1 關）、boss 老闆（流程 A 第 2 關）、
-- sup2 主管（不在任何流程，這裡設成 emp1 的直屬主管）、hr HR、admin 管理員（不是 HR）

-- ── 儲存空間的替身（Supabase 的 storage.buckets / storage.objects，只留用得到的欄位）──
create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean default true);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
insert into storage.buckets values ('leave-attachments', 'leave-attachments', true);
create policy "leave-attachments public read" on storage.objects for select to public using (bucket_id = 'leave-attachments');
create policy "leave-attachments authenticated upload" on storage.objects for insert to authenticated with check (bucket_id = 'leave-attachments');

alter table public.leave_types add column if not exists name_en text;   -- 正式資料庫有（20260817），替身沒有

-- 測試資料
update public.users set manager_id = '00000000-0000-0000-0000-000000000004' where id = '00000000-0000-0000-0000-000000000001';
truncate t.ids;
insert into t.ids values
  ('L1', t.new_leave('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')),                 -- emp1 審核中（流程 A 第 1 關）
  ('L3', t.new_leave('00000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'approved'));     -- sup1 已核准
update public.leave_requests
   set proxy_user_id = '00000000-0000-0000-0000-000000000006',
       attachment_url = 'https://x.supabase.co/storage/v1/object/public/leave-attachments/00000000-0000-0000-0000-000000000001/1-%E8%A8%BA%E6%96%B7%E6%9B%B8.pdf'
 where id = (select v from t.ids where k = 'L1');
insert into storage.objects (bucket_id, name) values
  ('leave-attachments', '00000000-0000-0000-0000-000000000001/1-診斷書.pdf'),
  ('leave-attachments', '00000000-0000-0000-0000-000000000003/9-別人的.pdf');

-- 修正前：誰都讀得到 emp1 的事由
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('修正前：管理員讀得到 emp1 的事由',
  (select count(*) from public.leave_requests where id = (select v from t.ids where k = 'L1') and reason is not null) = 1);
reset role;

\i supabase/migrations/20261117_leave_privacy.sql

-- 共用：讀得到這張假單幾列
create function t.sees(p_key text) returns bigint language sql as $$
  select count(*) from public.leave_requests where id = (select v from t.ids where k = p_key)
$$;
grant execute on function t.sees(text) to authenticated;

set role authenticated;

-- ════ 1. 誰看得到完整假單 ════
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('P1 本人看得到自己的假單（含事由）',
  (select reason from public.leave_requests where id = (select v from t.ids where k = 'L1')) = '原本的事由');
select t.ok('P2 本人讀不到別人的假單（資料表）', t.sees('L3') = 0);
select t.ok('P3 別人的「已核准」假單從日曆函式看得到：誰、哪天（沒有事由欄位）',
  (select count(*) from public.approved_leaves_between(current_date, current_date) where requester_name = 'sup1') = 1);
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('P4 日曆函式不給「審核中」的假單', not exists (
  select 1 from public.approved_leaves_between(current_date, current_date) where id = (select v from t.ids where k = 'L1')));

select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('P5 輪到的簽核人（第 1 關）看得到', t.sees('L1') = 1);
select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('P6 還沒輪到的簽核人（第 2 關）也看得到（流程裡的簽核人都看得到）', t.sees('L1') = 1);
select t.as_user('00000000-0000-0000-0000-000000000004');
select t.ok('P7 直屬主管（不在流程裡）看得到部屬的假單', t.sees('L1') = 1);
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('P8 HR 看得到全部', t.sees('L1') = 1 and t.sees('L3') = 1);
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('P9 管理員（不是 HR）、而且是職務代理人：讀不到那張假單', t.sees('L1') = 0);
select t.as_user(null);
select t.ok('P10 沒登入：日曆函式什麼都沒有', (select count(*) from public.approved_leaves_between('2000-01-01', '2100-01-01')) = 0);

-- ════ 2. 原本的流程照常（讀取規則改了之後） ════
select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('F1 第 1 關核准照常可以（寫簽核紀錄、往下一關）',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000002', 1, 'approved')$$, (select v from t.ids where k = 'L1'))) = 'rows=1'
  and t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'L1'))) = 'rows=1');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('F2 申請人新增假單、回傳新假單照常可以',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status)
          values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', current_date, current_date, 'x', 'pending') returning id$$) = 'rows=1');

-- ════ 3. 簽核紀錄跟著假單走 ════
select t.ok('A1 申請人看得到自己假單的簽核紀錄',
  (select count(*) from public.leave_approvals where request_id = (select v from t.ids where k = 'L1')) = 1);
select t.as_user('00000000-0000-0000-0000-000000000004');
select t.ok('A2 直屬主管看得到部屬假單的簽核紀錄', (select count(*) from public.leave_approvals where request_id = (select v from t.ids where k = 'L1')) = 1);
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('A3 HR 看得到簽核紀錄（以前讀不到別人的）', (select count(*) from public.leave_approvals where request_id = (select v from t.ids where k = 'L1')) = 1);
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('A4 管理員看不到別人的簽核紀錄', (select count(*) from public.leave_approvals where request_id = (select v from t.ids where k = 'L1')) = 0);

-- ════ 4. 附件 ════
reset role;
select t.ok('S0 附件路徑從網址補好了（中文檔名解碼）',
  (select attachment_path from public.leave_requests where id = (select v from t.ids where k = 'L1')) = '00000000-0000-0000-0000-000000000001/1-診斷書.pdf');
select t.ok('S1 儲存空間改成不公開', not (select public from storage.buckets where id = 'leave-attachments'));
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000004');
select t.ok('S2 直屬主管開得了部屬的附件', (select count(*) from storage.objects where name like '00000000-0000-0000-0000-000000000001/%') = 1);
select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('S3 流程裡的簽核人開得了附件', (select count(*) from storage.objects where name like '00000000-0000-0000-0000-000000000001/%') = 1);
select t.ok('S4 上傳的本人開得了自己資料夾的檔案', (select count(*) from storage.objects where name like '00000000-0000-0000-0000-000000000003/%') = 1);
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('S5 管理員（職務代理人）開不了', (select count(*) from storage.objects) = 0);
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('S6 只能上傳到自己的資料夾',
  t.run($$insert into storage.objects (bucket_id, name) values ('leave-attachments', '00000000-0000-0000-0000-000000000001/2-x.pdf')$$) = 'rows=1'
  and t.run($$insert into storage.objects (bucket_id, name) values ('leave-attachments', '00000000-0000-0000-0000-000000000002/2-x.pdf')$$) like 'err:%');
reset role;

-- ════ 結果 ════
select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
