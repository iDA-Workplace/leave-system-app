-- 按摩預約（員工福利模組的第一個功能）
--
-- 規則來源：原本的「盲人按摩報名」試算表「報名規則」分頁，加上 2026-10 與
-- 使用者逐條確認過的公平性調整。下面每一條規則都標了實作的位置。
--
--   報名                                                       massage_sign_up_as
--     · 一期限報一次，用登入帳號報名，不能替別人報
--     · 報名截止前才能報
--     · 按摩當天整天請假，或請假時間跟按摩時段有重疊 → 直接擋住
--       （審核中的假單也擋、WFH 也算，見 massage_leave_conflict）
--
--   抽籤（只有管理員 / HR 能按，抽一次就鎖定，不能重抽）     massage_run_draw
--     · 報名人數 ≤ 名額：不抽籤，照報名先後排時段
--     · 報名人數 > 名額：分兩組 ——「上期沒按過」整組排在「上期按過」前面，
--       組內隨機。名次 1..名額 為正取、照名次排時段（第 1 名 = 第 1 個時段），
--       其餘依名次為候補
--     · 「上期按過」＝上一期「實際有按到」的人（出席標記為 attended）
--
--   取消與遞補                       massage_release_as / massage_offer_next
--     · 取消期限（預設按摩當天 12:00）前取消 → 正常遞補
--     · 期限後才取消 → 一樣遞補，但這個人記為「未到」
--     · 空出的時段依候補順序邀請，限時內按「我要」才算數
--
--   時段交換                                              massage_move_slot
--     · 同仁私下講好之後告訴管理者，由管理者在系統裡改
--
--   出席                     massage_mark_done_as / massage_set_attendance
--     · 本人可以按「已完成」，管理員 / HR 也可以標記
--
--
-- 寫入一律走函式，不開放直接寫資料表
--
-- 報名名單與抽籤結果全公司都看得到（使用者確認），所以 SELECT 全開；但任何
-- 寫入都必須經過下面的函式。理由跟 mark_review_result_viewed 一樣：RLS 是
-- 「整列」的權限，一旦放行「同仁可以更新自己的報名」，他就能自己把 slot_no
-- 改成 1 號、把 result 改成 selected。規則只能寫在函式裡才守得住。
--
-- 每個「同仁自己做的動作」都有兩支：
--   xxx_as(…, p_user_id)  只給 service_role（Slack 機器人用，它沒有登入身分）
--   xxx(…)                給網頁用，內部固定帶 auth.uid()，不能冒用別人
--
-- 冪等，重複執行安全。


-- ---------------------------------------------------------------------------
-- 權限判斷：管理員或 HR
-- ---------------------------------------------------------------------------
create or replace function public.is_massage_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and coalesce(u.is_active, true)
      and (u.is_admin or u.is_finance)
  );
$$;

comment on function public.is_massage_manager() is
  '按摩預約的管理者 = 管理員或 HR（is_finance）。開新的一期、抽籤、改時段、標記出席都用這個判斷。';

revoke all on function public.is_massage_manager() from public;
grant execute on function public.is_massage_manager() to authenticated;


-- ---------------------------------------------------------------------------
-- 資料表
-- ---------------------------------------------------------------------------
create table if not exists public.massage_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  session_date date not null,
  start_time time not null default '13:00',
  slot_minutes int not null default 15 check (slot_minutes between 5 and 120),
  break_minutes int not null default 5 check (break_minutes between 0 and 60),
  slot_count int not null default 9 check (slot_count between 1 and 50),
  signup_deadline timestamptz not null,
  cancel_deadline timestamptz not null,
  -- 候補被邀請後，要在幾分鐘內按「我要」
  offer_window_minutes int not null default 5 check (offer_window_minutes between 1 and 1440),
  -- 只用來顯示「預計幾點抽籤」，實際抽籤由管理者按按鈕
  draw_scheduled_at timestamptz,
  drawn_at timestamptz,
  drawn_by uuid references public.users(id),
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

comment on table public.massage_sessions is
  '按摩預約的「一期」。時段數、時長、休息時間都存在這裡，未來要調整不用改程式。';
comment on column public.massage_sessions.drawn_at is
  '抽籤（或人數未滿時的直接排定）完成的時間。有值之後這一期就鎖定：不能重抽、不能刪除、時段設定不能再改。';

