-- 20261026_massage_release_hold.sql 的測試（接在 10_tests.sql 之後跑，沿用它的小工具）
\set ON_ERROR_STOP 1
set client_min_messages = warning;
truncate t.results;
reset role;

-- 這一組用新的同仁 501～520（10_tests 用到 400）
insert into public.users (id, full_name) select t.e(n), '員工' || n from generate_series(501, 520) n;

create function t.slot_of(p_session uuid, p_user uuid) returns int language sql stable as $$
  select slot_no from public.massage_signups where session_id = p_session and user_id = p_user
$$;
grant execute on function t.slot_of(uuid, uuid) to authenticated;

-- F 期：明天（釋出開放時間預設＝明天 11:00，現在一定還在等待期），11 人報名 9 個名額
select t.mk('f6000000-0000-0000-0000-000000000001', t.td() + 1);
set role authenticated;
do $$ begin
  for n in 501..511 loop
    perform t.as_user(t.e(n));
    perform public.massage_sign_up('f6000000-0000-0000-0000-000000000001');
  end loop;
end $$;
reset role;
select t.close('f6000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('f6000000-0000-0000-0000-000000000001');
reset role;

create temp table f as select
  'f6000000-0000-0000-0000-000000000001'::uuid sid,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 1) r1,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 2) r2,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 3) r3,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 4) r4,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 5) r5,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 10) w1,
  t.uidrank('f6000000-0000-0000-0000-000000000001', 11) w2;
grant select on f to authenticated;

select t.ok('開放時間：沒填的期數預設是按摩當天 11:00（台灣時間）',
  (select release_open_at = ((t.td() + 1 + time '11:00') at time zone 'Asia/Taipei') and release_opened_at is null
     from public.massage_sessions where id = (select sid from f)));
select t.ok('開放時間：既有的期數也補上了',
  not exists (select 1 from public.massage_sessions where release_open_at is null));
select t.ok('等待期：抽過籤、還沒到開放時間', public.massage_release_held((select sid from f)));

-- 等待期間釋出 → 先不邀請候補
create temp table s1 as select t.slot_of((select sid from f), (select r1 from f)) n;
grant select on s1 to authenticated;
set role authenticated;
select t.as_user((select r1 from f));
create temp table rel1 as select public.massage_release(t.sid((select sid from f), (select r1 from f))) r;
reset role;
select t.ok('等待期釋出：成功，回傳 held 與開放時間',
  (select (r->>'ok')::bool and (r->>'held')::bool and r->>'opens_at' is not null and r->>'offered_signup_id' is null from rel1));
select t.ok('等待期釋出：沒有邀請任何候補',
  not exists (select 1 from public.massage_signups where session_id = (select sid from f) and offer_status = 'pending'));
select t.ok('等待期釋出：紀錄 released 帶 held = true',
  exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'released'
             and user_id = (select r1 from f) and (details->>'held')::bool));
select t.ok('等待期釋出：沒有記 slot_open',
  not exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'slot_open'));
select t.ok('釋出中：這個時段列在 held_slots', (select n from s1) = any(public.massage_held_slots((select sid from f))));
select t.ok('還沒開放：沒有可以搶的時段', cardinality(public.massage_open_slots((select sid from f))) = 0);
set role authenticated;
select t.as_user(t.e(512));
select t.ok('還沒開放：搶不到（not_open）',
  public.massage_grab_slot((select sid from f), (select n from s1))->>'code' = 'not_open');

-- 取消釋出
select t.as_user(t.e(512));
select t.ok('取消釋出：別人不能幫他取消',
  public.massage_cancel_release(t.sid((select sid from f), (select r1 from f)))->>'code' = 'not_found');
select t.as_user((select r1 from f));
select t.ok('取消釋出：本人在等待期間可以取消',
  (public.massage_cancel_release(t.sid((select sid from f), (select r1 from f)))->>'ok')::bool);
reset role;
select t.ok('取消釋出：回到原本的時段',
  (select released_at is null and slot_no = (select n from s1) and not released_late
     from public.massage_signups where id = t.sid((select sid from f), (select r1 from f))));
