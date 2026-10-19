\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- ===== 測試資料與小工具 =====
create function t.e(n int) returns uuid language sql immutable as $$
  select ('eeeeeeee-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function t.td() returns date language sql stable as $$
  select (now() at time zone 'Asia/Taipei')::date
$$;
grant execute on function t.e(int), t.td() to authenticated, anon, service_role;

insert into public.users (id, full_name, is_admin) values ('aaaaaaaa-0000-0000-0000-000000000001', '管理員', true);
insert into public.users (id, full_name, is_finance) values ('aaaaaaaa-0000-0000-0000-000000000002', 'HR', true);
insert into public.users (id, full_name, is_active) values ('aaaaaaaa-0000-0000-0000-000000000099', '離職的人', false);
insert into public.users (id, full_name) select t.e(n), '員工' || n from generate_series(1, 400) n;

insert into public.leave_types (id, name, name_en, is_wfh) values
  ('11111111-0000-0000-0000-000000000001', '事假', 'Personal', false),
  ('11111111-0000-0000-0000-000000000002', 'WFH', 'WFH', true);

-- 以 superuser 直接建一期（預設 13:00 開始、9 個時段、報名一小時後截止）
create function t.mk(p_id uuid, p_date date) returns void language sql as $$
  insert into public.massage_sessions (id, title, session_date, signup_deadline, cancel_deadline)
  values (p_id, '測試 ' || p_date, p_date,
          now() + interval '1 hour',
          ((p_date + time '12:00') at time zone 'Asia/Taipei'))
$$;
create function t.close(p_id uuid) returns void language sql as $$
  update public.massage_sessions set signup_deadline = now() - interval '1 minute' where id = p_id
$$;
create function t.leave(p_user uuid, p_from date, p_to date, p_st time, p_et time, p_status text default 'approved')
returns void language sql as $$
  insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, start_time, end_time, status)
  values (p_user, '11111111-0000-0000-0000-000000000001', p_from, p_to, p_st, p_et, p_status)
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


-- =========================================================================
-- 1. 報名與請假（S1 = TD+40，預設 13:00 開始，時段 1 = 13:00、時段 9 = 15:40）
-- =========================================================================
select t.mk('51000000-0000-0000-0000-000000000001', t.td() + 40);

select t.leave(t.e(2),  t.td()+39, t.td()+41, '09:00', '18:00');             -- 跨天
select t.leave(t.e(3),  t.td()+40, t.td()+40, '14:00', '18:00', 'pending');  -- 審核中，可按 13:00–13:40
select t.leave(t.e(4),  t.td()+40, t.td()+40, '09:00', '12:00');             -- 只有上午
insert into public.leave_requests (requester_id, leave_type_id, start_date, end_date, start_time, end_time, status)
values (t.e(5), '11111111-0000-0000-0000-000000000002', t.td()+40, t.td()+40, '09:00', '18:00', 'approved'); -- WFH
select t.leave(t.e(6),  t.td()+40, t.td()+40, '09:00', '18:00', 'rejected');
select t.leave(t.e(7),  t.td()+40, t.td()+40, '09:00', '18:00', 'withdrawn');
select t.leave(t.e(8),  t.td()+40, t.td()+40, '16:00', '18:00');             -- 16:00 才開始
select t.leave(t.e(9),  t.td()+40, t.td()+40, '12:00', '13:00');             -- 13:00 就結束
select t.leave(t.e(10), t.td()+40, t.td()+40, '15:30', '18:00');             -- 可按時段 1–7
select t.leave(t.e(11), t.td()+40, t.td()+40, '12:30', '13:30');             -- 可按時段 3–9
select t.leave(t.e(12), t.td()+40, t.td()+40, '13:00', '15:50');             -- 沒有任何時段可按
select t.leave(t.e(13), t.td()+40, t.td()+40, '13:00', '14:30');             -- 兩張假單加起來
select t.leave(t.e(13), t.td()+40, t.td()+40, '14:30', '16:00');             --   蓋滿整段
select t.leave(t.e(14), t.td()+40, t.td()+40, '13:00', '15:40');             -- 只剩時段 9 可按

set role authenticated;
-- 報名順序刻意讓 e11（只能按 13:40 之後）排第一個
select t.as_user(t.e(11));
select t.ok('部分請假：12:30–13:30 → 可以報，並回報請假資訊',
  (select (r->>'ok')::bool and r->'partial_leave'->>'start_time' = '12:30'
     from (select public.massage_sign_up('51000000-0000-0000-0000-000000000001') r) x));
select t.as_user(t.e(1));
select t.ok('報名：一般同仁可以報名，沒有請假資訊',
  (select (r->>'ok')::bool and r->'partial_leave' = 'null'::jsonb
     from (select public.massage_sign_up('51000000-0000-0000-0000-000000000001') r) x));
select t.ok('報名：同一人不能報兩次', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'already_signed_up');
select t.ok('報名前狀態：沒有請假 → none', public.massage_my_leave_status('51000000-0000-0000-0000-000000000001')->>'state' = 'none');
select t.as_user(t.e(3));
select t.ok('報名前狀態：審核中 14:00–18:00 → partial', public.massage_my_leave_status('51000000-0000-0000-0000-000000000001')->>'state' = 'partial');
select t.ok('報名前狀態：一併回傳可以按的時段（13:00–13:40 → 時段 1–3）',
  public.massage_my_leave_status('51000000-0000-0000-0000-000000000001')->'ok_slots' = '[1, 2, 3]'::jsonb);
