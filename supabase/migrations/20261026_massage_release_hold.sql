-- ============================================================================
-- 按摩預約：釋出名額等到「釋出開放時間」才處理、取消釋出、候補邀請時限、
--           空位先搶先贏
-- ============================================================================
--
-- 要先執行 20261019 ～ 20261025 的 migration。
--
-- 使用者決定的規則（2026-10）：
--
-- 1. 釋出等待期
--    抽籤後到「釋出開放時間」（每期可設定，預設按摩當天 11:00）之前的釋出
--    （包含讓給候補），先不邀請候補，時段顯示「釋出中」。開放時間一到，
--    一次處理（massage_open_releases，排程每分鐘呼叫）：有候補 → 邀請候補；
--    沒候補 → 空位通知（先搶先贏）。報名人數本來就不到名額、抽籤後就空著的
--    時段，也在這時一起發空位通知。開放時間之後的釋出，當下就處理。
--
-- 2. 取消釋出
--    等待期間，釋出的人可以取消釋出，回到原本的時段，像沒釋出過一樣。
--    負責人在等待期間把別人排進那個時段之後，就不能取消了。
--
-- 3. 超過取消期限才釋出：不再記為「未到」（released_late 仍然記著，給負責人參考）。
--    現場按「沒到」照舊記未到。
--
-- 4. 候補邀請時限：看發出邀請時離時段開始還有多久
--      1 小時以上 30 分鐘、30 分鐘～1 小時 15 分鐘、15～30 分鐘 10 分鐘、
--      5～15 分鐘 5 分鐘、5 分鐘內（或時段已開始）1 分鐘。
--    （原本的 onsite_offer_window_minutes 不再使用）
--    沒有候補可以邀請 → 記一筆 slot_open，Slack 發空位通知。
--
-- 5. 空位先搶先贏（massage_grab_slot）
--    開放之後還空著（沒人、也沒有人手上有邀請）的時段，任何在職同仁都可以搶，
--    包含這期取消過、剛釋出這個時段的本人。這期已經有時段、那個時段在請假的人不行。

-- ---------------------------------------------------------------------------
-- 欄位
-- ---------------------------------------------------------------------------

alter table public.massage_sessions
  add column if not exists release_open_at timestamptz,
  add column if not exists release_opened_at timestamptz;

comment on column public.massage_sessions.release_open_at is
  '釋出開放時間。抽籤後到這個時間之前的釋出先保留（可以取消釋出），時間到才邀請候補／發空位通知。預設按摩當天 11:00。';
comment on column public.massage_sessions.release_opened_at is
  '開放時間到了、系統實際處理的時間（massage_open_releases 寫入）。有值之後的釋出當下就處理。';

update public.massage_sessions
   set release_open_at = (session_date + time '11:00') at time zone 'Asia/Taipei'
 where release_open_at is null;

alter table public.massage_signups
  add column if not exists grabbed_at timestamptz;

comment on column public.massage_signups.grabbed_at is
  '從空位通知搶到時段的時間（massage_grab_slot）。';
comment on column public.massage_signups.released_late is
  '超過取消期限才釋出名額（只是紀錄，給負責人參考；2026-10 起不再因此記為未到）。';

-- 沒填開放時間 → 按摩當天 11:00；release_opened_at 只能由 massage_open_releases 寫入
create or replace function public.massage_sessions_release_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.release_open_at is null then
    new.release_open_at := (new.session_date + time '11:00') at time zone 'Asia/Taipei';
  end if;

  if tg_op = 'INSERT' then
    new.release_opened_at := null;
    return new;
  end if;

  if new.release_opened_at is distinct from old.release_opened_at
     and coalesce(current_setting('massage.in_open', true), 'off') <> 'on' then
    raise exception 'massage_session_locked: 開放狀態只能由系統改變';
  end if;

  -- 開放時間改到未來 → 重新進入等待期（例如測試時改成幾分鐘後）
  if new.release_open_at is distinct from old.release_open_at and new.release_open_at > now() then
    new.release_opened_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists massage_sessions_release_guard on public.massage_sessions;
