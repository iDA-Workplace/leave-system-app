-- migrations/20261124_massage_transfer.sql 的測試（管理員把 A 的按摩時段換給 B）。00 → 10 → 80。
-- 人物（10_tests 建的）：1 emp1、2 sup1、3 boss、4 sup2、5 hr、6 admin、7 new（員工）

-- 正式資料庫有、替身沒有的東西
alter table public.leave_types add column if not exists name_en text;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

\i supabase/migrations/20261019_massage_booking.sql
\i supabase/migrations/20261020_massage_slack.sql
\i supabase/migrations/20261021_massage_add_to_slot.sql
\i supabase/migrations/20261022_massage_hide_sessions.sql
\i supabase/migrations/20261023_massage_realtime.sql
\i supabase/migrations/20261024_massage_close_signup.sql
\i supabase/migrations/20261025_massage_announcements.sql
\i supabase/migrations/20261026_massage_release_hold.sql
\i supabase/migrations/20261111_massage_test_mode.sql
\i supabase/migrations/20261124_massage_transfer.sql
\i supabase/migrations/20261124_massage_transfer.sql

-- 一期：後天、已抽籤、釋出等待期已過（已開放）
insert into public.massage_sessions (id, title, session_date, start_time, slot_count, signup_deadline, cancel_deadline,
                                     drawn_at, release_open_at, release_opened_at)
values ('cccccccc-0000-0000-0000-000000000001', '測試期', (now() at time zone 'Asia/Taipei')::date + 2, '13:00', 4,
        now() - interval '2 days', now() + interval '1 day', now() - interval '1 day', now() - interval '1 hour', now() - interval '1 hour');
-- 另一期：今天 00:00 開始（第 1 個時段已經開始）
insert into public.massage_sessions (id, title, session_date, start_time, slot_count, signup_deadline, cancel_deadline,
                                     drawn_at, release_open_at, release_opened_at)
values ('cccccccc-0000-0000-0000-000000000002', '今天的期', (now() at time zone 'Asia/Taipei')::date, '00:00', 4,
        now() - interval '2 days', now() - interval '1 day', now() - interval '1 day', now() - interval '1 hour', now() - interval '1 hour');

-- 抽籤狀態只能由抽籤功能寫入（觸發器擋），測試資料直接開那個開關
select set_config('massage.in_draw', 'on', false);
update public.massage_sessions set drawn_at = now() - interval '1 day' where id::text like 'cccccccc-%';
select set_config('massage.in_draw', 'off', false);

-- emp1 時段 1、sup1 時段 2、sup2 候補（手上有時段 4 的遞補邀請）、boss 抽籤後取消過、new 沒報名
insert into public.massage_signups (id, session_id, user_id, draw_rank, result, slot_no) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'selected', 1),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 2, 'selected', 2);
insert into public.massage_signups (id, session_id, user_id, draw_rank, result, offer_slot_no, offer_status, offered_at) values
  ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 5, 'waitlist', 4, 'pending', now());
insert into public.massage_signups (id, session_id, user_id, draw_rank, result, released_at, released_late, attendance) values
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 3, 'selected', now() - interval '1 hour', true, 'no_show');
insert into public.massage_signups (id, session_id, user_id, draw_rank, result, slot_no) values
  ('dddddddd-0000-0000-0000-000000000009', 'cccccccc-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 1, 'selected', 1);

create function t.sg(p uuid) returns public.massage_signups language sql security definer as $$
  select * from public.massage_signups where id = p
$$;
create function t.sgu(p_session uuid, p_user uuid) returns public.massage_signups language sql security definer as $$
  select * from public.massage_signups where session_id = p_session and user_id = p_user
$$;
create function t.ev(p_signup uuid, p_event text) returns public.massage_events language sql security definer as $$
  select * from public.massage_events where signup_id = p_signup and event = p_event order by id desc limit 1
$$;
grant execute on all functions in schema t to anon, authenticated, service_role;

set role authenticated;

select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('M1 一般同仁不能換人（不能自己轉讓）',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007', '想讓給 new') ->> 'code' = 'not_allowed');
select t.ok('M2 一般同仁也不能直接改報名資料',
  t.run($$update public.massage_signups set user_id = '00000000-0000-0000-0000-000000000007' where id = 'dddddddd-0000-0000-0000-000000000001'$$) in ('err:42501', 'rows=0'));

select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('M3 沒寫說明：不能換',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007', '   ') ->> 'code' = 'note_required');
select t.ok('M4 換給這期已經有時段的人：不行（一人一個時段）',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'x') ->> 'code' = 'already_has_slot');
select t.ok('M5 換給自己：不行',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'x') ->> 'code' = 'same_person');
select t.ok('M6 時段已經開始：不能換',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000007', 'x') ->> 'code' = 'slot_started');

select t.ok('M7 管理員把 emp1 的時段 1 換給這期沒報名的 new',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007', '臨時出差') ->> 'via' = 'added');
select t.ok('M8 emp1：記為讓給 new、時段清空（不算取消、不算未到）',
  (t.sg('dddddddd-0000-0000-0000-000000000001')).transferred_to = '00000000-0000-0000-0000-000000000007'
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).transferred_slot_no = 1
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).slot_no is null
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).released_at is not null
  and not (t.sg('dddddddd-0000-0000-0000-000000000001')).released_late
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).attendance is null);
select t.ok('M9 new：拿到時段 1，記下是從 emp1 接手',
  (t.sgu('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007')).slot_no = 1
  and (t.sgu('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007')).received_from = '00000000-0000-0000-0000-000000000001');