select t.ok('部分請假：審核中 14:00–18:00 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(4));
select t.ok('請假：只請上午 09:00–12:00 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(6));
select t.ok('請假：已駁回的假單不算 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(7));
select t.ok('請假：已收回的假單不算 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(8));
select t.ok('請假：16:00 才開始請（邊界）→ 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(9));
select t.ok('請假：13:00 就結束（邊界）→ 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(10));
select t.ok('部分請假：15:30–18:00 → 可以報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);

select t.as_user(t.e(2));
select t.ok('請假：跨天假單（整天）→ 擋', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.ok('報名前狀態：整天請假 → blocked', public.massage_my_leave_status('51000000-0000-0000-0000-000000000001')->>'state' = 'blocked');
select t.as_user(t.e(5));
select t.ok('請假：WFH 整天 → 擋，並回報假別',
  (select r->>'code' = 'leave_conflict' and r->'leave'->>'leave_type' = 'WFH'
     from (select public.massage_sign_up('51000000-0000-0000-0000-000000000001') r) x));
select t.as_user(t.e(12));
select t.ok('請假：13:00–15:50（沒蓋到 16:00，但每個時段都撞到）→ 擋',
  public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.as_user(t.e(13));
select t.ok('請假：兩張假單加起來蓋滿整段 → 擋',
  public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'leave_conflict');
select t.as_user(t.e(14));
select t.ok('部分請假：13:00–15:40（剛好只剩最後一段）→ 可以報',
  public.massage_my_leave_status('51000000-0000-0000-0000-000000000001')->>'state' = 'partial');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000099');
select t.ok('報名：停用的帳號不能報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'user_inactive');

-- 抽籤前取消、再報一次 → 排到最後
select t.as_user(t.e(6));
select t.ok('取消：抽籤前取消報名',
  public.massage_release(t.sid('51000000-0000-0000-0000-000000000001', t.e(6)))->>'phase' = 'before_draw');
select t.ok('報名：取消後可以再報', (public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'ok')::bool);


-- =========================================================================
-- 2. 寫入權限
-- =========================================================================
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
select t.ok('權限：全公司都看得到報名名單', (select count(*) from public.massage_signups) = 9);

select t.as_user(t.e(1));
select t.ok('抽籤：一般同仁不能抽', public.massage_run_draw('51000000-0000-0000-0000-000000000001')->>'code' = 'not_allowed');
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


-- =========================================================================
-- 3. 人數未滿：不抽籤，照報名先後；部分請假的人自動避開
-- =========================================================================
select t.close('51000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user(t.e(15));
select t.ok('報名：截止後不能報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'signup_closed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table d1 as select public.massage_run_draw('51000000-0000-0000-0000-000000000001') r;
select t.ok('抽籤：人數未滿 → 不抽籤、全部正取、沒有人排不開',
  (select (r->>'ok')::bool and (r->>'was_lottery')::bool = false
          and (r->>'selected')::int = 9 and (r->>'slot_conflicts')::int = 0 from d1));
-- 報名順序：e11, e1, e3, e4, e7, e8, e9, e10, e6
--   e11 只能 13:40 之後 → 排時段 3（最接近第 1）
--   e3  只能 13:40 以前 → 時段 3 被拿走 → 時段 2（最接近第 3）
--   e10 只能 15:00 以前 → 時段 7（最接近第 8）
--   其他人依序補剩下的空檔
select t.ok('排時段：部分請假的人自動避開，其他人依序補上',
  (select array_agg(user_id order by slot_no) from public.massage_signups
    where session_id = '51000000-0000-0000-0000-000000000001')
  = array[t.e(1), t.e(3), t.e(11), t.e(4), t.e(7), t.e(8), t.e(10), t.e(9), t.e(6)],
  (select string_agg(slot_no || ':' || substr(user_id::text, 33), ' ' order by slot_no)
     from public.massage_signups where session_id = '51000000-0000-0000-0000-000000000001'));
select t.ok('抽籤：不能重抽', public.massage_run_draw('51000000-0000-0000-0000-000000000001')->>'code' = 'already_drawn');
select t.as_user(t.e(16));
select t.ok('報名：抽完籤就不能再報', public.massage_sign_up('51000000-0000-0000-0000-000000000001')->>'code' = 'already_drawn');

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


-- =========================================================================
-- 4. 送出假單之後：撞到哪些報名（只看自己的時段）
-- =========================================================================
-- e1 排在時段 1（13:00–13:15）
insert into public.leave_requests (id, requester_id, leave_type_id, start_date, end_date, start_time, end_time, status) values
  ('22222222-0000-0000-0000-000000000001', t.e(1), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '13:00', '13:30', 'pending'),
  ('22222222-0000-0000-0000-000000000002', t.e(1), '11111111-0000-0000-0000-000000000001', t.td()+40, t.td()+40, '14:00', '15:00', 'pending');
set role authenticated;
select t.as_user(t.e(1));
select t.ok('請假後提醒：撞到自己的時段 → 找到那筆按摩',
  (select count(*) = 1 and bool_and(slot_no = 1 and drawn)
     from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));
select t.ok('請假後提醒：只撞到別人的時段 → 不提醒',
  (select count(*) = 0 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000002')));
select t.as_user(t.e(4));
select t.ok('請假後提醒：別人查不到我的', (select count(*) = 0 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('請假後提醒：HR 代登記時查得到', (select count(*) = 1 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000001')));

-- 還沒抽籤（沒有時段）：部分請假不提醒、整段都不能按才提醒
select t.as_user(t.e(40));
select public.massage_sign_up('58000000-0000-0000-0000-000000000001');
reset role;
insert into public.leave_requests (id, requester_id, leave_type_id, start_date, end_date, start_time, end_time, status) values
  ('22222222-0000-0000-0000-000000000003', t.e(40), '11111111-0000-0000-0000-000000000001', t.td()+70, t.td()+70, '15:00', '16:00', 'pending');
set role authenticated;
select t.as_user(t.e(40));
select t.ok('請假後提醒（抽籤前）：只請部分時段 → 不提醒，排時段時會避開',
  (select count(*) = 0 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000003')));
reset role;
insert into public.leave_requests (id, requester_id, leave_type_id, start_date, end_date, start_time, end_time, status) values
  ('22222222-0000-0000-0000-000000000004', t.e(40), '11111111-0000-0000-0000-000000000001', t.td()+69, t.td()+71, '09:00', '18:00', 'pending');
set role authenticated;
select t.as_user(t.e(40));
select t.ok('請假後提醒（抽籤前）：整段都不能按 → 提醒',
  (select count(*) = 1 from public.massage_signups_hit_by_leave('22222222-0000-0000-0000-000000000004')));
reset role;


-- =========================================================================
-- 5. 真的排不開：照樣給時段，但標示衝突
-- =========================================================================
select t.mk('5b000000-0000-0000-0000-000000000001', t.td() + 80);
select t.leave(t.e(50), t.td()+80, t.td()+80, '13:00', '15:40');   -- 只能時段 9
select t.leave(t.e(51), t.td()+80, t.td()+80, '13:00', '15:40');   -- 只能時段 9
insert into public.massage_signups (session_id, user_id, signed_up_at) values
  ('5b000000-0000-0000-0000-000000000001', t.e(50), now()),
  ('5b000000-0000-0000-0000-000000000001', t.e(51), now() + interval '1 second'),
  ('5b000000-0000-0000-0000-000000000001', t.e(52), now() + interval '2 second');
select t.close('5b000000-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table d5 as select public.massage_run_draw('5b000000-0000-0000-0000-000000000001') r;
select t.ok('排不開：回報 1 人衝突', (select (r->>'slot_conflicts')::int = 1 from d5));
select t.ok('排不開：先報名的拿到唯一可以的時段 9',
  (select slot_no = 9 and not slot_conflict from public.massage_signups where id = t.sid('5b000000-0000-0000-0000-000000000001', t.e(50))));
select t.ok('排不開：後報名的照樣有時段，但標示衝突',
  (select slot_no is not null and slot_conflict from public.massage_signups where id = t.sid('5b000000-0000-0000-0000-000000000001', t.e(51))));


-- =========================================================================
-- 6. 全部一起抽 + 上期按過的人會被問要不要讓
-- =========================================================================
-- 上一期 P（TD+10）：e201–e209，9 人都按到
select t.mk('50000000-0000-0000-0000-000000000001', t.td() + 10);
insert into public.massage_signups (session_id, user_id, signed_up_at)
select '50000000-0000-0000-0000-000000000001', t.e(200 + n), now() + n * interval '1 second' from generate_series(1, 9) n;
select t.close('50000000-0000-0000-0000-000000000001');
select public.massage_run_draw('50000000-0000-0000-0000-000000000001');

-- 這一期（TD+20）的幾種情況
select t.mk('52000000-0000-0000-0000-00000000000a', t.td() + 20);  -- 新 9 + 上期 5（上期還沒標出席時抽）
select t.mk('52000000-0000-0000-0000-00000000000b', t.td() + 20);  -- 新 12 + 上期 5
select t.mk('52000000-0000-0000-0000-00000000000c', t.td() + 20);  -- 新 4 + 上期 5（人數未滿）
select t.mk('52000000-0000-0000-0000-00000000000d', t.td() + 20);  -- 上期 9 + 新 1
insert into public.massage_signups (session_id, user_id)
select '52000000-0000-0000-0000-00000000000a'::uuid, t.e(100 + n) from generate_series(1, 9) n
union all select '52000000-0000-0000-0000-00000000000a', t.e(200 + n) from generate_series(1, 5) n
union all select '52000000-0000-0000-0000-00000000000b', t.e(100 + n) from generate_series(1, 12) n
union all select '52000000-0000-0000-0000-00000000000b', t.e(200 + n) from generate_series(1, 5) n
union all select '52000000-0000-0000-0000-00000000000c', t.e(100 + n) from generate_series(1, 4) n
union all select '52000000-0000-0000-0000-00000000000c', t.e(200 + n) from generate_series(1, 5) n
union all select '52000000-0000-0000-0000-00000000000d', t.e(200 + n) from generate_series(1, 9) n
union all select '52000000-0000-0000-0000-00000000000d', t.e(110);
select t.close('52000000-0000-0000-0000-00000000000a');
select t.close('52000000-0000-0000-0000-00000000000b');
select t.close('52000000-0000-0000-0000-00000000000c');
select t.close('52000000-0000-0000-0000-00000000000d');

create temp table da as select public.massage_run_draw('52000000-0000-0000-0000-00000000000a') r;
select t.ok('上期還沒標出席：一樣可以抽（不擋公開抽籤）', (select (r->>'ok')::bool from da));
select t.ok('上期還沒標出席：沒標的人不會被當成上期按過、不會被問要不要讓',
  (select bool_and(not went_last_time) and bool_and(not yield_asked) from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000a'));

set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select public.massage_set_attendance(id, 'attended')
  from public.massage_signups where session_id = '50000000-0000-0000-0000-000000000001';
select t.ok('出席：HR 可以標記', (select count(*) = 9 from public.massage_signups
  where session_id = '50000000-0000-0000-0000-000000000001' and attendance = 'attended'));
reset role;

select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000b');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000c');
select public.massage_run_draw('52000000-0000-0000-0000-00000000000d');

select t.ok('一起抽（新12+上期5）：正取 9、候補 8',
  (select count(*) filter (where result = 'selected') = 9 and count(*) filter (where result = 'waitlist') = 8
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000b'));
select t.ok('一起抽：上期實際按到的 5 人被標成上期按過，其他人沒有',
  (select count(*) filter (where went_last_time) = 5
          and bool_and(went_last_time = (user_id in (t.e(201), t.e(202), t.e(203), t.e(204), t.e(205))))
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000b'));
select t.ok('一起抽：只有「上期按過＋這期抽中」的人會被問要不要讓',
  (select bool_and(yield_asked = (result = 'selected' and went_last_time))
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000b'));
select t.ok('時段：超過名額時照抽籤名次排（沒有請假時 名次 = 時段）',
  (select bool_and(slot_no = draw_rank) and count(distinct slot_no) = 9 from public.massage_signups
    where session_id = '52000000-0000-0000-0000-00000000000b' and result = 'selected'));
select t.ok('人數未滿（新4+上期5）：全部正取，沒有人在候補所以不問要不要讓',
  (select count(*) = 9 and bool_and(result = 'selected') and bool_and(not yield_asked)
     from public.massage_signups where session_id = '52000000-0000-0000-0000-00000000000c'));


-- =========================================================================
-- 7. 公平性：大家一起抽，每個人（不管上期有沒有按）中籤機率一樣
-- =========================================================================
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
    select v_sid, t.e(300 + n), now() + n * interval '1 second' from generate_series(1, 12) n
    union all
    select v_sid, t.e(200 + n), now() + (12 + n) * interval '1 second' from generate_series(1, 5) n;
    perform public.massage_run_draw(v_sid);
    insert into t.fair select user_id from public.massage_signups where session_id = v_sid and result = 'selected';
  end loop;
end $$;
-- 17 取 9：期望每人 211.8 次，標準差約 10；允許 ±4 個標準差
select t.ok('公平性：400 次抽籤，17 人每人中籤次數都在 172–252 之間',
  (select min(c) >= 172 and max(c) <= 252 and count(*) = 17 from (select count(*) c from t.fair group by user_id) x),
  (select string_agg(c::text, ',' order by c) from (select count(*) c from t.fair group by user_id) x));
select t.ok('公平性：上期按過的人跟沒按過的人，平均中籤次數一樣（差距 < 25）',
  abs((select count(*)::numeric / 5 from t.fair where user_id in (t.e(201), t.e(202), t.e(203), t.e(204), t.e(205)))
    - (select count(*)::numeric / 12 from t.fair where user_id not in (t.e(201), t.e(202), t.e(203), t.e(204), t.e(205)))) < 25,
  (select round(count(*)::numeric / 5, 1)::text from t.fair where user_id in (t.e(201), t.e(202), t.e(203), t.e(204), t.e(205)))
  || ' vs ' ||
  (select round(count(*)::numeric / 12, 1)::text from t.fair where user_id not in (t.e(201), t.e(202), t.e(203), t.e(204), t.e(205))));
select t.ok('公平性：先報名的人沒有比較容易中（第 1 位 vs 第 12 位）',
  abs((select count(*) from t.fair where user_id = t.e(301)) - (select count(*) from t.fair where user_id = t.e(312))) <= 60);


-- =========================================================================
-- 8. 讓給候補（上期 9 + 新 1 的那一期：至少 8 位上期按過的人抽中）
-- =========================================================================
create temp table yq as
  select id, user_id, draw_rank, row_number() over (order by draw_rank) k
    from public.massage_signups
   where session_id = '52000000-0000-0000-0000-00000000000d' and yield_asked;
grant select on yq to authenticated;
select t.ok('讓出：上期按過又抽中的人都被問了（至少 8 位）', (select count(*) >= 8 from yq));

set role authenticated;
select t.as_user((select user_id from yq where k = 1));
create temp table y1 as select public.massage_answer_yield((select id from yq where k = 1), true) r;
select t.ok('讓出：本人選擇讓 → 名額給候補第一位，不設時限',
  (select (r->>'ok')::bool and r->>'answer' = 'yielded'
          and (r->>'offered_signup_id')::uuid = t.byrank('52000000-0000-0000-0000-00000000000d', 10) from y1)
  and (select offer_status = 'pending' and offer_expires_at is null from public.massage_signups
        where id = t.byrank('52000000-0000-0000-0000-00000000000d', 10)));

select t.as_user((select user_id from yq where k = 2));
select t.ok('讓出：本人選擇不讓 → 保留名額', public.massage_answer_yield((select id from yq where k = 2), false)->>'answer' = 'kept');
select t.ok('讓出：回答過就不能再改', public.massage_answer_yield((select id from yq where k = 2), true)->>'code' = 'already_answered');

select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000d', 10));
select t.ok('讓出：沒被問的人不能用這個功能', public.massage_answer_yield(t.byrank('52000000-0000-0000-0000-00000000000d', 10), true)->>'code' = 'not_asked');

select t.as_user((select user_id from yq where k = 4));
select t.ok('讓出：不能替別人回答', public.massage_answer_yield((select id from yq where k = 3), true)->>'code' = 'not_found');
reset role;

update public.massage_sessions set cancel_deadline = now() - interval '1 minute' where id = '52000000-0000-0000-0000-00000000000d';
set role authenticated;
select t.as_user((select user_id from yq where k = 3));
create temp table y3 as select public.massage_answer_yield((select id from yq where k = 3), true) r;
select t.ok('讓出：過了取消期限才讓，也不會被記為未到（讓是好意）',
  (select (r->>'late')::bool = false from y3)
  and (select attendance is null and not released_late from public.massage_signups where id = (select id from yq where k = 3)));
reset role;


-- =========================================================================
-- 9. 取消與遞補（新12+上期5 那一期；名次 = 時段）
-- =========================================================================
-- 候補第一位（名次 10）13:00–13:30 有請假：撞到時段 1、2，不撞時段 3
select t.leave(t.uidrank('52000000-0000-0000-0000-00000000000b', 10), t.td()+20, t.td()+20, '13:00', '13:30');

set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 1));
select t.ok('遞補：候補第一位在空出的時段有請假 → 跳過他，問名次 11',
  (select (r->>'late')::bool = false and (r->>'offered_signup_id')::uuid = t.byrank('52000000-0000-0000-0000-00000000000b', 11)
     from (select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 1)) r) x));
select t.ok('遞補：本人提早取消的邀請不設時限',
  (select offer_status = 'pending' and offer_slot_no = 1 and offer_expires_at is null
     from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 11)));
reset role;
select t.ok('遞補：不設時限的邀請，排程不會把它收走',
  public.massage_expire_offers() = 0
  and (select offer_status = 'pending' from public.massage_signups
        where id = t.byrank('52000000-0000-0000-0000-00000000000b', 11)));
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 11));
select t.ok('遞補：候補按「我要」→ 拿到時段 1',
  (public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 11))->>'slot_no')::int = 1);

select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 2));
select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 2));
select t.ok('遞補：時段 2 也撞到名次 10 的請假 → 問名次 12',
  (select offer_status = 'pending' and offer_slot_no = 2 from public.massage_signups
    where id = t.byrank('52000000-0000-0000-0000-00000000000b', 12)));
reset role;

-- 有時限的邀請（現場用）到期 → 排程改邀下一位
update public.massage_signups set offer_expires_at = now() - interval '1 minute'
 where id = t.byrank('52000000-0000-0000-0000-00000000000b', 12);
select t.ok('遞補（有時限的邀請）：時間到沒回 → 排程標成過期', public.massage_expire_offers() = 1);
select t.ok('遞補：過期後改邀名次 13',
  (select offer_status = 'pending' and offer_slot_no = 2 from public.massage_signups
    where id = t.byrank('52000000-0000-0000-0000-00000000000b', 13)));
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 12));
select t.ok('遞補：過期之後再按「我要」也沒用',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 12))->>'code' = 'no_pending_offer');

select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 3));
select t.ok('遞補：時段 3 沒撞到名次 10 的請假 → 這次問他',
  (public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 3))->>'offered_signup_id')::uuid
    = t.byrank('52000000-0000-0000-0000-00000000000b', 10));
reset role;

update public.massage_sessions set cancel_deadline = now() - interval '1 minute'
 where id = '52000000-0000-0000-0000-00000000000b';
set role authenticated;
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 4));
select t.ok('取消期限後才取消：記為遲取消；錯過時段 2 的名次 12 這次會再被問',
  (select (r->>'late')::bool and (r->>'offered_signup_id')::uuid = t.byrank('52000000-0000-0000-0000-00000000000b', 12)
     from (select public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 4)) r) x));
select t.ok('取消期限後才取消：出席記為「未到」',
  (select attendance = 'no_show' and released_late from public.massage_signups
    where id = t.byrank('52000000-0000-0000-0000-00000000000b', 4)));

select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 12));
select t.ok('遞補：被邀請的人自己取消 → 改邀名次 14',
  (public.massage_release(t.byrank('52000000-0000-0000-0000-00000000000b', 12))->>'offered_signup_id')::uuid
    = t.byrank('52000000-0000-0000-0000-00000000000b', 14));
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 15));
select t.ok('遞補：不能替別人按「我要」',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 14))->>'code' = 'not_found');