create table if not exists public.massage_signups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.massage_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id),
  signed_up_at timestamptz not null default now(),

  -- 抽籤時寫入，之後不再變動
  priority_group smallint,                 -- 1 = 上期沒按過，2 = 上期按過
  draw_rank int,                           -- 1..n 的最終名次
  result text check (result in ('selected', 'waitlist')),

  -- 目前占用的時段（正取一開始就有；候補遞補成功後才有）
  slot_no int,

  -- 取消（抽籤前 = 取消報名；抽籤後 = 釋出名額）
  released_at timestamptz,
  released_late boolean not null default false,

  -- 遞補邀請（只有候補會用到）
  offer_slot_no int,
  offered_at timestamptz,
  offer_expires_at timestamptz,
  offer_status text check (offer_status in ('pending', 'accepted', 'expired', 'declined')),
  promoted_at timestamptz,

  -- 出席
  attendance text check (attendance in ('attended', 'no_show')),
  attendance_marked_by uuid references public.users(id),
  attendance_marked_at timestamptz,

  unique (session_id, user_id)
);

comment on column public.massage_signups.released_late is
  '超過取消期限才釋出名額。名額一樣會遞補出去，但這個人會被記為未到（attendance = no_show）。';
comment on column public.massage_signups.attendance is
  'attended = 實際有按到（本人按「已完成」或管理者標記）。下一期抽籤判斷「上期按過」只看這個值。';

-- 同一期同一個時段，同時間只能有一個人（已釋出的不算）
create unique index if not exists massage_signups_active_slot
  on public.massage_signups (session_id, slot_no)
  where slot_no is not null and released_at is null;

create index if not exists massage_signups_user on public.massage_signups (user_id);


-- ---------------------------------------------------------------------------
-- 時間計算
-- ---------------------------------------------------------------------------

-- 第 n 個時段的開始時間（Asia/Taipei → timestamptz）
create or replace function public.massage_slot_start(p_session_id uuid, p_slot_no int)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select ((s.session_date + s.start_time
           + make_interval(mins => (p_slot_no - 1) * (s.slot_minutes + s.break_minutes)))
          at time zone 'Asia/Taipei')
    from public.massage_sessions s where s.id = p_session_id;
$$;

create or replace function public.massage_slot_end(p_session_id uuid, p_slot_no int)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select public.massage_slot_start(p_session_id, p_slot_no) + make_interval(mins => s.slot_minutes)
    from public.massage_sessions s where s.id = p_session_id;
$$;

/**
 * 一張假單會不會跟這一期的按摩時段撞到。
 *
 * 按摩時段 = 開始時間 到 開始時間 + 名額 × (每人分鐘 + 休息分鐘)。
 * 預設 13:00 + 9 × 20 分 = 16:00，跟試算表寫的「13:00–16:00」一致。
 *
 * 跨天的假單一律當成整天（請假單本身也是這樣算時數的：跨天時忽略時間、
 * 整天計算）。單日的假單才比對時間，只要有任何重疊就算撞到。
 * 時間是空值的舊資料也當成整天，寧可多擋，不要漏擋。
 */
create or replace function public.massage_leave_overlaps(
  p_session_id uuid,
  p_start_date date, p_end_date date,
  p_start_time time, p_end_time time
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.session_date between p_start_date and p_end_date
       and (
         p_start_date <> p_end_date
         or (
           coalesce(p_start_time, '00:00') <
             s.start_time + make_interval(mins => s.slot_count * (s.slot_minutes + s.break_minutes))
           and coalesce(p_end_time, '23:59') > s.start_time
         )
       )
      from public.massage_sessions s where s.id = p_session_id
  ), false);
$$;

/**
 * 回傳第一張跟這一期撞到的假單（給「不能報名」的訊息用），沒有就回 null。
 *
 * 審核中（pending）跟已核准（approved）都算 —— 使用者確認審核中也要擋。
 * WFH 在系統裡就是一種假別，所以自然會被算進來，不需要特別處理。
 */
