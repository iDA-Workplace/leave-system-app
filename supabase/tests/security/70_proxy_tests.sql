-- migrations/20261122_proxy_approval.sql 的測試。00 → 10 → 40 → 70（40 建好考核替身與 app_badge_count）。
-- 人物：emp1 員工（流程 A：第 1 關 sup1、第 2 關 boss）、sup1 主管、boss 老闆（流程 N 不需審核）、
--       sup2 主管、hr HR、admin 管理員

alter table public.leave_types add column if not exists name_en text;   -- 正式資料庫有（20260817），替身沒有
-- 假單資料權限（20261117）要先套上：代理人讀不到完整假單。儲存空間的替身照 30_privacy_tests.sql
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default true);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
insert into storage.buckets values ('leave-attachments', 'leave-attachments', true) on conflict do nothing;
\i supabase/migrations/20261117_leave_privacy.sql
\i supabase/migrations/20261122_proxy_approval.sql
\i supabase/migrations/20261122_proxy_approval.sql

delete from public.leave_approvals;
delete from public.leave_requests;
truncate t.ids;

-- 共用：用目前身分送出一張假單（流程 A、明年的日期），回傳 'rows=1' 或錯誤碼
create function t.submit(p_requester uuid, p_flow uuid, p_proxy uuid, p_extra text default '') returns text language plpgsql as $$
begin
  return t.run(format($q$insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status, proxy_user_id %s)
                        values (%L, 'bbbbbbbb-0000-0000-0000-000000000001', %L, '2027-03-02', '2027-03-02', 'x', 'pending', %L %s)$q$,
                   case when p_extra = '' then '' else ', proxy_status' end,
                   p_requester, p_flow, p_proxy,
                   case when p_extra = '' then '' else ', ' || quote_literal(p_extra) end));
end $$;
grant execute on function t.submit(uuid, uuid, uuid, text) to authenticated, service_role;

-- 共用：以管理者身分讀某張假單的欄位（不受權限影響）
create function t.lr(p_requester uuid) returns public.leave_requests language sql security definer as $$
  select * from public.leave_requests where requester_id = p_requester order by created_at desc limit 1
$$;
grant execute on function t.lr(uuid) to authenticated, service_role;

set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('X1 沒填職務代理人：送不出去',
  t.submit('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', null) like 'err:%');
select t.ok('X2 代理人填自己：送不出去',
  t.submit('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001') like 'err:%');
select t.ok('X3 填代理人（admin）：送得出去，而且從「待代理人確認」開始（就算自己填 approved 也一樣）',
  t.submit('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000006', 'approved') = 'rows=1'
  and (t.lr('00000000-0000-0000-0000-000000000001')).proxy_status = 'pending');
reset role;
insert into t.ids values ('A', (t.lr('00000000-0000-0000-0000-000000000001')).id);
set role authenticated;

select t.ok('X4 申請人不能自己把代理人那關改成同意',
  t.run(format($$update public.leave_requests set proxy_status = 'approved' where id = %L$$, (select v from t.ids where k = 'A'))) like 'err:%');

select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('X5 代理人還沒同意：第 1 關主管不能核准（往下一關）',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'A'))) like 'err:%');
select t.ok('X6 代理人還沒同意：第 1 關主管也不能寫簽核紀錄',
  t.run(format($$insert into public.leave_approvals (request_id, approver_id, step_order, action) values (%L, '00000000-0000-0000-0000-000000000002', 1, 'approved')$$, (select v from t.ids where k = 'A'))) like 'err:%');
select t.ok('X7 不是代理人：待確認清單是空的', (select count(*) from public.my_proxy_requests()) = 0);
select t.ok('X8 不是代理人：不能替他回覆', public.proxy_decide((select v from t.ids where k = 'A'), true) = 'not_proxy');

select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('X9 代理人：待確認清單看得到這張（誰、什麼假、哪天）',
  (select count(*) from public.my_proxy_requests() where requester_name = 'emp1' and start_date = '2027-03-02') = 1);
select t.ok('X10 代理人：還是讀不到完整假單（看不到事由與附件）',
  (select count(*) from public.leave_requests where id = (select v from t.ids where k = 'A')) = 0);