-- 管理者改時段
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
select t.as_user(t.uidrank('52000000-0000-0000-0000-00000000000b', 10));
select t.ok('遞補：時段已經被管理者排了人 → 按「我要」會說時段已被占用',
  public.massage_accept_offer(t.byrank('52000000-0000-0000-0000-00000000000b', 10))->>'code' = 'slot_taken');
reset role;


-- =========================================================================
-- 10. 現場按「沒到」（時段 1 已經開始 3 分鐘、時段 2 還沒開始）
-- =========================================================================
insert into public.massage_sessions (id, title, session_date, start_time, slot_count, signup_deadline, cancel_deadline)
select '5c000000-0000-0000-0000-000000000001', '現場', ts::date, date_trunc('minute', ts)::time, 2,
       now() + interval '1 hour', now() - interval '1 hour'
  from (select now() at time zone 'Asia/Taipei' - interval '3 minutes' as ts) x;
insert into public.massage_signups (session_id, user_id, signed_up_at)
select '5c000000-0000-0000-0000-000000000001', t.e(390 + n), now() + n * interval '1 second' from generate_series(1, 3) n;
select t.close('5c000000-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('5c000000-0000-0000-0000-000000000001');
create function t.slot_holder(p_session uuid, p_slot int) returns uuid language sql stable as $$
  select id from public.massage_signups where session_id = p_session and slot_no = p_slot and released_at is null
$$;
grant execute on function t.slot_holder(uuid, int) to authenticated;
create temp table h as
  select t.slot_holder('5c000000-0000-0000-0000-000000000001', 1) h1,
         t.slot_holder('5c000000-0000-0000-0000-000000000001', 2) h2,
         t.byrank('5c000000-0000-0000-0000-000000000001', 3) w;
grant select on h to authenticated;

set role authenticated;
select t.as_user(t.e(1));
select t.ok('沒到：一般同仁不能按', public.massage_mark_no_show((select h1 from h))->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('沒到：時段還沒開始不能按', public.massage_mark_no_show((select h2 from h))->>'code' = 'not_started');
create temp table ns as select public.massage_mark_no_show((select h1 from h)) r;
select t.ok('沒到：管理者按下 → 通知候補第一位',
  (select (r->>'ok')::bool and (r->>'offered_signup_id')::uuid = (select w from h) from ns));
select t.ok('沒到：本人記為未到、時段空出來',
  (select attendance = 'no_show' and released_at is not null from public.massage_signups where id = (select h1 from h)));
select t.ok('沒到：現場遞補的時限目前未設定（不設時限）',
  (select offer_expires_at is null from public.massage_signups where id = (select w from h)));
select t.as_user((select user_id from public.massage_signups where id = (select w from h)));
select t.ok('沒到：候補按「我要」→ 拿到時段 1',
  (public.massage_accept_offer((select w from h))->>'slot_no')::int = 1);
reset role;


-- =========================================================================
-- 11. 出席
-- =========================================================================
set role authenticated;
select t.as_user(t.e(1));
select t.ok('出席：時段還沒開始不能按「已完成」',
  public.massage_mark_done(t.sid('51000000-0000-0000-0000-000000000001', t.e(1)))->>'code' = 'not_started');
reset role;

-- 昨天那一期（時段都已經結束了）
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
select t.ok('出席：不接受亂填的狀態', public.massage_set_attendance(t.sid('59000000-0000-0000-0000-000000000001', t.e(382)), 'maybe')->>'code' = 'invalid_status');
reset role;
insert into public.massage_signups (session_id, user_id, result, draw_rank, offer_slot_no, offered_at, offer_status)
values ('59000000-0000-0000-0000-000000000001', t.e(389), 'waitlist', 4, 1, now() - interval '1 day', 'pending');
set role authenticated;
select t.as_user(t.e(389));
select t.ok('遞補：時段已經結束才按「我要」→ 拒絕',
  public.massage_accept_offer(t.sid('59000000-0000-0000-0000-000000000001', t.e(389)))->>'code' = 'slot_over');
reset role;


-- =========================================================================
-- 12. 管理者直接指定遞補（不照順序、蓋過系統邀請）
-- =========================================================================
insert into public.massage_sessions (id, title, session_date, slot_count, signup_deadline, cancel_deadline)
values ('5d000000-0000-0000-0000-000000000001', '指定遞補', t.td() + 90, 3, now() + interval '1 hour',
        ((t.td() + 90 + time '12:00') at time zone 'Asia/Taipei'));
insert into public.massage_signups (session_id, user_id, signed_up_at)
select '5d000000-0000-0000-0000-000000000001', t.e(60 + n), now() + n * interval '1 second' from generate_series(1, 6) n;
select t.close('5d000000-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('5d000000-0000-0000-0000-000000000001');

-- 名次 1 取消 → 系統邀請名次 4（時段 1）
set role authenticated;
select t.as_user(t.uidrank('5d000000-0000-0000-0000-000000000001', 1));
select public.massage_release(t.byrank('5d000000-0000-0000-0000-000000000001', 1));
select t.as_user(t.e(1));
select t.ok('指定遞補：一般同仁不能用',
  public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 6), 1)->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table a1 as select public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 6), 1) r;