create trigger massage_sessions_release_guard
  before insert or update on public.massage_sessions
  for each row execute function public.massage_sessions_release_guard();

-- ---------------------------------------------------------------------------
-- 小工具
-- ---------------------------------------------------------------------------

/** 現在是不是「釋出等待期」：抽過籤、開放時間還沒到、也還沒處理過。 */
create or replace function public.massage_release_held(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.drawn_at is not null and s.release_opened_at is null and now() < s.release_open_at
      from public.massage_sessions s where s.id = p_session_id), false);
$$;

/** 邀請候補的時限（分鐘），看離時段開始還有多久（使用者決定的級距） */
create or replace function public.massage_offer_window(p_session_id uuid, p_slot_no int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case
    when left_ >= interval '60 minutes' then 30
    when left_ >= interval '30 minutes' then 15
    when left_ >= interval '15 minutes' then 10
    when left_ >= interval '5 minutes'  then 5
    else 1
  end
  from (select public.massage_slot_start(p_session_id, p_slot_no) - now() as left_) x;
$$;

/**
 * 現在可以搶的時段：已經開放、還沒結束、沒有人、也沒有人手上有這個時段的邀請。
 * 網頁的「尚有名額」與 Slack 的空位通知都看這個。
 */
create or replace function public.massage_open_slots(p_session_id uuid)
returns int[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(n order by n), '{}')
    from public.massage_sessions s
    cross join lateral generate_series(1, s.slot_count) n
   where s.id = p_session_id
     and s.drawn_at is not null
     and s.release_opened_at is not null
     and now() < public.massage_slot_end(s.id, n)
     and not exists (
       select 1 from public.massage_signups g
        where g.session_id = s.id and g.released_at is null
          and (g.slot_no = n or (g.offer_status = 'pending' and g.offer_slot_no = n)));
$$;

/**
 * 等待期間「釋出中」的時段：沒有人、而且有人在抽籤後釋出了這個時段。
 * 抽籤後本來就空著的時段不算（那些顯示「無人預約」）。
 */
create or replace function public.massage_held_slots(p_session_id uuid)
returns int[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct g.slot_no order by g.slot_no), '{}')
    from public.massage_signups g
    join public.massage_sessions s on s.id = g.session_id
   where g.session_id = p_session_id
     and public.massage_release_held(p_session_id)
     and g.slot_no is not null
     and g.released_at is not null
     and g.released_at >= s.drawn_at
     and not exists (
       select 1 from public.massage_signups o
        where o.session_id = g.session_id and o.slot_no = g.slot_no and o.released_at is null);
$$;

/** 碰到這個時段的假單（給「這個時段你剛好請假」的說明用），沒有就回 null */
create or replace function public.massage_slot_leave(p_session_id uuid, p_user_id uuid, p_slot_no int)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'start_date', lr.start_date,
           'end_date', lr.end_date,
           'start_time', to_char(lr.start_time::time, 'HH24:MI'),
           'end_time', to_char(lr.end_time::time, 'HH24:MI'),
           'leave_type', lt.name,
           'leave_type_en', lt.name_en)
    from public.massage_sessions s
    join public.leave_requests lr on lr.requester_id = p_user_id
    left join public.leave_types lt on lt.id = lr.leave_type_id
   where s.id = p_session_id
     and lr.status in ('pending', 'approved')
     and public.massage_leave_touches(
           s.session_date,
           public.massage_slot_from(s.start_time, p_slot_no, s.slot_minutes, s.break_minutes),
           public.massage_slot_to(s.start_time, p_slot_no, s.slot_minutes, s.break_minutes),
           lr.start_date::date, lr.end_date::date, lr.start_time::time, lr.end_time::time)
   order by lr.start_date, lr.start_time
   limit 1;
$$;