select t.ok('X11 代理人同意 → 接著走簽核流程（假單還是審核中）',
  public.proxy_decide((select v from t.ids where k = 'A'), true) = 'approved'
  and (t.lr('00000000-0000-0000-0000-000000000001')).proxy_status = 'approved'
  and (t.lr('00000000-0000-0000-0000-000000000001')).status = 'pending');
select t.ok('X12 已經回覆過：不能再回覆一次', public.proxy_decide((select v from t.ids where k = 'A'), false, 'x') = 'already_handled');

select t.as_user('00000000-0000-0000-0000-000000000002');
select t.ok('X13 代理人同意之後：第 1 關主管可以核准（往下一關）',
  t.run(format($$update public.leave_requests set current_step = 2 where id = %L$$, (select v from t.ids where k = 'A'))) = 'rows=1');

-- 不能代理 → 退回
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('X14 再送一張，代理人 sup2',
  t.submit('00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004') = 'rows=1');
reset role;
insert into t.ids values ('B', (t.lr('00000000-0000-0000-0000-000000000001')).id);
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000004');
select t.ok('X15 不能代理一定要寫原因', public.proxy_decide((select v from t.ids where k = 'B'), false, '  ') = 'reason_required');
select t.ok('X16 不能代理＋原因 → 假單退回給申請人，原因記下來',
  public.proxy_decide((select v from t.ids where k = 'B'), false, '那週出差') = 'returned'
  and (t.lr('00000000-0000-0000-0000-000000000001')).status = 'returned'
  and (t.lr('00000000-0000-0000-0000-000000000001')).proxy_status = 'rejected'
  and (t.lr('00000000-0000-0000-0000-000000000001')).returned_reason = '那週出差');

-- 流程沒有關卡（老闆）：代理人同意就直接核准
select t.as_user('00000000-0000-0000-0000-000000000003');
select t.ok('X17 老闆送假單（代理人 emp1）', t.submit('00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001') = 'rows=1');
select t.ok('X18 老闆不能在代理人同意前自己核准',
  t.run(format($$update public.leave_requests set status = 'approved' where id = %L$$, (t.lr('00000000-0000-0000-0000-000000000003')).id)) like 'err:%');
select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('X19 代理人同意 → 流程沒有關卡，直接核准',
  public.proxy_decide((t.lr('00000000-0000-0000-0000-000000000003')).id, true) = 'approved_final'
  and (t.lr('00000000-0000-0000-0000-000000000003')).status = 'approved');

-- HR 代登維持現狀
select t.as_user('00000000-0000-0000-0000-000000000005');
select t.ok('X20 HR 代登：不填代理人也可以、不用代理人確認',
  t.run($$insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, reason, status, registered_by)
          values ('00000000-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', '2027-03-03', '2027-03-03', 'x', 'approved', '00000000-0000-0000-0000-000000000005')$$) = 'rows=1'
  and (t.lr('00000000-0000-0000-0000-000000000004')).proxy_status is null);

-- 圖示數字（後台算的：沒有登入身分）
reset role;
select t.as_user(null);
insert into public.leave_requests (requester_id, leave_type_id, flow_id, start_date, end_date, reason, status, proxy_user_id)
  values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2027-04-01', '2027-04-01', 'x', 'pending', '00000000-0000-0000-0000-000000000006');
select t.ok('X22 圖示數字：待我確認的代理有算進去（admin）', public.app_badge_count('00000000-0000-0000-0000-000000000006') = 1);
select t.ok('X23 圖示數字：還在等代理人的假單，第 1 關主管不算（sup1 只有考核的 1 件）',
  public.app_badge_count('00000000-0000-0000-0000-000000000002') = 1);

set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('X24 網頁不能直接呼叫後台用的 proxy_decide_as',
  t.run(format($$select public.proxy_decide_as('00000000-0000-0000-0000-000000000006', %L, true)$$, (select v from t.ids where k = 'A'))) like 'err:%');
reset role;
set role anon;
select t.ok('X25 沒登入不能看待確認清單', t.run($$select * from public.my_proxy_requests()$$) like 'err:%');
reset role;
set role service_role;
select t.ok('X26 後台（Slack）代代理人回覆',
  public.proxy_decide_as('00000000-0000-0000-0000-000000000006',
    (select id from public.leave_requests where start_date = '2027-04-01'), true) = 'approved');
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results where name like 'X%' order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