select t.ok('指定遞補：可以不照順序，直接指定名次 6',
  (select (r->>'ok')::bool and (r->>'slot_no')::int = 1 from a1)
  and (select slot_no = 1 and result = 'selected' from public.massage_signups
        where id = t.byrank('5d000000-0000-0000-0000-000000000001', 6)));
select t.ok('指定遞補：系統原本發給名次 4 的邀請作廢',
  (select (r->'superseded_signup_ids') ? t.byrank('5d000000-0000-0000-0000-000000000001', 4)::text from a1)
  and (select offer_status = 'superseded' from public.massage_signups
        where id = t.byrank('5d000000-0000-0000-0000-000000000001', 4)));
select t.as_user(t.uidrank('5d000000-0000-0000-0000-000000000001', 4));
select t.ok('指定遞補：作廢的邀請按「我要」沒有用',
  public.massage_accept_offer(t.byrank('5d000000-0000-0000-0000-000000000001', 4))->>'code' = 'no_pending_offer');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('指定遞補：時段已經有人 → 不行',
  public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 5), 2)->>'code' = 'slot_taken');
select t.ok('指定遞補：只能指定候補',
  public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 2), 1)->>'code' = 'not_waitlisted');

-- 名次 2、3 取消 → 系統分別邀請名次 4（時段 2）、名次 5（時段 3）
select t.as_user(t.uidrank('5d000000-0000-0000-0000-000000000001', 2));
select t.ok('指定遞補：作廢過一次的人，之後空出的時段還是會被系統問',
  (public.massage_release(t.byrank('5d000000-0000-0000-0000-000000000001', 2))->>'offered_signup_id')::uuid
    = t.byrank('5d000000-0000-0000-0000-000000000001', 4));