select t.ok('取消釋出：記一筆 release_cancelled',
  exists (select 1 from public.massage_events where session_id = (select sid from f)
             and event = 'release_cancelled' and user_id = (select r1 from f)));
set role authenticated;
select t.as_user((select r1 from f));
select t.ok('取消釋出：沒釋出的不能取消',
  public.massage_cancel_release(t.sid((select sid from f), (select r1 from f)))->>'code' = 'not_released');

-- 再釋出一次，負責人把別人排進去 → 不能取消釋出了
select public.massage_release(t.sid((select sid from f), (select r1 from f)));
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('等待期：負責人可以把別人排進釋出中的時段',
  (public.massage_add_to_slot((select sid from f), t.e(513), (select n from s1))->>'ok')::bool);
select t.as_user((select r1 from f));
select t.ok('取消釋出：時段已經排了別人 → slot_taken',
  public.massage_cancel_release(t.sid((select sid from f), (select r1 from f)))->>'code' = 'slot_taken');
reset role;
select t.ok('釋出中：已經排了人的時段不算', not ((select n from s1) = any(public.massage_held_slots((select sid from f)))));

-- 讓給候補也一樣先保留；取消後「要不要讓」回到還沒回答
update public.massage_signups set yield_asked = true where id = t.sid((select sid from f), (select r2 from f));
set role authenticated;
select t.as_user((select r2 from f));
select t.ok('讓給候補：等待期一樣先保留',
  (select (r->>'held')::bool from (select public.massage_answer_yield(t.sid((select sid from f), (select r2 from f)), true) r) x));
select public.massage_cancel_release(t.sid((select sid from f), (select r2 from f)));
reset role;
select t.ok('讓給候補後取消釋出：回到還沒回答',
  (select released_at is null and yield_answer is null from public.massage_signups
    where id = t.sid((select sid from f), (select r2 from f))));

-- 超過取消期限才釋出：不再記未到
update public.massage_sessions set cancel_deadline = now() - interval '1 minute' where id = (select sid from f);
set role authenticated;
select t.as_user((select r2 from f));
select public.massage_release(t.sid((select sid from f), (select r2 from f)));
select t.as_user((select r3 from f));
select public.massage_release(t.sid((select sid from f), (select r3 from f)));
select t.as_user((select r4 from f));
select public.massage_release(t.sid((select sid from f), (select r4 from f)));
reset role;
select t.ok('逾期釋出：記下 released_late，但不記未到',
  (select released_late and attendance is null from public.massage_signups
    where id = t.sid((select sid from f), (select r2 from f))));

-- 開放狀態只能由系統改
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin
  begin
    update public.massage_sessions set release_opened_at = now() where id = 'f6000000-0000-0000-0000-000000000001';
    perform t.ok('開放狀態：管理者不能直接改', false);
  exception when others then
    perform t.ok('開放狀態：管理者不能直接改', sqlerrm like 'massage_session_locked%');
  end;
end $$;
reset role;

-- 開放時間到了 → 一次處理
create temp table slots_before as select
  t.slot_of((select sid from f), (select r2 from f)) a,
  t.slot_of((select sid from f), (select r3 from f)) b,
  t.slot_of((select sid from f), (select r4 from f)) c;
grant select on slots_before to authenticated;
update public.massage_sessions set release_open_at = now() - interval '1 minute' where id = (select sid from f);
select t.ok('開放時間改到過去：還沒處理前仍是等待期以外、尚未開放',
  (select release_opened_at is null from public.massage_sessions where id = (select sid from f))
  and not public.massage_release_held((select sid from f)));
set role service_role;
select t.ok('一次處理：處理了一期', public.massage_open_releases() >= 1);
select t.ok('一次處理：再跑一次不會重複處理這一期', public.massage_open_releases() = 0);
reset role;
select t.ok('一次處理：記下處理時間',
  (select release_opened_at is not null from public.massage_sessions where id = (select sid from f)));