create or replace function public.massage_leave_conflict(p_session_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'leave_id', lr.id,
           'start_date', lr.start_date,
           'end_date', lr.end_date,
           'start_time', to_char(lr.start_time::time, 'HH24:MI'),
           'end_time', to_char(lr.end_time::time, 'HH24:MI'),
           'status', lr.status,
           'leave_type', lt.name,
           'leave_type_en', lt.name_en
         )
    from public.leave_requests lr
    left join public.leave_types lt on lt.id = lr.leave_type_id
   where lr.requester_id = p_user_id
     and lr.status in ('pending', 'approved')
     and public.massage_leave_overlaps(
           p_session_id, lr.start_date::date, lr.end_date::date,
           lr.start_time::time, lr.end_time::time)
   order by lr.start_date
   limit 1;
$$;

-- 網頁用：報名按鈕旁邊先顯示「為什麼不能預約」，不用等按下去才知道
create or replace function public.massage_my_leave_conflict(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.massage_leave_conflict(p_session_id, auth.uid());
$$;

revoke all on function public.massage_my_leave_conflict(uuid) from public;
grant execute on function public.massage_my_leave_conflict(uuid) to authenticated;

revoke all on function public.massage_slot_start(uuid, int) from public;
revoke all on function public.massage_slot_end(uuid, int) from public;
revoke all on function public.massage_leave_overlaps(uuid, date, date, time, time) from public;
revoke all on function public.massage_leave_conflict(uuid, uuid) from public;
grant execute on function public.massage_slot_start(uuid, int) to authenticated, service_role;
grant execute on function public.massage_slot_end(uuid, int) to authenticated, service_role;
grant execute on function public.massage_leave_overlaps(uuid, date, date, time, time) to service_role;
grant execute on function public.massage_leave_conflict(uuid, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 報名
-- ---------------------------------------------------------------------------

/**
 * 回傳 jsonb：{ ok: true, signup_id } 或 { ok: false, code, ... }。
 * 刻意回傳代碼而不是丟中文錯誤訊息：網頁與 Slack 都要依使用者的語言顯示，
 * 文字交給前端翻譯。
 */
create or replace function public.massage_sign_up_as(p_session_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  v_conflict jsonb;
  v_row public.massage_signups;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_signed_in');
  end if;

  select * into s from public.massage_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if s.drawn_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_drawn');
  end if;
  if now() >= s.signup_deadline then
    return jsonb_build_object('ok', false, 'code', 'signup_closed');
  end if;
  if not exists (
    select 1 from public.users where id = p_user_id and coalesce(is_active, true)
  ) then
    return jsonb_build_object('ok', false, 'code', 'user_inactive');
  end if;

  v_conflict := public.massage_leave_conflict(p_session_id, p_user_id);
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'code', 'leave_conflict', 'leave', v_conflict);
  end if;

  select * into v_row from public.massage_signups
   where session_id = p_session_id and user_id = p_user_id
   for update;

  if found then
    if v_row.released_at is null then
      return jsonb_build_object('ok', false, 'code', 'already_signed_up', 'signup_id', v_row.id);
    end if;
    -- 抽籤前取消過、又回來報名：排到最後面（報名先後以最後一次為準）
    update public.massage_signups
       set released_at = null, released_late = false, signed_up_at = now()
     where id = v_row.id;
    return jsonb_build_object('ok', true, 'signup_id', v_row.id);
  end if;

  insert into public.massage_signups (session_id, user_id)
  values (p_session_id, p_user_id)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'signup_id', v_row.id);

exception when unique_violation then
  -- 同一個人同時按了兩次（網頁 + Slack）
  return jsonb_build_object('ok', false, 'code', 'already_signed_up');
end;
$$;

create or replace function public.massage_sign_up(p_session_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_sign_up_as(p_session_id, auth.uid());
$$;

revoke all on function public.massage_sign_up_as(uuid, uuid) from public;
revoke all on function public.massage_sign_up(uuid) from public;
grant execute on function public.massage_sign_up_as(uuid, uuid) to service_role;
grant execute on function public.massage_sign_up(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 抽籤
-- ---------------------------------------------------------------------------
create or replace function public.massage_run_draw(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  v_prev uuid;
  v_unmarked int;
  v_total int;
  v_selected int;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  -- FOR UPDATE：兩個人同時按「抽籤」時，第二個人會等第一個抽完，
  -- 接著讀到 drawn_at 已經有值 → already_drawn。不會抽兩次。
  select * into s from public.massage_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if s.drawn_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_drawn');
  end if;
  if now() < s.signup_deadline then
    return jsonb_build_object('ok', false, 'code', 'signup_not_closed');
  end if;

  -- 上一期 = 日期在這一期之前、最近一個已經抽過籤的
  select id into v_prev
    from public.massage_sessions
   where session_date < s.session_date and drawn_at is not null
   order by session_date desc, drawn_at desc
   limit 1;

  -- 上一期還有人沒標記出席，就無法判斷誰「上期按過」—— 先擋住，請管理者
  -- 補標。不自行假設有按到或沒按到，因為兩種假設都會讓某些人吃虧。
  if v_prev is not null then
    select count(*) into v_unmarked
      from public.massage_signups
     where session_id = v_prev and slot_no is not null
       and released_at is null and attendance is null;
    if v_unmarked > 0 then
      return jsonb_build_object('ok', false, 'code', 'previous_unmarked',
                                'previous_session_id', v_prev, 'count', v_unmarked);
    end if;
  end if;

  select count(*) into v_total
    from public.massage_signups
   where session_id = p_session_id and released_at is null;

  update public.massage_signups g
     set priority_group = r.grp,
         draw_rank = r.rn,
         result = case when r.rn <= s.slot_count then 'selected' else 'waitlist' end,
         slot_no = case when r.rn <= s.slot_count then r.rn::int else null end
    from (
      select a.id, a.grp,
             row_number() over (
               order by
                 -- 人數未滿：不分組、不抽籤，照報名先後
                 case when v_total <= s.slot_count then 0 else a.grp end,
                 case when v_total <= s.slot_count then a.signed_up_at end,
                 -- 人數超過：組內照亂數排（每人一個亂數，先算好再排序）
                 a.rnd,
                 a.id
             ) as rn
        from (
          select g2.id, g2.signed_up_at, random() as rnd,
                 case when v_prev is not null and exists (
                        select 1 from public.massage_signups p
                         where p.session_id = v_prev
                           and p.user_id = g2.user_id
                           and p.attendance = 'attended')
                      then 2 else 1 end as grp
            from public.massage_signups g2
           where g2.session_id = p_session_id and g2.released_at is null
        ) a
    ) r
   where g.id = r.id;

  perform set_config('massage.in_draw', 'on', true);
  update public.massage_sessions
     set drawn_at = now(), drawn_by = auth.uid()
   where id = p_session_id;
  perform set_config('massage.in_draw', 'off', true);

  select count(*) into v_selected
    from public.massage_signups
   where session_id = p_session_id and result = 'selected';

  return jsonb_build_object(
    'ok', true,
    'total', v_total,
    'selected', v_selected,
    'waitlist', v_total - v_selected,
    'was_lottery', v_total > s.slot_count
  );
end;
$$;

revoke all on function public.massage_run_draw(uuid) from public;
grant execute on function public.massage_run_draw(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 遞補
-- ---------------------------------------------------------------------------

/**
 * 把空出來的時段邀請給下一位候補。回傳被邀請的 signup id，沒有人可以邀請就回 null。
 *
 * 候補順序 = 抽籤名次。跳過的人：已經有時段的、已經取消的、手上已經有一個
 * 還沒回覆的邀請的、以及「這個時段剛剛已經問過他、他沒回」的。
 */
create or replace function public.massage_offer_next(p_session_id uuid, p_slot_no int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  v_id uuid;
begin
  select * into s from public.massage_sessions where id = p_session_id;
  if not found or p_slot_no is null then
    return null;
  end if;
  -- 時段已經結束，就沒有遞補的意義了
  if now() >= public.massage_slot_end(p_session_id, p_slot_no) then
    return null;
  end if;
  -- 這個時段已經有人了（例如管理者手動排了人）
  if exists (
    select 1 from public.massage_signups
     where session_id = p_session_id and slot_no = p_slot_no and released_at is null
  ) then
    return null;
  end if;

  select id into v_id
    from public.massage_signups
   where session_id = p_session_id
     and result = 'waitlist'
     and released_at is null
     and slot_no is null
     and offer_status is distinct from 'pending'
     -- 用 is not distinct from 而不是 =：從沒被邀請過的人兩欄都是 NULL，
     -- 用 = 的話整個條件會變成 NULL，結果是「所有候補都被排除」
     and not (offer_status is not distinct from 'expired'
              and offer_slot_no is not distinct from p_slot_no)
   order by draw_rank
   limit 1
   for update skip locked;

  if v_id is null then
    return null;
  end if;

  update public.massage_signups
     set offer_slot_no = p_slot_no,
         offered_at = now(),
         offer_expires_at = now() + make_interval(mins => s.offer_window_minutes),
         offer_status = 'pending'
   where id = v_id;

  return v_id;
end;
$$;

/**
 * 把已經過期的邀請標成 expired，並把那個時段改邀下一位。
 * 給排程（每分鐘）呼叫，回傳這次處理了幾筆。
 */
create or replace function public.massage_expire_offers()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, session_id, offer_slot_no
      from public.massage_signups
     where offer_status = 'pending' and offer_expires_at <= now()
     for update skip locked
  loop
    update public.massage_signups set offer_status = 'expired' where id = r.id;
    perform public.massage_offer_next(r.session_id, r.offer_slot_no);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.massage_offer_next(uuid, int) from public;
revoke all on function public.massage_expire_offers() from public;
grant execute on function public.massage_offer_next(uuid, int) to service_role;
grant execute on function public.massage_expire_offers() to service_role;


-- ---------------------------------------------------------------------------
-- 取消 / 釋出名額
-- ---------------------------------------------------------------------------
create or replace function public.massage_release_as(p_signup_id uuid, p_user_id uuid)
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
begin
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or p_user_id is null or g.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if g.released_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_released');
  end if;

  select * into s from public.massage_sessions where id = g.session_id for update;

  -- 抽籤前：單純取消報名
  if s.drawn_at is null then
    update public.massage_signups set released_at = now() where id = g.id;
    return jsonb_build_object('ok', true, 'phase', 'before_draw');
  end if;

  -- 自己的時段已經結束了，就不是「取消」而是「沒來」，交給出席標記處理
  if g.slot_no is not null and now() >= public.massage_slot_end(s.id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;

  v_late := now() >= s.cancel_deadline;
  -- 空出來要遞補的時段：自己占用的，或是手上還沒回覆的那個邀請
  v_free_slot := coalesce(g.slot_no, case when g.offer_status = 'pending' then g.offer_slot_no end);

  update public.massage_signups
     set released_at = now(),
         released_late = v_late and g.slot_no is not null,
         offer_status = case when offer_status = 'pending' then 'declined' else offer_status end,
         attendance = case when v_late and g.slot_no is not null then 'no_show' else attendance end,
         attendance_marked_at = case when v_late and g.slot_no is not null then now() else attendance_marked_at end
   where id = g.id;

  if v_free_slot is not null then
    v_offered := public.massage_offer_next(s.id, v_free_slot);
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', 'after_draw',
    'late', v_late and g.slot_no is not null,
    'freed_slot', v_free_slot,
    'offered_signup_id', v_offered
  );
end;
$$;

create or replace function public.massage_release(p_signup_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_release_as(p_signup_id, auth.uid());
$$;

revoke all on function public.massage_release_as(uuid, uuid) from public;
revoke all on function public.massage_release(uuid) from public;
grant execute on function public.massage_release_as(uuid, uuid) to service_role;
grant execute on function public.massage_release(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 候補按「我要」
-- ---------------------------------------------------------------------------
create or replace function public.massage_accept_offer_as(p_signup_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
begin
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or p_user_id is null or g.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if g.released_at is not null or g.offer_status is distinct from 'pending' then
    return jsonb_build_object('ok', false, 'code', 'no_pending_offer');
  end if;

  -- 過期了：照規則讓給下一位
  if now() > g.offer_expires_at then
    update public.massage_signups set offer_status = 'expired' where id = g.id;
    perform public.massage_offer_next(g.session_id, g.offer_slot_no);
    return jsonb_build_object('ok', false, 'code', 'offer_expired');
  end if;

  if exists (
    select 1 from public.massage_signups
     where session_id = g.session_id and slot_no = g.offer_slot_no and released_at is null
  ) then
    update public.massage_signups set offer_status = 'expired' where id = g.id;
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;

  update public.massage_signups
     set slot_no = g.offer_slot_no,
         result = 'selected',
         offer_status = 'accepted',
         promoted_at = now()
   where id = g.id;

  return jsonb_build_object('ok', true, 'slot_no', g.offer_slot_no);
end;
$$;

create or replace function public.massage_accept_offer(p_signup_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_accept_offer_as(p_signup_id, auth.uid());
$$;

revoke all on function public.massage_accept_offer_as(uuid, uuid) from public;
revoke all on function public.massage_accept_offer(uuid) from public;
grant execute on function public.massage_accept_offer_as(uuid, uuid) to service_role;
grant execute on function public.massage_accept_offer(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 管理者：改時段（同仁私下換好之後，由管理者在系統裡改）
-- ---------------------------------------------------------------------------

/**
 * 把某人移到指定時段。目標時段有人 → 兩人對調；沒人 → 直接移過去。
 */
create or replace function public.massage_move_slot(p_signup_id uuid, p_target_slot int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  s public.massage_sessions;
  v_other uuid;
  v_from int;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or g.released_at is not null or g.slot_no is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into s from public.massage_sessions where id = g.session_id;
  if p_target_slot is null or p_target_slot < 1 or p_target_slot > s.slot_count then
    return jsonb_build_object('ok', false, 'code', 'invalid_slot');
  end if;
  if p_target_slot = g.slot_no then
    return jsonb_build_object('ok', true, 'swapped_with', null);
  end if;

  v_from := g.slot_no;
  select id into v_other from public.massage_signups
   where session_id = g.session_id and slot_no = p_target_slot and released_at is null
   for update;

  -- 先把自己的時段清空，才不會撞到「同一時段只能一人」的唯一索引
  update public.massage_signups set slot_no = null where id = g.id;
  if v_other is not null then
    update public.massage_signups set slot_no = v_from where id = v_other;
  end if;
  update public.massage_signups set slot_no = p_target_slot where id = g.id;

  return jsonb_build_object('ok', true, 'swapped_with', v_other);
end;
$$;

revoke all on function public.massage_move_slot(uuid, int) from public;
grant execute on function public.massage_move_slot(uuid, int) to authenticated;


-- ---------------------------------------------------------------------------
-- 出席
-- ---------------------------------------------------------------------------

-- 本人按「已完成」：只能標自己、只能標「有按到」、時段開始之後才能按
create or replace function public.massage_mark_done_as(p_signup_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
begin
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or p_user_id is null or g.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if g.released_at is not null or g.slot_no is null then
    return jsonb_build_object('ok', false, 'code', 'no_slot');
  end if;
  if now() < public.massage_slot_start(g.session_id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'not_started');
  end if;
  if g.attendance is not null then
    return jsonb_build_object('ok', false, 'code', 'already_marked', 'attendance', g.attendance);
  end if;

  update public.massage_signups
     set attendance = 'attended', attendance_marked_by = p_user_id, attendance_marked_at = now()
   where id = g.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.massage_mark_done(p_signup_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_mark_done_as(p_signup_id, auth.uid());
$$;

-- 管理者標記：可以標「有按到」「未到」，或清除（p_status = null）
create or replace function public.massage_set_attendance(p_signup_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;
  if p_status is not null and p_status not in ('attended', 'no_show') then
    return jsonb_build_object('ok', false, 'code', 'invalid_status');
  end if;
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or g.slot_no is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  update public.massage_signups
     set attendance = p_status,
         attendance_marked_by = case when p_status is null then null else auth.uid() end,
         attendance_marked_at = case when p_status is null then null else now() end
   where id = g.id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.massage_mark_done_as(uuid, uuid) from public;
revoke all on function public.massage_mark_done(uuid) from public;
revoke all on function public.massage_set_attendance(uuid, text) from public;
grant execute on function public.massage_mark_done_as(uuid, uuid) to service_role;
grant execute on function public.massage_mark_done(uuid) to authenticated;
grant execute on function public.massage_set_attendance(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 送出假單之後：這張假單撞到哪些按摩報名？
-- ---------------------------------------------------------------------------

/**
 * 給「送出假單後跳提醒＋釋出按鈕」用（網頁、Slack、HR 代登記三個入口共用）。
 * 回傳這張假單的申請人，還沒結束的按摩期數裡、仍然有效、而且時間撞到的報名。
 *
 * 呼叫權限：申請人本人、管理者（HR 代登記時），或 service_role（Slack）。
 * service_role 沒有登入身分，auth.uid() 是 null；anon 沒有被授權呼叫，
 * 所以 auth.uid() 為 null 的呼叫者只可能是 service_role。
 */
create or replace function public.massage_signups_hit_by_leave(p_leave_id uuid)
returns table (
  signup_id uuid,
  session_id uuid,
  title text,
  session_date date,
  result text,
  slot_no int,
  drawn boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, s.id, s.title, s.session_date, g.result, g.slot_no, s.drawn_at is not null
    from public.leave_requests lr
    join public.massage_signups g on g.user_id = lr.requester_id and g.released_at is null
    join public.massage_sessions s on s.id = g.session_id
   where lr.id = p_leave_id
     and (lr.requester_id = auth.uid() or public.is_massage_manager() or auth.uid() is null)
     and s.session_date >= (now() at time zone 'Asia/Taipei')::date
     and public.massage_leave_overlaps(
           s.id, lr.start_date::date, lr.end_date::date,
           lr.start_time::time, lr.end_time::time)
   order by s.session_date;
$$;

revoke all on function public.massage_signups_hit_by_leave(uuid) from public;
grant execute on function public.massage_signups_hit_by_leave(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 抽籤後鎖定：不能重抽、不能刪除、時段設定不能再改
-- ---------------------------------------------------------------------------
create or replace function public.massage_sessions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.drawn_at is not null then
      raise exception 'massage_session_locked: 已經抽過籤的期數不能刪除';
    end if;
    return old;
  end if;

  -- drawn_at / drawn_by 只能由 massage_run_draw 寫入
  if (new.drawn_at is distinct from old.drawn_at or new.drawn_by is distinct from old.drawn_by)
     and coalesce(current_setting('massage.in_draw', true), 'off') <> 'on' then
    raise exception 'massage_session_locked: 抽籤狀態只能透過抽籤功能改變';
  end if;

  if old.drawn_at is not null and (
       new.session_date is distinct from old.session_date
    or new.start_time is distinct from old.start_time
    or new.slot_minutes is distinct from old.slot_minutes
    or new.break_minutes is distinct from old.break_minutes
    or new.slot_count is distinct from old.slot_count
    or new.signup_deadline is distinct from old.signup_deadline
  ) then
    raise exception 'massage_session_locked: 已經抽過籤，日期與時段設定不能再改';
  end if;

  return new;
end;
$$;

drop trigger if exists massage_sessions_guard on public.massage_sessions;
create trigger massage_sessions_guard
  before update or delete on public.massage_sessions
  for each row execute function public.massage_sessions_guard();

-- 新增時也不能直接帶 drawn_at 進來（不然就是「建一期、直接當作抽過了」）
create or replace function public.massage_sessions_insert_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.drawn_at := null;
  new.drawn_by := null;
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists massage_sessions_insert_guard on public.massage_sessions;
create trigger massage_sessions_insert_guard
  before insert on public.massage_sessions
  for each row execute function public.massage_sessions_insert_guard();


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.massage_sessions enable row level security;
alter table public.massage_signups enable row level security;

do $$
begin
  -- 全公司都看得到每一期、報名名單、抽籤結果（使用者確認）
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_sessions' and policyname = 'massage_sessions_read_all') then
    create policy massage_sessions_read_all on public.massage_sessions
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_signups' and policyname = 'massage_signups_read_all') then
    create policy massage_signups_read_all on public.massage_signups
      for select to authenticated using (true);
  end if;

  -- 開新的一期、改設定、刪除（未抽籤的）：管理員或 HR
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_sessions' and policyname = 'massage_sessions_manager_insert') then
    create policy massage_sessions_manager_insert on public.massage_sessions
      for insert to authenticated with check (public.is_massage_manager());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_sessions' and policyname = 'massage_sessions_manager_update') then
    create policy massage_sessions_manager_update on public.massage_sessions
      for update to authenticated
      using (public.is_massage_manager()) with check (public.is_massage_manager());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_sessions' and policyname = 'massage_sessions_manager_delete') then
    create policy massage_sessions_manager_delete on public.massage_sessions
      for delete to authenticated using (public.is_massage_manager());
  end if;

  -- massage_signups 刻意沒有任何 insert / update / delete 政策：只能透過上面的函式寫入
end $$;

grant select on public.massage_sessions to authenticated;
grant insert, update, delete on public.massage_sessions to authenticated;
grant select on public.massage_signups to authenticated;
grant all on public.massage_sessions to service_role;
grant all on public.massage_signups to service_role;
