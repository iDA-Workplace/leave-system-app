-- 20261021_massage_add_to_slot.sql 的測試（接在 10_tests.sql 之後跑，沿用它的小工具）
\set ON_ERROR_STOP 1
set client_min_messages = warning;
truncate t.results;
reset role;

-- A 期：TD+60，3 人報名（不到 9 人 → 不抽籤，照報名順序排時段 1～3）
select t.mk('a5000000-0000-0000-0000-000000000001', t.td() + 60);
-- 還沒抽籤的 C 期
select t.mk('c5000000-0000-0000-0000-000000000001', t.td() + 61);
select t.leave(t.e(312), t.td()+60, t.td()+60, '14:00', '15:00');   -- 撞到時段 5（14:20）、6（14:40）

set role authenticated;
select t.as_user(t.e(301)); select public.massage_sign_up('a5000000-0000-0000-0000-000000000001');
select t.as_user(t.e(302)); select public.massage_sign_up('a5000000-0000-0000-0000-000000000001');
select t.as_user(t.e(303)); select public.massage_sign_up('a5000000-0000-0000-0000-000000000001');
reset role;
select t.close('a5000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('a5000000-0000-0000-0000-000000000001');

-- 權限與基本檢查
select t.as_user(t.e(301));
select t.ok('加入：一般同仁不能用', public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(310), 5)->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');   -- HR 也可以
select t.ok('加入：還沒抽籤的期數不行', public.massage_add_to_slot('c5000000-0000-0000-0000-000000000001', t.e(310), 1)->>'code' = 'not_drawn');
select t.ok('加入：時段不存在', public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(310), 10)->>'code' = 'invalid_slot');
select t.ok('加入：離職的人不行', public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000099', 5)->>'code' = 'user_inactive');
select t.ok('加入：已經有人的時段不行', public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(310), 1)->>'code' = 'slot_taken');

-- 沒報名的人加進空時段
create temp table r1 as select public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(310), 5) r;
select t.ok('加入：沒報名的人可以加進空時段', (select (r->>'ok')::bool and r->>'via' = 'added' from r1));
reset role;
select t.ok('加入：報名資料是正取、時段 5、記下誰加的',
  (select result = 'selected' and slot_no = 5 and added_by = 'aaaaaaaa-0000-0000-0000-000000000002'
          and added_at is not null and draw_rank is null and not slot_conflict
     from public.massage_signups where id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(310))));
select t.ok('加入：異動紀錄記一筆 added（給 Slack 通知用）',
  exists (select 1 from public.massage_events
           where signup_id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(310))
             and event = 'added' and slot_no = 5 and actor_id = 'aaaaaaaa-0000-0000-0000-000000000002'
             and details->>'reactivated' = 'false'));
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('加入：已經有時段的人不能再加（要用改時段）',
  public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(310), 6)->>'code' = 'already_has_slot');

-- 撞到請假：先回「要確認」，確認後可以加
select t.ok('加入：撞到請假 → 先要求確認，還沒寫入',
  public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(312), 6)->>'code' = 'leave_conflict_confirm');
reset role;
select t.ok('加入：要求確認時什麼都沒寫', t.sid('a5000000-0000-0000-0000-000000000001', t.e(312)) is null);
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('加入：確認後（p_force）可以加，標示請假衝突',
  (select (r->>'ok')::bool and (r->>'slot_conflict')::bool
     from (select public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(312), 6, true) r) x));
select t.ok('加入：沒撞到請假的時段不用確認',
  (public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(313), 7)->>'ok')::bool);

-- 取消過的人加回來
select t.as_user(t.e(302));
select public.massage_release(t.sid('a5000000-0000-0000-0000-000000000001', t.e(302)));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table r2 as select public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(302), 2) r;
select t.ok('加入：這期取消過的人可以加回來', (select (r->>'ok')::bool and r->>'via' = 'reactivated' from r2));
reset role;
select t.ok('加入：加回來後沒有取消時間、回到時段 2',
  (select released_at is null and slot_no = 2 and added_at is not null
     from public.massage_signups where id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(302))));
select t.ok('加入：原本的取消紀錄還在',
  exists (select 1 from public.massage_events
           where signup_id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(302)) and event = 'released'));

-- 逾期取消（記成未到）的人加回來 → 未到清掉
update public.massage_sessions set cancel_deadline = now() - interval '1 minute'
 where id = 'a5000000-0000-0000-0000-000000000001';