select t.as_user(t.uidrank('5d000000-0000-0000-0000-000000000001', 3));
select public.massage_release(t.byrank('5d000000-0000-0000-0000-000000000001', 3));
-- 管理者把手上有時段 2 邀請的名次 4，直接排去時段 3
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table a2 as select public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 4), 3) r;
select t.ok('指定遞補：被指定的人原本手上別的時段的邀請，改邀下一位（名次 5 改問時段 2）',
  (select (r->>'reoffered_signup_id')::uuid = t.byrank('5d000000-0000-0000-0000-000000000001', 5) from a2)
  and (select offer_status = 'pending' and offer_slot_no = 2 from public.massage_signups
        where id = t.byrank('5d000000-0000-0000-0000-000000000001', 5)));
reset role;

-- 撞到請假也可以指定，只標示
select t.leave(t.uidrank('5d000000-0000-0000-0000-000000000001', 5), t.td()+89, t.td()+91, '09:00', '18:00');
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table a3 as select public.massage_assign_waitlist(t.byrank('5d000000-0000-0000-0000-000000000001', 5), 2) r;
select t.ok('指定遞補：撞到請假也可以指定（現場講好的），但標示衝突',
  (select (r->>'ok')::bool and (r->>'slot_conflict')::bool from a3)
  and (select slot_conflict and offer_status = 'accepted' from public.massage_signups
        where id = t.byrank('5d000000-0000-0000-0000-000000000001', 5)));
