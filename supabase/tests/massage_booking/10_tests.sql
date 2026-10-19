\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- ===== 測試資料 =====
create function t.e(n int) returns uuid language sql immutable as $$
  select ('eeeeeeee-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
grant execute on function t.e(int) to authenticated, anon, service_role;
create function t.td() returns date language sql stable as $$
  select (now() at time zone 'Asia/Taipei')::date
$$;
grant execute on function t.td() to authenticated, anon, service_role;

insert into public.users (id, full_name, is_admin) values ('aaaaaaaa-0000-0000-0000-000000000001', '管理員', true);
insert into public.users (id, full_name, is_finance) values ('aaaaaaaa-0000-0000-0000-000000000002', 'HR', true);
insert into public.users (id, full_name, is_active) values ('aaaaaaaa-0000-0000-0000-000000000099', '離職的人', false);
insert into public.users (id, full_name) select t.e(n), '員工' || n from generate_series(1, 400) n;

insert into public.leave_types (id, name, name_en, is_wfh) values
  ('11111111-0000-0000-0000-000000000001', '事假', 'Personal', false),
  ('11111111-0000-0000-0000-000000000002', 'WFH', 'WFH', true);

-- 期數（以 superuser 直接建，created_by 留空）
create function t.mk(p_id uuid, p_date date) returns void language sql as $$
  insert into public.massage_sessions (id, title, session_date, signup_deadline, cancel_deadline)
  values (p_id, '測試 ' || p_date, p_date,
          now() + interval '1 hour',
          ((p_date + time '12:00') at time zone 'Asia/Taipei'))
$$;
create function t.close(p_id uuid) returns void language sql as $$
  update public.massage_sessions set signup_deadline = now() - interval '1 minute' where id = p_id
$$;
create function t.sid(p_session uuid, p_user uuid) returns uuid language sql stable as $$
  select id from public.massage_signups where session_id = p_session and user_id = p_user
$$;
create function t.byrank(p_session uuid, p_rank int) returns uuid language sql stable as $$
  select id from public.massage_signups where session_id = p_session and draw_rank = p_rank
$$;
create function t.uidrank(p_session uuid, p_rank int) returns uuid language sql stable as $$
  select user_id from public.massage_signups where session_id = p_session and draw_rank = p_rank
$$;
grant execute on function t.sid(uuid, uuid), t.byrank(uuid, int), t.uidrank(uuid, int) to authenticated;

-- S1：報名與請假衝突（TD+40）
select t.mk('51000000-0000-0000-0000-000000000001', t.td() + 40);

-- 各種假單，都落在 S1 那天
insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, start_time, end_time, status) values
  (t.e(2),  '11111111-0000-0000-0000-000000000001', t.td()+39, t.td()+41, '09:00', '18:00', 'approved'), -- 跨天
  (t.e(3),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '14:00', '18:00', 'pending'),  -- 審核中、下午
  (t.e(4),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '09:00', '12:00', 'approved'), -- 只有上午
  (t.e(5),  '11111111-0000-0000-0000-000000000002', t.td()+40, t.td()+40, '09:00', '18:00', 'approved'), -- WFH
  (t.e(6),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '09:00', '18:00', 'rejected'),
  (t.e(7),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '09:00', '18:00', 'withdrawn'),
  (t.e(8),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '16:00', '18:00', 'approved'), -- 剛好 16:00 開始
  (t.e(9),  '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '12:00', '13:00', 'approved'), -- 剛好 13:00 結束
  (t.e(10), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '15:30', '18:00', 'approved'), -- 撞到最後一段
  (t.e(11), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '12:30', '13:30', 'approved'); -- 撞到第一段

-- ===== 報名 =====
set role authenticated;
select t.as_user(t.e(1));
select t.ok('報名：一般同仁可以報名', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.ok('報名：同一人不能報兩次', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'already_signed_up');

select t.as_user(t.e(2));
select t.ok('請假：跨天假單（整天）→ 擋', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.as_user(t.e(3));
select t.ok('請假：審核中、14:00-18:00 → 擋', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.ok('請假：網頁事先查得到原因（審核中）',
  public.massage_my_leave_conflict('51000000-0000-0000-0000-000000000001')->>'status' = 'pending'
  and public.massage_my_leave_conflict('51000000-0000-0000-0000-000000000001')->>'start_time' = '14:00');
select t.as_user(t.e(4));
select t.ok('請假：只請上午 09:00-12:00 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(5));
select t.ok('請假：WFH → 擋，並回報假別',
  (select r->>'code' = 'leave_conflict' and r->'leave'->>'leave_type' = 'WFH'
     from (select public.massage_sign_up('51000000-0000-0000-0000-000000000001') r) x));
select t.as_user(t.e(6));
select t.ok('請假：已駁回的假單不算 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(7));
select t.ok('請假：已收回的假單不算 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(8));
select t.ok('請假：16:00 才開始請（邊界）→ 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(9));
select t.ok('請假：13:00 就結束（邊界）→ 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(10));
select t.ok('請假：15:30-18:00 → 擋', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.as_user(t.e(11));
select t.ok('請假：12:30-13:30 → 擋', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000099');
select t.ok('報名：停用的帳號不能報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'user_inactive');

-- 抽籤前取消、再報一次 → 排到最後
select t.as_user(t.e(6));
select t.ok('取消：抽籤前取消報名',
  public.massage_release(t.sid('51000000-0000-0000-0000-000000000001', t.e(6)))->>'phase' = 'before_draw');
select t.ok('報名：取消後可以再報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);

-- ===== 寫入權限 =====
do $$ begin
  insert into public.massage_signups (session_id, user_id) values ('51000000-0000-0000-0000-000000000001', t.e(20));
  perform t.ok('權限：不能直接新增報名資料', false);
exception when insufficient_privilege then perform t.ok('權限：不能直接新增報名資料', true);
end $$;
do $$ begin
  update public.massage_signups set slot_no = 1, result = 'selected';
  perform t.ok('權限：不能直接改自己的時段／結果', false);
exception when insufficient_privilege then perform t.ok('權限：不能直接改自己的時段／結果', true);
end $$;
do $$ begin
  perform public.massage_sign_up_as('51000000-0000-0000-0000-000000000001', t.e(30));
  perform t.ok('權限：網頁不能冒用別人身分報名（_as 只給 Slack）', false);
exception when insufficient_privilege then perform t.ok('權限：網頁不能冒用別人身分報名（_as 只給 Slack）', true);
end $$;
do $$ begin
  insert into public.massage_sessions (title, session_date, signup_deadline, cancel_deadline)
  values ('偷開', t.td() + 50, now() + interval '1 day', now() + interval '2 day');
  perform t.ok('權限：一般同仁不能開新的一期', false);
exception when insufficient_privilege then perform t.ok('權限：一般同仁不能開新的一期', true);
end $$;
select t.ok('權限：全公司都看得到報名名單', (select count(*) from public.massage_signups) >= 6);

-- 一般同仁不能抽籤
select t.as_user(t.e(1));
select t.ok('抽籤：一般同仁不能抽', public.massage_run_draw('51000000-0000-0000-0000-000000000001')->>'code' = 'not_allowed');
-- 管理員：報名還沒截止
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('抽籤：報名截止前按不下去', public.massage_run_draw('51000000-0000-0000-0000-000000000001')->>'code' = 'signup_not_closed');
reset role;

set role anon;
do $$ begin
  perform public.massage_sign_up('51000000-0000-0000-0000-000000000001');
  perform t.ok('權限：沒登入的人不能呼叫', false);
exception when insufficient_privilege then perform t.ok('權限：沒登入的人不能呼叫', true);
end $$;
reset role;

-- HR 可以開新的一期；就算硬塞 drawn_at 進來也會被清掉
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
insert into public.massage_sessions (id, title, session_date, signup_deadline, cancel_deadline, drawn_at)
values ('58000000-0000-0000-0000-000000000001', 'HR 開的', t.td() + 70, now() + interval '1 day', now() + interval '2 day', now());
select t.ok('權限：HR 可以開新的一期，created_by 自動帶入',
  (select created_by from public.massage_sessions where id = '58000000-0000-0000-0000-000000000001') = 'aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('鎖定：新增時不能直接標成「已抽籤」',
  (select drawn_at is null from public.massage_sessions where id = '58000000-0000-0000-0000-000000000001'));
reset role;

-- ===== 人數未滿：不抽籤，照報名先後排時段 =====
select t.close('51000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user(t.e(12));
select t.ok('報名：截止後不能報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'signup_closed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('抽籤：人數未滿 → 不抽籤、全部正取',
  (select (r->>'ok')::bool and (r->>'was_lottery')::bool = false and (r->>'selected')::int = 6
     from (select public.massage_run_draw('51000000-0000-0000-0000-000000000001') r) x));
select t.ok('抽籤：人數未滿 → 照報名先後排時段（第 1 位 = 第 1 個時段）',
  (select array_agg(user_id order by slot_no) from public.massage_signups
    where session_id = '51000000-0000-0000-0000-000000000001')
  = array[t.e(1), t.e(4), t.e(7), t.e(8), t.e(9), t.e(6)]);
select t.ok('抽籤：不能重抽', public.massage_run_draw('51000000-0000-0000-0000-000000000001')->>'code' = 'already_drawn');
select t.as_user(t.e(13));
select t.ok('報名：抽完籤就不能再報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'already_drawn');

-- 鎖定：管理者也不能偷偷把 drawn_at 清掉來重抽、不能刪、不能改時段
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin
  update public.massage_sessions set drawn_at = null where id = '51000000-0000-0000-0000-000000000001';
  perform t.ok('鎖定：管理者不能把抽籤狀態清掉來重抽', false);
exception when raise_exception then perform t.ok('鎖定：管理者不能把抽籤狀態清掉來重抽', true);
end $$;
do $$ begin
  delete from public.massage_sessions where id = '51000000-0000-0000-0000-000000000001';
  perform t.ok('鎖定：抽過籤的期數不能刪（避免刪掉重開再抽）', false);
exception when raise_exception then perform t.ok('鎖定：抽過籤的期數不能刪（避免刪掉重開再抽）', true);
end $$;
do $$ begin
  update public.massage_sessions set slot_count = 5 where id = '51000000-0000-0000-0000-000000000001';
  perform t.ok('鎖定：抽過籤之後時段設定不能改', false);
exception when raise_exception then perform t.ok('鎖定：抽過籤之後時段設定不能改', true);
end $$;
reset role;

-- ===== 送出假單之後：撞到哪些報名（7c）=====
insert into public.leave_requests (id, requester_id, leave_type_id, start_date, end_date, start_time, end_time, status) values
  ('22222222-0000-0000-0000-000000000001', t.e(1), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '14:00', '15:00', 'pending'),
  ('22222222-0000-0000-0000-000000000002', t.e(1), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '09:00', '10:00', 'pending');
set role authenticated;
select t.as_user(t.e(1));
select t.ok('請假後提醒：下午的假 → 找到那筆按摩',
  (select count(*) = 1 and bool_and(slot_no = 1 and drawn)
     from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));
select t.ok('請假後提醒：上午的假 → 沒撞到',
  (select count(*) = 0 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000002')));
select t.as_user(t.e(4));
select t.ok('請假後提醒：別人查不到我的', (select count(*) = 0 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('請假後提醒：HR 代登記時查得到', (select count(*) = 1 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));
reset role;

-- ===== 上一期（P，TD+10）：5 人都按到 =====
select t.mk('50000000-0000-0000-0000-000000000001', t.td() + 10);
insert into public.massage_signups (session_id, user_id, signed_up_at)
select '50000000-0000-0000-0000-000000000001', t.e(200 + n), now() + n * interval '1 second' from generate_series(1, 5) n;
select t.close('50000000-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('50000000-0000-0000-0000-000000000001');

-- 這一期（D2 = TD+20）的三種情況
select t.mk('52000000-0000-0000-0000-00000000000a', t.td() + 20);  -- 新 9 + 上期 5
select t.mk('52000000-0000-0000-0000-00000000000b', t.td() + 20);  -- 新 12 + 上期 5
select t.mk('52000000-0000-0000-0000-00000000000c', t.td() + 20);  -- 新 6 + 上期 5
insert into public.massage_signups (session_id, user_id)
select '52000000-0000-0000-0000-00000000000a'::uuid, t.e(100 + n) from generate_series(1, 9) n
union all select '52000000-0000-0000-0000-00000000000a', t.e(200 + n) from generate_series(1, 5) n
union all select '52000000-0000-0000-0000-00000000000b', t.e(100 + n) from generate_series(1, 12) n
union all select '52000000-0000-0000-0000-00000000000b', t.e(200 + n) from generate_series(1, 5) n
union all select '52000000-0000-0000-0000-00000000000c', t.e(100 + n) from generate_series(1, 6) n
union all select '52000000-0000-0000-0000-00000000000c', t.e(200 + n) from generate_series(1, 5) n;
select t.close('52000000-0000-0000-0000-00000000000a');
select t.close('52000000-0000-0000-0000-00000000000b');
select t.close('52000000-0000-0000-0000-00000000000c');

-- 上一期還沒標出席 → 擋住
select t.ok('抽籤：上一期還有人沒標出席 → 先擋住',
  (select r->>'code' = 'previous_unmarked' and (r->>'count')::int = 5
     from (select public.massage_run_draw('52000000-0000-0000-0000-00000000000a') r) x));

-- HR 補標出席
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select public.massage_set_attendance(id, 'attended')
  from public.massage_signups where session_id = '50000000-0000-0000-0000-000000000001';
select t.ok('出席：HR 可以標記', (select count(*) = 5 from public.massage_signups
  where session_id = '50000000-0000-0000-0000-000000000001' and attendance = 'attended'));
reset role;

select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000a');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000b');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000c');

-- 新 9 + 上期 5
select t.ok('分兩組（新9+上期5）：新報名的 9 位全部正取',
  (select count(*) = 9 and bool_and(priority_group = 1) from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000a' and result = 'selected'));
select t.ok('分兩組（新9+上期5）：上期的 5 位全部候補，名次 10-14',
  (select count(*) = 5 and bool_and(priority_group = 2) and min(draw_rank) = 10 and max(draw_rank) = 14
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000a' and result = 'waitlist'));

-- 新 12 + 上期 5
select t.ok('分兩組（新12+上期5）：正取 9 位都是新報名的',
  (select count(*) = 9 and bool_and(priority_group = 1) from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000b' and result = 'selected'));
select t.ok('分兩組（新12+上期5）：候補 10-12 是新報名沒中的，13-17 是上期的',
  (select bool_and(case when draw_rank between 10 and 12 then priority_group = 1 else priority_group = 2 end)
          and count(*) = 8
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000b' and result = 'waitlist'));
select t.ok('時段：超過名額時照抽籤名次排（名次 = 時段，1..9 不重複）',
  (select bool_and(slot_no = draw_rank) and count(distinct slot_no) = 9 from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000b' and result = 'selected'));

-- 新 6 + 上期 5
select t.ok('分兩組（新6+上期5）：新報名 6 位排 1-6，上期 3 位補 7-9',
  (select bool_and(case when draw_rank <= 6 then priority_group = 1 else priority_group = 2 end)
          and count(*) = 9
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000c' and result = 'selected'));
select t.ok('分兩組（新6+上期5）：上期剩下 2 位候補',
  (select count(*) = 2 and bool_and(priority_group = 2) from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000c' and result = 'waitlist'));

-- ===== 公平性：同一組裡每個人的中籤機率要一樣 =====
create table t.fair (user_id uuid);
do $$
declare v_sid uuid;
begin
  perform t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  for i in 1..400 loop
    v_sid := gen_random_uuid();
    insert into public.massage_sessions (id, title, session_date, signup_deadline, cancel_deadline)
    values (v_sid, 'fair', t.td() + 20, now() - interval '1 minute', now() + interval '30 day');
    insert into public.massage_signups (session_id, user_id, signed_up_at)
    select v_sid, t.e(300 + n), now() + n * interval '1 second' from generate_series(1, 12) n;
    perform public.massage_run_draw(v_sid);
    insert into t.fair select user_id from public.massage_signups where session_id = v_sid and result = 'selected';
  end loop;
end $$;
-- 12 取 9，期望每人 300 次，標準差約 8.7；允許 ±4 個標準差
select t.ok('公平性：400 次抽籤，12 人每人中籤次數都在 265-335 之間',
  (select min(c) >= 265 and max(c) <= 335 and count(*) = 12 from (select count(*) c from t.fair group by user_id) x),
  (select string_agg(c::text, ',' order by c) from (select count(*) c from t.fair group by user_id) x));
select t.ok('公平性：先報名的人沒有比較容易中（第 1 位 vs 第 12 位）',
  abs((select count(*) from t.fair where user_id = t.e(301)) - (select count(*) from t.fair where user_id = t.e(312))) <= 60);

-- ===== 取消與遞補（用「新12+上期5」那一期）=====
-- 名次 1 取消（期限前）→ 邀請名次 10
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 1));
select t.ok('遞補：期限前取消 → 不算遲、邀請第 1 位候補（名次 10）',
  (select (r->>'late')::bool = false and (r->>'offered_signup_id')::uuid = t.byrank('52000000-0000-0000-0000-00000000000b', 10)
     from (select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 1)) r) x));
select t.ok('遞補：提早取消的邀請不設時限（等候補第一位回覆）',
  (select offer_status = 'pending' and offer_slot_no = 1 and offer_expires_at is null
     from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 10)));
reset role;
select t.ok('遞補：不設時限的邀請，排程不會把它收走',
  public.massage_expire_offers() = 0
  and (select offer_status = 'pending' from public.massage_signups
        where id = t.byrank('52000000-0000-0000-0000-00000000000b', 10)));
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 10));
select t.ok('遞補：候補按「我要」→ 拿到時段 1',
  (public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 10))->>'slot_no')::int = 1);

-- 名次 2 取消 → 邀請 11；11 沒回 → 過期 → 改邀 12
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 2));
select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 2));
reset role;
update public.massage_signups set offer_expires_at = now() - interval '1 minute'
 where id = t.byrank('52000000-0000-0000-0000-00000000000b', 11);
select t.ok('遞補（有時限的邀請）：時間到沒回 → 排程把它標成過期', public.massage_expire_offers() = 1);
select t.ok('遞補：過期後改邀下一位（名次 12）',
  (select offer_status = 'pending' and offer_slot_no = 2 from public.massage_signups
    where id = t.byrank('52000000-0000-0000-0000-00000000000b', 12)));
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 11));
select t.ok('遞補：過期之後再按「我要」也沒用',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 11))->>'code' = 'no_pending_offer');

-- 名次 3 取消 → 時段 3：名次 11 剛才錯過的是時段 2，這次會再問他
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 3));
select t.ok('遞補：錯過一次的人，下一個空出的時段還會再問他',
  (public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 3))->>'offered_signup_id')::uuid
    = t.byrank('52000000-0000-0000-0000-00000000000b', 11));
reset role;

-- 取消期限過了才取消 → 記未到，名額照樣遞補
update public.massage_sessions set cancel_deadline = now() - interval '1 minute'
 where id = '52000000-0000-0000-0000-00000000000b';
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 4));
select t.ok('取消期限後才取消：記為遲取消、名額照樣遞補給名次 13',
  (select (r->>'late')::bool and (r->>'offered_signup_id')::uuid = t.byrank('52000000-0000-0000-0000-00000000000b', 13)
     from (select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 4)) r) x));
select t.ok('取消期限後才取消：出席記為「未到」',
  (select attendance = 'no_show' and released_late from public.massage_signups
    where id = t.byrank('52000000-0000-0000-0000-00000000000b', 4)));

-- 候補手上有邀請時自己取消 → 直接改邀下一位
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 13));
select t.ok('遞補：被邀請的人自己取消 → 改邀名次 14',
  (public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 13))->>'offered_signup_id')::uuid
    = t.byrank('52000000-0000-0000-0000-00000000000b', 14));
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 15));
select t.ok('遞補：不能替別人按「我要」',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 14))->>'code' = 'not_found');

-- ===== 管理者改時段 =====
select t.ok('改時段：一般同仁不能改',
  public.massage_move_slot(t.byrank('52000000-0000-0000-0000-00000000000b', 5), 6)->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_move_slot(t.byrank('52000000-0000-0000-0000-00000000000b', 5), 6);
select t.ok('改時段：兩人對調（5 ↔ 6）',
  (select slot_no from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 5)) = 6
  and (select slot_no from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 6)) = 5);