revoke all on function public.massage_release_held(uuid) from public, anon;
revoke all on function public.massage_offer_window(uuid, int) from public, anon;
revoke all on function public.massage_open_slots(uuid) from public, anon;
revoke all on function public.massage_held_slots(uuid) from public, anon;
revoke all on function public.massage_slot_leave(uuid, uuid, int) from public, anon;
grant execute on function public.massage_release_held(uuid) to authenticated, service_role;
grant execute on function public.massage_open_slots(uuid) to authenticated, service_role;
grant execute on function public.massage_held_slots(uuid) to authenticated, service_role;
grant execute on function public.massage_offer_window(uuid, int) to service_role;
grant execute on function public.massage_slot_leave(uuid, uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- 邀請下一位候補（取代原本的 massage_offer_next）
-- ---------------------------------------------------------------------------

/**
 * 把空出來的時段邀請給下一位候補；沒有候補可以邀請 → 記 slot_open（Slack 發空位通知）。
 * 回傳被邀請的 signup id，沒有就回 null。
 *
 * 不處理的情況（直接回 null、不記紀錄）：時段已結束、已經有人、已經有人手上有這個時段
 * 的邀請、還在釋出等待期（開放時間到了由 massage_open_releases 統一處理）。
 *
 * p_batch = true：開放時間到了的那一批（Slack 給負責人的是一則總整理，不一則一則發）。
 */
create or replace function public.massage_offer_slot(p_session_id uuid, p_slot_no int, p_batch boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_user uuid;
  v_window int;
begin
  if p_slot_no is null or not exists (select 1 from public.massage_sessions where id = p_session_id) then
    return null;
  end if;
  if now() >= public.massage_slot_end(p_session_id, p_slot_no) then
    return null;
  end if;
  if exists (
    select 1 from public.massage_signups
     where session_id = p_session_id and released_at is null
       and (slot_no = p_slot_no or (offer_status = 'pending' and offer_slot_no = p_slot_no))
  ) then
    return null;
  end if;
  if public.massage_release_held(p_session_id) then
    return null;
  end if;

  select id, user_id into v_id, v_user
    from public.massage_signups
   where session_id = p_session_id
     and result = 'waitlist'
     and released_at is null
     and slot_no is null
     and offer_status is distinct from 'pending'
     and not (offer_status is not distinct from 'expired'
              and offer_slot_no is not distinct from p_slot_no)
     and p_slot_no = any(public.massage_ok_slots(p_session_id, user_id))
   order by draw_rank
   limit 1
   for update skip locked;

  if v_id is null then
    perform public.massage_log(p_session_id, null, null, null, 'slot_open', p_slot_no,
      jsonb_build_object('batch', p_batch));
    return null;
  end if;

  v_window := public.massage_offer_window(p_session_id, p_slot_no);
  update public.massage_signups
     set offer_slot_no = p_slot_no,
         offered_at = now(),
         offer_expires_at = now() + make_interval(mins => v_window),
         offer_status = 'pending'
   where id = v_id;

  perform public.massage_log(p_session_id, v_id, v_user, null, 'offered', p_slot_no,
    jsonb_build_object('window_minutes', v_window, 'batch', p_batch));

  return v_id;
end;
$$;

-- 舊的呼叫點（過期、現場沒到、指定遞補……）都還在呼叫 massage_offer_next，
-- 保留同樣的參數，第三個參數不再使用（時限一律照級距）
create or replace function public.massage_offer_next(p_session_id uuid, p_slot_no int, p_window_minutes int)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.massage_offer_slot(p_session_id, p_slot_no, false);
$$;

revoke all on function public.massage_offer_slot(uuid, int, boolean) from public, anon, authenticated;
grant execute on function public.massage_offer_slot(uuid, int, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 釋出（取代原本的 massage_release_row）
-- ---------------------------------------------------------------------------

create or replace function public.massage_release_row(p_signup_id uuid, p_count_late boolean, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  s public.massage_sessions;
  v_late boolean;
  v_free_slot int;
  v_offered uuid;
  v_held boolean;
begin
  select * into g from public.massage_signups where id = p_signup_id;
  select * into s from public.massage_sessions where id = g.session_id for update;

  if s.drawn_at is null then
    update public.massage_signups set released_at = now() where id = g.id;
    perform public.massage_log(s.id, g.id, g.user_id, p_actor, 'withdrew');
    return jsonb_build_object('ok', true, 'phase', 'before_draw');
  end if;

  if g.slot_no is not null and now() >= public.massage_slot_end(s.id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;

  -- 超過取消期限：只記下來，不再記為未到（使用者決定）
  v_late := p_count_late and g.slot_no is not null and now() >= s.cancel_deadline;
  v_free_slot := coalesce(g.slot_no, case when g.offer_status = 'pending' then g.offer_slot_no end);
  v_held := g.slot_no is not null and public.massage_release_held(s.id);

  update public.massage_signups
     set released_at = now(),
         released_late = v_late,
         offer_status = case when offer_status = 'pending' then 'declined' else offer_status end
   where id = g.id;

  perform public.massage_log(s.id, g.id, g.user_id, p_actor, 'released', g.slot_no,
    jsonb_build_object('reason', p_reason, 'late', v_late, 'freed_slot', v_free_slot,
                       'declined_offer_slot', case when g.offer_status = 'pending' then g.offer_slot_no end,
                       'held', v_held,
                       'opens_at', case when v_held then s.release_open_at end));

  -- 等待期：先不處理，開放時間到了統一處理；之後的釋出當下就邀請候補或發空位通知
  if v_free_slot is not null and not v_held then
    v_offered := public.massage_offer_slot(s.id, v_free_slot, false);
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', 'after_draw',
    'late', v_late,
    'held', v_held,
    'opens_at', case when v_held then s.release_open_at end,
    'freed_slot', v_free_slot,
    'offered_signup_id', v_offered
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 取消釋出
-- ---------------------------------------------------------------------------

/**
 * 等待期間取消釋出：回到原本的時段，像沒釋出過一樣（讓給候補的，「要不要讓」也回到還沒回答）。
 * 回傳 code：not_found / not_released / cancel_release_closed（等待期已過）/ slot_taken（已經排了別人）
 */
create or replace function public.massage_cancel_release_as(p_signup_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  s public.massage_sessions;
begin
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or p_user_id is null or g.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into s from public.massage_sessions where id = g.session_id for update;
  if g.released_at is null or g.slot_no is null or s.drawn_at is null or g.released_at < s.drawn_at then
    return jsonb_build_object('ok', false, 'code', 'not_released');
  end if;
  if not public.massage_release_held(s.id) then
    return jsonb_build_object('ok', false, 'code', 'cancel_release_closed', 'opens_at', s.release_open_at);
  end if;
  if exists (
    select 1 from public.massage_signups
     where session_id = s.id and slot_no = g.slot_no and released_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;

  update public.massage_signups
     set released_at = null,
         released_late = false,
         yield_answer = case when yield_answer = 'yielded' then null else yield_answer end,
         yield_answered_at = case when yield_answer = 'yielded' then null else yield_answered_at end
   where id = g.id;

  perform public.massage_log(s.id, g.id, g.user_id, p_user_id, 'release_cancelled', g.slot_no,
    jsonb_build_object('released_at', g.released_at));

  return jsonb_build_object('ok', true, 'slot_no', g.slot_no);

exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'slot_taken');
end;
$$;

create or replace function public.massage_cancel_release(p_signup_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_cancel_release_as(p_signup_id, auth.uid());
$$;

revoke all on function public.massage_cancel_release_as(uuid, uuid) from public, anon, authenticated;
revoke all on function public.massage_cancel_release(uuid) from public, anon;
grant execute on function public.massage_cancel_release_as(uuid, uuid) to service_role;
grant execute on function public.massage_cancel_release(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 開放時間到了：一次處理
-- ---------------------------------------------------------------------------

/**
 * 排程每分鐘呼叫。開放時間已到、還沒處理的期數：每個空著的時段
 * （等待期間釋出的、抽籤後本來就空著的）→ 邀請候補，沒有候補 → slot_open。
 * 最後記一筆 releases_opened（Slack 給負責人一則總整理、頻道發時段異動）。
 * 回傳這次處理了幾期。
 */
create or replace function public.massage_open_releases()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  n int;
  v_count int := 0;
  v_slots jsonb;
  v_offered uuid;
  v_released uuid;
begin
  perform set_config('massage.in_open', 'on', true);
  for s in
    select * from public.massage_sessions
     where drawn_at is not null and release_opened_at is null and release_open_at <= now()
     for update skip locked
  loop
    update public.massage_sessions set release_opened_at = now() where id = s.id;
    v_slots := '[]'::jsonb;

    for n in 1 .. s.slot_count loop
      continue when now() >= public.massage_slot_end(s.id, n);
      continue when exists (
        select 1 from public.massage_signups
         where session_id = s.id and released_at is null
           and (slot_no = n or (offer_status = 'pending' and offer_slot_no = n)));

      -- 這個時段是誰在等待期間釋出的（抽籤後本來就空著的 → null）
      select user_id into v_released
        from public.massage_signups
       where session_id = s.id and slot_no = n and released_at is not null and released_at >= s.drawn_at
       order by released_at desc limit 1;

      v_offered := public.massage_offer_slot(s.id, n, true);
      v_slots := v_slots || jsonb_build_object(
        'slot', n,
        'released_user_id', v_released,
        'offered_user_id', (select user_id from public.massage_signups where id = v_offered));
      v_released := null;
    end loop;

    if jsonb_array_length(v_slots) > 0 then
      perform public.massage_log(s.id, null, null, null, 'releases_opened', null,
        jsonb_build_object('slots', v_slots));
    end if;
    v_count := v_count + 1;
  end loop;
  perform set_config('massage.in_open', 'off', true);
  return v_count;
end;
$$;

revoke all on function public.massage_open_releases() from public, anon, authenticated;
grant execute on function public.massage_open_releases() to service_role;

-- ---------------------------------------------------------------------------
-- 空位先搶先贏
-- ---------------------------------------------------------------------------

/**
 * 回傳 code：
 *   user_inactive / session_not_found / not_drawn / invalid_slot
 *   slot_over        時段已經結束
 *   not_open         還沒開放（等待期間，或開放時間剛到、系統還沒處理）
 *   already_has_slot 這期已經有時段（附 slot_no）
 *   slot_taken       已經有人，或已經邀請了候補
 *   leave_conflict   這個時段在請假（附 leave）
 */
create or replace function public.massage_grab_slot_as(p_session_id uuid, p_slot_no int, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  g public.massage_signups;
  v_found boolean;
  v_leave jsonb;
  v_signup_id uuid;
  v_declined_slot int;
begin
  if p_user_id is null or not exists (select 1 from public.users where id = p_user_id and coalesce(is_active, true)) then
    return jsonb_build_object('ok', false, 'code', 'user_inactive');
  end if;
  -- 鎖住這一期：同時有好幾個人搶，一個一個來
  select * into s from public.massage_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if s.drawn_at is null then
    return jsonb_build_object('ok', false, 'code', 'not_drawn');
  end if;
  if p_slot_no is null or p_slot_no < 1 or p_slot_no > s.slot_count then
    return jsonb_build_object('ok', false, 'code', 'invalid_slot');
  end if;
  if now() >= public.massage_slot_end(s.id, p_slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;
  if s.release_opened_at is null then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'opens_at', s.release_open_at);
  end if;

  select * into g from public.massage_signups where session_id = s.id and user_id = p_user_id for update;
  v_found := found;
  if v_found and g.released_at is null and g.slot_no is not null then
    return jsonb_build_object('ok', false, 'code', 'already_has_slot', 'slot_no', g.slot_no);
  end if;
  if not (p_slot_no = any(public.massage_open_slots(s.id))) then
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;
  v_leave := public.massage_slot_leave(s.id, p_user_id, p_slot_no);
  if v_leave is not null then
    return jsonb_build_object('ok', false, 'code', 'leave_conflict', 'leave', v_leave);
  end if;

  if v_found then
    -- 候補手上有別的時段的邀請：那個邀請放棄，改邀下一位
    v_declined_slot := case when g.released_at is null and g.offer_status = 'pending' then g.offer_slot_no end;
    update public.massage_signups
       set released_at = null,
           released_late = false,
           slot_no = p_slot_no,
           result = 'selected',
           slot_conflict = false,
           offer_status = case when offer_status = 'pending' then 'declined' else offer_status end,
           attendance = null,
           attendance_marked_by = null,
           attendance_marked_at = null,
           grabbed_at = now()
     where id = g.id;
    v_signup_id := g.id;
  else
    insert into public.massage_signups (session_id, user_id, result, slot_no, grabbed_at)
    values (s.id, p_user_id, 'selected', p_slot_no, now())
    returning id into v_signup_id;
  end if;

  perform public.massage_log(s.id, v_signup_id, p_user_id, p_user_id, 'grabbed', p_slot_no,
    jsonb_build_object(
      'reactivated', v_found and g.released_at is not null,
      'was_waitlist', v_found and g.released_at is null,
      'previous_released_at', case when v_found then g.released_at end,
      'declined_offer_slot', v_declined_slot));

  if v_declined_slot is not null then
    perform public.massage_offer_slot(s.id, v_declined_slot, false);
  end if;

  return jsonb_build_object('ok', true, 'signup_id', v_signup_id, 'slot_no', p_slot_no);

exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'slot_taken');
end;
$$;

create or replace function public.massage_grab_slot(p_session_id uuid, p_slot_no int)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_grab_slot_as(p_session_id, p_slot_no, auth.uid());
$$;

revoke all on function public.massage_grab_slot_as(uuid, int, uuid) from public, anon, authenticated;
revoke all on function public.massage_grab_slot(uuid, int) from public, anon;
grant execute on function public.massage_grab_slot_as(uuid, int, uuid) to service_role;
grant execute on function public.massage_grab_slot(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Slack：發出去的空位通知、取消釋出的私訊（之後要改寫成「名額已滿」等）
-- ---------------------------------------------------------------------------

-- 只有 service_role（Edge Function massage-notify）讀寫
create table if not exists public.massage_slack_notices (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('open_slots', 'cancel_release')),
  session_id uuid not null references public.massage_sessions(id) on delete cascade,
  signup_id  uuid references public.massage_signups(id) on delete cascade,  -- cancel_release 用
  user_id    uuid references public.users(id),                              -- null = 頻道
  channel    text not null,
  ts         text not null,
  lang       text not null default 'zh',
  slots      int[] not null default '{}',     -- open_slots：這則列了哪些時段
  content    text not null,                   -- 最後一次寫進去的內容；不同才改寫
  created_at timestamptz not null default now(),
  closed_at  timestamptz                      -- 不再追蹤
);

create index if not exists massage_slack_notices_open on public.massage_slack_notices (kind, session_id) where closed_at is null;

alter table public.massage_slack_notices enable row level security;
revoke all on public.massage_slack_notices from anon, authenticated;
grant all on public.massage_slack_notices to service_role;

/**
 * 空位通知要發給誰：在職、有 Slack ID、這期還沒有時段的人，
 * 以及每個人「可以搶」的時段（扣掉請假的）。只列得到至少一個時段的人。
 */
create or replace function public.massage_open_slot_recipients(p_session_id uuid, p_slots int[])
returns table (user_id uuid, full_name text, slack_user_id text, language text, slots int[])
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.full_name, u.slack_user_id, u.language, x.slots
    from public.users u
    cross join lateral (
      select coalesce(array_agg(n order by n), '{}') as slots
        from unnest(p_slots) n
       where n = any(public.massage_ok_slots(p_session_id, u.id))
    ) x
   where coalesce(u.is_active, true)
     and nullif(trim(u.slack_user_id), '') is not null
     and not exists (
       select 1 from public.massage_signups g
        where g.session_id = p_session_id and g.user_id = u.id
          and g.released_at is null and g.slot_no is not null)
     and cardinality(x.slots) > 0;
$$;

revoke all on function public.massage_open_slot_recipients(uuid, int[]) from public, anon, authenticated;
grant execute on function public.massage_open_slot_recipients(uuid, int[]) to service_role;