reset role;


-- =========================================================================
-- 13. 負責人
-- =========================================================================
set role authenticated;
select t.as_user(t.e(1));
select t.ok('負責人：一般同仁不能設定', public.massage_set_owner(t.e(1))->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('負責人：只能設成管理員或 HR', public.massage_set_owner(t.e(1))->>'code' = 'owner_not_manager');
select t.ok('負責人：HR 可以把負責人設成管理員',
  (public.massage_set_owner('aaaaaaaa-0000-0000-0000-000000000001')->>'ok')::bool);
select t.as_user(t.e(1));
select t.ok('負責人：全公司都看得到是誰',
  (select owner_id from public.massage_settings) = 'aaaaaaaa-0000-0000-0000-000000000001');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin
  update public.massage_settings set owner_id = null;
  perform t.ok('負責人：不能繞過檢查直接改資料表', false);
exception when insufficient_privilege then perform t.ok('負責人：不能繞過檢查直接改資料表', true);
end $$;
reset role;


-- =========================================================================
-- 14. 管理頁：每位報名者可以按的時段
-- =========================================================================
set role authenticated;
select t.as_user(t.e(1));
select t.ok('管理頁時段資訊：一般同仁拿不到',
  (select count(*) = 0 from public.massage_session_ok_slots('51000000-0000-0000-0000-000000000001')));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('管理頁時段資訊：管理者拿得到，部分請假的人只列出可以的時段',
  (select ok_slots = array[3,4,5,6,7,8,9] from public.massage_session_ok_slots('51000000-0000-0000-0000-000000000001')
    where signup_id = t.sid('51000000-0000-0000-0000-000000000001', t.e(11)))
  and (select count(*) = 9 from public.massage_session_ok_slots('51000000-0000-0000-0000-000000000001')));
reset role;


-- =========================================================================
-- 15. 異動紀錄
-- =========================================================================
-- 取消後重新報名：被覆蓋掉的原始報名時間，紀錄裡要查得到
select t.ok('紀錄：取消後重新報名 → 報名、取消、重新報名三筆依序都在',
  (select array_agg(event order by id) from public.massage_events
    where signup_id = t.sid('51000000-0000-0000-0000-000000000001', t.e(6))
      and event in ('signed_up', 'withdrew'))
  = array['signed_up', 'withdrew', 'signed_up']);
select t.ok('紀錄：重新報名那筆附上原本的報名時間',
  (select (details->>'reactivated')::bool and details->>'previous_signed_up_at' is not null
     from public.massage_events
    where signup_id = t.sid('51000000-0000-0000-0000-000000000001', t.e(6)) and event = 'signed_up'
    order by id desc limit 1));

-- 抽籤：整期一筆 + 每人一筆（抽籤當下排到的時段，之後換時段也查得回來）
select t.ok('紀錄：抽籤 → 整期一筆，並記下是誰按的',
  (select count(*) = 1 and bool_and(actor_id = 'aaaaaaaa-0000-0000-0000-000000000001')
     from public.massage_events where session_id = '51000000-0000-0000-0000-000000000001' and event = 'drawn'));
select t.ok('紀錄：抽籤 → 每人一筆結果（9 人）',
  (select count(*) = 9 from public.massage_events
    where session_id = '51000000-0000-0000-0000-000000000001' and event = 'draw_result'));
select t.ok('紀錄：部分請假被避開的人，抽籤結果有標出來',
  (select (details->>'avoided_leave')::bool from public.massage_events
    where signup_id = t.sid('51000000-0000-0000-0000-000000000001', t.e(11)) and event = 'draw_result'));
select t.ok('紀錄：換過時段的人，抽籤當下原本的時段還查得到（名次 5 原本在時段 5）',
  (select slot_no = 5 from public.massage_events
    where signup_id = t.byrank('52000000-0000-0000-0000-00000000000b', 5) and event = 'draw_result')
  and (select slot_no = 6 from public.massage_signups where id = t.byrank('52000000-0000-0000-0000-00000000000b', 5)));

-- 取消 → 系統邀請 → 按「我要」，順序要對
select t.ok('紀錄：名次 1 取消、系統邀請名次 11、名次 11 按我要，依序記錄',
  (select array_agg(event order by id) from public.massage_events
    where session_id = '52000000-0000-0000-0000-00000000000b'
      and ((signup_id = t.byrank('52000000-0000-0000-0000-00000000000b', 1) and event = 'released')
        or (signup_id = t.byrank('52000000-0000-0000-0000-00000000000b', 11) and event in ('offered', 'accepted') and slot_no = 1)))
  = array['released', 'offered', 'accepted']);
select t.ok('紀錄：系統發的邀請，操作者是「系統」（空白）',
  (select bool_and(actor_id is null) from public.massage_events
    where session_id = '52000000-0000-0000-0000-00000000000b' and event = 'offered'));
select t.ok('紀錄：取消期限後才取消 → 有標記逾期',
  (select (details->>'late')::bool from public.massage_events
    where signup_id = t.byrank('52000000-0000-0000-0000-00000000000b', 4) and event = 'released'));
select t.ok('紀錄：邀請過期有記錄',
  (select count(*) >= 1 from public.massage_events
    where signup_id = t.byrank('52000000-0000-0000-0000-00000000000b', 12) and event = 'offer_expired'));
select t.ok('紀錄：對調時段 → 兩個人各一筆，記下從哪換到哪',
  (select count(*) = 2 from public.massage_events
    where session_id = '52000000-0000-0000-0000-00000000000b' and event = 'moved'
      and ((details->>'from')::int, (details->>'to')::int) in ((5, 6), (6, 5))));

-- 讓出
select t.ok('紀錄：選擇保留名額 → yield_answered（kept）',
  (select count(*) = 1 from public.massage_events
    where signup_id = (select id from yq where k = 2) and event = 'yield_answered' and details->>'answer' = 'kept'));
select t.ok('紀錄：選擇讓出 → released（reason = yield）',
  (select count(*) = 1 from public.massage_events
    where signup_id = (select id from yq where k = 1) and event = 'released' and details->>'reason' = 'yield'));

-- 管理者直接指定：分得出「自己按我要」還是「管理者指定」
select t.ok('紀錄：管理者直接指定遞補 → assigned，操作者是管理者',
  (select actor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and slot_no = 1 from public.massage_events
    where signup_id = t.byrank('5d000000-0000-0000-0000-000000000001', 6) and event = 'assigned'));
select t.ok('紀錄：被蓋過的系統邀請 → offer_superseded',
  (select count(*) = 1 from public.massage_events
    where signup_id = t.byrank('5d000000-0000-0000-0000-000000000001', 4) and event = 'offer_superseded'));

-- 現場沒到、出席
select t.ok('紀錄：現場按沒到 → no_show，接著系統邀請候補',
  (select array_agg(event order by id) from public.massage_events
    where session_id = '5c000000-0000-0000-0000-000000000001' and event in ('no_show', 'offered'))
  = array['no_show', 'offered']);
select t.ok('紀錄：本人按已完成 → attendance（by self）',
  (select details->>'by' = 'self' and details->>'status' = 'attended' from public.massage_events
    where signup_id = t.sid('59000000-0000-0000-0000-000000000001', t.e(381)) and event = 'attendance'));
select t.ok('紀錄：管理者標未到再清除 → 兩筆都留著（清除那筆附上原本的值）',
  (select array_agg(coalesce(details->>'status', '清除') || '/' || coalesce(details->>'previous', '-') order by id)
     from public.massage_events
    where signup_id = t.sid('59000000-0000-0000-0000-000000000001', t.e(382)) and event = 'attendance')
  = array['no_show/-', '清除/no_show']);
select t.ok('紀錄：更換負責人有記錄',
  (select count(*) = 1 from public.massage_events where event = 'owner_changed'
      and details->>'to' = 'aaaaaaaa-0000-0000-0000-000000000001'));

-- 權限
set role authenticated;
select t.as_user(t.e(1));
select t.ok('紀錄：一般同仁看不到', (select count(*) = 0 from public.massage_events));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');
select t.ok('紀錄：HR 看得到', (select count(*) > 0 from public.massage_events));
do $$ begin
  update public.massage_events set event = 'x';
  perform t.ok('紀錄：管理者也不能修改', false);
exception when insufficient_privilege then perform t.ok('紀錄：管理者也不能修改', true);
end $$;
do $$ begin
  insert into public.massage_events (event) values ('fake');
  perform t.ok('紀錄：不能直接新增假紀錄', false);
exception when insufficient_privilege then perform t.ok('紀錄：不能直接新增假紀錄', true);
end $$;
do $$ begin
  delete from public.massage_events;
  perform t.ok('紀錄：不能刪除', false);
exception when insufficient_privilege then perform t.ok('紀錄：不能刪除', true);
end $$;
reset role;
do $$ begin
  update public.massage_events set event = 'x' where id = (select min(id) from public.massage_events);
  perform t.ok('紀錄：就算是資料庫擁有者直接改，也會被擋', false);
exception when raise_exception then perform t.ok('紀錄：就算是資料庫擁有者直接改，也會被擋', true);
end $$;