select t.ok('M10 異動紀錄：讓出、接手各一筆，說明有記下來、記是哪位管理員',
  (t.ev('dddddddd-0000-0000-0000-000000000001', 'transferred_out')).details ->> 'note' = '臨時出差'
  and (t.ev('dddddddd-0000-0000-0000-000000000001', 'transferred_out')).actor_id = '00000000-0000-0000-0000-000000000006'
  and (t.ev((t.sgu('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007')).id, 'transferred_in')).details ->> 'from_user_id' = '00000000-0000-0000-0000-000000000001');
select t.ok('M11 等待期的「釋出中」不會把讓出的時段算進去',
  public.massage_held_slots('cccccccc-0000-0000-0000-000000000001') = '{}');

select t.as_user('00000000-0000-0000-0000-000000000001');
select t.ok('M12 emp1 不能用「取消釋出」把時段拿回來',
  public.massage_cancel_release('dddddddd-0000-0000-0000-000000000001') ->> 'ok' = 'false');
select t.ok('M13 emp1 不能再「釋出名額」',
  coalesce(public.massage_release('dddddddd-0000-0000-0000-000000000001') ->> 'ok', 'false') = 'false');

select t.as_user('00000000-0000-0000-0000-000000000005');   -- HR 也可以
select t.ok('M14 HR 把 sup1 的時段 2 換給候補中的 sup2（他手上時段 4 的邀請作廢）',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004', '交換') ->> 'via' = 'waitlist'
  and (t.sg('dddddddd-0000-0000-0000-000000000004')).slot_no = 2
  and (t.sg('dddddddd-0000-0000-0000-000000000004')).result = 'selected'
  and (t.sg('dddddddd-0000-0000-0000-000000000004')).offer_status = 'superseded');

select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('M15 這期取消過（逾期被記未到）的 boss 接手 new 的時段 1：未到的紀錄清掉',
  public.massage_transfer_slot((t.sgu('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007')).id,
                               '00000000-0000-0000-0000-000000000003', '再換一次') ->> 'via' = 'reactivated'
  and (t.sg('dddddddd-0000-0000-0000-000000000003')).slot_no = 1
  and (t.sg('dddddddd-0000-0000-0000-000000000003')).released_at is null
  and (t.sg('dddddddd-0000-0000-0000-000000000003')).attendance is null
  and (t.sgu('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007')).transferred_to = '00000000-0000-0000-0000-000000000003');

-- 撞到請假：先提醒，確認後仍然可以換
reset role;
insert into public.leave_types (id, name) values ('bbbbbbbb-0000-0000-0000-0000000000ff', '特休') on conflict do nothing;
insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, status)
values ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000ff',
        (now() at time zone 'Asia/Taipei')::date + 2, (now() at time zone 'Asia/Taipei')::date + 2, 'approved');
set role authenticated;
select t.as_user('00000000-0000-0000-0000-000000000006');
select t.ok('M16 換給當天請假的人：先提醒',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'x') ->> 'code' = 'leave_conflict_confirm'
  and (t.sg('dddddddd-0000-0000-0000-000000000003')).slot_no = 1);
select t.ok('M17 確認後仍然可以換（標示撞到請假）；之前讓出去的 emp1 也可以再拿回來',
  public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'x', true) ->> 'via' = 'reactivated'
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).slot_no = 1
  and (t.sg('dddddddd-0000-0000-0000-000000000001')).slot_conflict);

reset role;
set role anon;
select t.ok('M18 沒登入不能呼叫',
  t.run($$select public.massage_transfer_slot('dddddddd-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000007', 'x')$$) like 'err:%');
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from t.results where name like 'M%' order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