set role authenticated;
select t.as_user(t.e(303));
select public.massage_release(t.sid('a5000000-0000-0000-0000-000000000001', t.e(303)));
reset role;
select t.ok('（前提）逾期取消被記成未到',
  (select released_late and attendance = 'no_show'
     from public.massage_signups where id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(303))));
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_add_to_slot('a5000000-0000-0000-0000-000000000001', t.e(303), 3);
reset role;
select t.ok('加入：逾期取消的人加回來，未到與逾期標記清掉',
  (select not released_late and attendance is null and released_at is null
     from public.massage_signups where id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(303))));
select t.ok('加入：異動紀錄記下原本是未到',
  exists (select 1 from public.massage_events
           where signup_id = t.sid('a5000000-0000-0000-0000-000000000001', t.e(303))
             and event = 'added' and details->>'previous_attendance' = 'no_show'));

-- B 期：3 個時段、4 人報名 → 1 位候補
select t.mk('b5000000-0000-0000-0000-000000000001', t.td() + 62);
update public.massage_sessions set slot_count = 3 where id = 'b5000000-0000-0000-0000-000000000001';
set role authenticated;
select t.as_user(t.e(321)); select public.massage_sign_up('b5000000-0000-0000-0000-000000000001');
select t.as_user(t.e(322)); select public.massage_sign_up('b5000000-0000-0000-0000-000000000001');
select t.as_user(t.e(323)); select public.massage_sign_up('b5000000-0000-0000-0000-000000000001');
select t.as_user(t.e(324)); select public.massage_sign_up('b5000000-0000-0000-0000-000000000001');
reset role;
select t.close('b5000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('b5000000-0000-0000-0000-000000000001');

-- 正取第 1 名釋出 → 系統邀請候補；管理者把「沒報名的人」加進那個時段 → 邀請作廢
reset role;
create temp table b as
select (select slot_no from public.massage_signups where id = t.byrank('b5000000-0000-0000-0000-000000000001', 1)) as slot1,
       (select slot_no from public.massage_signups where id = t.byrank('b5000000-0000-0000-0000-000000000001', 2)) as slot2;
grant select on b to authenticated;
set role authenticated;
select t.as_user(t.uidrank('b5000000-0000-0000-0000-000000000001', 1));
select public.massage_release(t.byrank('b5000000-0000-0000-0000-000000000001', 1));
reset role;
select t.ok('（前提）候補收到時段的邀請',
  (select offer_status = 'pending' and offer_slot_no = (select slot1 from b)
     from public.massage_signups where id = t.byrank('b5000000-0000-0000-0000-000000000001', 4)));
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_add_to_slot('b5000000-0000-0000-0000-000000000001', t.e(330), (select slot1 from b));
reset role;
select t.ok('加入：那個時段上的候補邀請作廢',
  (select offer_status = 'superseded'
     from public.massage_signups where id = t.byrank('b5000000-0000-0000-0000-000000000001', 4)));
select t.ok('加入：作廢記一筆 offer_superseded（Slack 會通知候補）',
  exists (select 1 from public.massage_events
           where signup_id = t.byrank('b5000000-0000-0000-0000-000000000001', 4) and event = 'offer_superseded'));

-- 正取第 2 名釋出 → 再邀候補；管理者直接選這位候補 → 走指定遞補
set role authenticated;
select t.as_user(t.uidrank('b5000000-0000-0000-0000-000000000001', 2));
select public.massage_release(t.byrank('b5000000-0000-0000-0000-000000000001', 2));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table r3 as
select public.massage_add_to_slot('b5000000-0000-0000-0000-000000000001',
         t.uidrank('b5000000-0000-0000-0000-000000000001', 4), (select slot2 from b)) r;
select t.ok('加入：選到正在候補的人 → 走指定遞補', (select (r->>'ok')::bool and r->>'via' = 'assigned' from r3));
reset role;
select t.ok('加入：候補拿到時段，記一筆 assigned',
  (select slot_no = (select slot2 from b) and offer_status = 'accepted'
     from public.massage_signups where id = t.byrank('b5000000-0000-0000-0000-000000000001', 4))
  and exists (select 1 from public.massage_events
               where signup_id = t.byrank('b5000000-0000-0000-0000-000000000001', 4) and event = 'assigned'));

select name, pass, detail from t.results order by n;
select format('%s / %s 通過', count(*) filter (where pass), count(*)) from t.results;