select t.ok('一次處理：候補第 1、2 位各收到一個邀請（照名次）',
  (select offer_status = 'pending' and offer_slot_no = (select a from slots_before)
     from public.massage_signups where session_id = (select sid from f) and user_id = (select w1 from f))
  and (select offer_status = 'pending' and offer_slot_no = (select b from slots_before)
     from public.massage_signups where session_id = (select sid from f) and user_id = (select w2 from f)));
select t.ok('一次處理：邀請時限 30 分鐘（離開始 1 小時以上）',
  (select offer_expires_at between now() + interval '29 minutes' and now() + interval '31 minutes'
     from public.massage_signups where session_id = (select sid from f) and user_id = (select w1 from f)));
select t.ok('一次處理：候補不夠的時段記 slot_open（batch）',
  exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'slot_open'
             and slot_no = (select c from slots_before) and (details->>'batch')::bool));
select t.ok('一次處理：邀請也標 batch（Slack 給負責人一則總整理就好）',
  (select bool_and((details->>'batch')::bool) from public.massage_events
    where session_id = (select sid from f) and event = 'offered'));
select t.ok('一次處理：總整理 releases_opened 列出 3 個時段，含是誰釋出的',
  (select jsonb_array_length(details->'slots') = 3
          and exists (select 1 from jsonb_array_elements(details->'slots') e
                       where (e->>'slot')::int = (select c from slots_before)
                         and (e->>'released_user_id')::uuid = (select r4 from f)
                         and e->>'offered_user_id' is null)
     from public.massage_events where session_id = (select sid from f) and event = 'releases_opened'));
select t.ok('開放後：可以搶的只有沒候補的那個時段',
  public.massage_open_slots((select sid from f)) = array[(select c from slots_before)]);
select t.ok('開放後：不再是等待期，沒有「釋出中」', cardinality(public.massage_held_slots((select sid from f))) = 0);

-- 搶空位
select t.leave(t.e(514), t.td() + 1, t.td() + 1, '09:00', '18:00');
set role authenticated;
select t.as_user((select r5 from f));
select t.ok('搶空位：這期已經有時段 → already_has_slot',
  public.massage_grab_slot((select sid from f), (select c from slots_before))->>'code' = 'already_has_slot');
select t.as_user(t.e(514));
select t.ok('搶空位：那個時段在請假 → leave_conflict，附假單',
  (select r->>'code' = 'leave_conflict' and r->'leave'->>'start_time' = '09:00'
     from (select public.massage_grab_slot((select sid from f), (select c from slots_before)) r) x));
select t.as_user((select r1 from f));
select t.ok('取消釋出：開放之後就不行了',
  public.massage_cancel_release(t.sid((select sid from f), (select r1 from f)))->>'code' in ('cancel_release_closed', 'slot_taken'));
select t.as_user(t.e(515));
create temp table g1 as select public.massage_grab_slot((select sid from f), (select c from slots_before)) r;
select t.as_user((select r4 from f));
select t.ok('搶空位：先搶先贏，晚一步的人 → slot_taken',
  public.massage_grab_slot((select sid from f), (select c from slots_before))->>'code' = 'slot_taken');
reset role;
select t.ok('搶空位：沒報名的人搶到了', (select (r->>'ok')::bool from g1));
select t.ok('搶空位：報名資料是正取、記下搶到的時間',
  (select result = 'selected' and slot_no = (select c from slots_before) and grabbed_at is not null and draw_rank is null
     from public.massage_signups where id = t.sid((select sid from f), t.e(515))));
select t.ok('搶空位：記一筆 grabbed',
  exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'grabbed'
             and user_id = t.e(515) and slot_no = (select c from slots_before)));

-- 開放後的釋出：當下處理（候補都已經有邀請 → 直接 slot_open）
create temp table s5 as select t.slot_of((select sid from f), (select r5 from f)) n;
grant select on s5 to authenticated;
set role authenticated;
select t.as_user((select r5 from f));
select t.ok('開放後釋出：不再保留',
  (select not (r->>'held')::bool from (select public.massage_release(t.sid((select sid from f), (select r5 from f))) r) x));