create temp table mv as select public.massage_move_slot(t.byrank('52000000-0000-0000-0000-00000000000b', 7), 3) r;
select t.ok('改時段：移到空的時段 3',
  (select (r->>'swapped_with') is null from mv)
  and (select slot_no from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 7)) = 3);
select t.ok('改時段：不存在的時段', public.massage_move_slot(t.byrank('52000000-0000-0000-0000-00000000000b', 8), 99)->>'code' = 'invalid_slot');
-- 名次 11 手上還有時段 3 的邀請，但時段 3 已經被管理者排了人
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 11));
select t.ok('遞補：時段已經被管理者排了人 → 按「我要」會說時段已被占用',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 11))->>'code' = 'slot_taken');
reset role;

-- ===== 出席 =====
-- 未來的時段：本人還不能按「已完成」
set role authenticated;
select t.as_user(t.e(1));
select t.ok('出席：時段還沒開始不能按「已完成」',
  public.massage_mark_done(t.sid('51000000-0000-0000-0000-000000000001', t.e(1)))->>'code' = 'not_started');
reset role;

-- 昨天那一期（時段都已經開始了）
select t.mk('59000000-0000-0000-0000-000000000001', t.td() - 1);
insert into public.massage_signups (session_id, user_id, signed_up_at)
select '59000000-0000-0000-0000-000000000001', t.e(380 + n), now() + n * interval '1 second' from generate_series(1, 3) n;
select t.close('59000000-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('59000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user(t.e(381));
select t.ok('出席：本人可以按「已完成」', (public.massage_mark_done(t.sid('59000000-0000-0000-0000-000000000001', t.e(381)))->>'ok')::bool);
select t.ok('出席：不能重複按', public.massage_mark_done(t.sid('59000000-0000-0000-0000-000000000001', t.e(381)))->>'code' = 'already_marked');
select t.ok('出席：不能幫別人按', public.massage_mark_done(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)))->>'code' = 'not_found');
select t.ok('出席：一般同仁不能用管理者的標記功能',
  public.massage_set_attendance(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)), 'attended')->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('出席：HR 可以標未到', (public.massage_set_attendance(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)), 'no_show')->>'ok')::bool);
create temp table clr as select public.massage_set_attendance(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)), null) r;
select t.ok('出席：HR 可以清除標記', (select (r->>'ok')::bool from clr)
  and (select attendance is null from public.massage_signups where id = t.sid('59000000-0000-0000-0000-000000000001', t.e(382))));
reset role;
insert into public.massage_signups (session_id, user_id, result, draw_rank, offer_slot_no, offered_at, offer_status)
values ('59000000-0000-0000-0000-000000000001', t.e(390), 'waitlist', 4, 1, now() - interval '1 day', 'pending');
set role authenticated;
select t.as_user(t.e(390));
select t.ok('遞補：時段已經結束才按「我要」→ 拒絕',
  public.massage_accept_offer(t.sid('59000000-0000-0000-0000-000000000001', t.e(390)))->>'code' = 'slot_over');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('出席：不接受亂填的狀態', public.massage_set_attendance(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)), 'maybe')->>'code' = 'invalid_status');
reset role;

-- ===== 結果 =====
select case when pass then '  ✓ ' else '  ✗ ' end || name || coalesce('  [' || detail || ']', '') as result
  from t.results order by n;
select count(*) filter (where pass) || ' / ' || count(*) || ' 通過' as summary from t.results;