reset role;
select t.ok('開放後釋出：當下記 slot_open（不是 batch）',
  exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'slot_open'
             and slot_no = (select n from s5) and not (details->>'batch')::bool));

-- 剛釋出的本人也可以搶回來（使用者決定）
set role authenticated;
select t.as_user((select r4 from f));
select t.ok('搶空位：這期釋出過的人也可以搶',
  (public.massage_grab_slot((select sid from f), (select n from s5))->>'ok')::bool);
reset role;
select t.ok('搶空位：釋出過的人搶回來 → 沒有取消時間',
  (select released_at is null and slot_no = (select n from s5) from public.massage_signups
    where id = t.sid((select sid from f), (select r4 from f))));

-- 手上有邀請的候補去搶別的時段 → 原本的邀請放棄、改邀下一位
set role authenticated;
select t.as_user((select r3 from f));
select public.massage_release(t.sid((select sid from f), t.e(515)));  -- 不是自己的，不會成功
select t.as_user(t.e(515));
select public.massage_release(t.sid((select sid from f), t.e(515)));  -- 時段 c 空出來 → slot_open
select t.as_user((select w1 from f));
select t.ok('搶空位：手上有邀請的候補也可以搶別的時段',
  (public.massage_grab_slot((select sid from f), (select c from slots_before))->>'ok')::bool);
reset role;
select t.ok('搶空位：原本的邀請標成 declined',
  (select offer_status = 'declined' and slot_no = (select c from slots_before)
     from public.massage_signups where session_id = (select sid from f) and user_id = (select w1 from f)));
select t.ok('搶空位：放棄的那個時段沒有別的候補 → slot_open',
  exists (select 1 from public.massage_events where session_id = (select sid from f) and event = 'slot_open'
             and slot_no = (select a from slots_before)));

-- 開放時間改到未來 → 重新進入等待期
update public.massage_sessions set release_open_at = now() + interval '1 hour' where id = (select sid from f);
select t.ok('開放時間改到未來：重新進入等待期',
  (select release_opened_at is null from public.massage_sessions where id = (select sid from f))
  and public.massage_release_held((select sid from f)));

-- 邀請時限級距
reset role;
create function t.window_in(p_min int) returns int language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.massage_sessions (id, title, session_date, start_time, signup_deadline, cancel_deadline)
  values (v_id, '時限', ((now() + make_interval(mins => p_min)) at time zone 'Asia/Taipei')::date,
          ((now() + make_interval(mins => p_min)) at time zone 'Asia/Taipei')::time,
          now() - interval '1 day', now());
  return public.massage_offer_window(v_id, 1);
end $$;
select t.ok('時限：離開始 2 小時 → 30 分鐘', t.window_in(120) = 30);
select t.ok('時限：離開始 45 分鐘 → 15 分鐘', t.window_in(45) = 15);
select t.ok('時限：離開始 20 分鐘 → 10 分鐘', t.window_in(20) = 10);
select t.ok('時限：離開始 10 分鐘 → 5 分鐘', t.window_in(10) = 5);
select t.ok('時限：離開始 3 分鐘 → 1 分鐘', t.window_in(3) = 1);
select t.ok('時限：已經開始 → 1 分鐘', t.window_in(-2) = 1);

-- 空位通知的對象
update public.users set slack_user_id = 'U' || right(id::text, 6) where id in (t.e(516), t.e(517), t.e(514), (select r2 from f));
update public.users set slack_user_id = 'UOWNSLOT' where id = (select r4 from f);
select t.ok('空位通知對象：有 Slack ID、這期沒有時段的人；請假撞到的時段扣掉',
  (select array_agg(user_id order by user_id) from public.massage_open_slot_recipients((select sid from f), array[1, 2]))
  = (select array_agg(x order by x) from unnest(array[t.e(516), t.e(517), (select r2 from f)]) x));

select name, pass, detail from t.results order by n;
select format('%s / %s 通過', count(*) filter (where pass), count(*)) from t.results;
