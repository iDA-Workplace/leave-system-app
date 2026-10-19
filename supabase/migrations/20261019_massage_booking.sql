-- 按摩預約（員工福利模組的第一個功能）
--
-- 規則來源：原本的「盲人按摩報名」試算表「報名規則」分頁，加上 2026-10 與
-- 使用者逐條確認過的調整。下面每一條規則都標了實作的位置。
--
--   報名                                                       massage_sign_up_as
--     · 一期限報一次，用登入帳號報名，不能替別人報
--     · 報名截止前才能報
--     · 請假（含審核中、含 WFH）讓「每一個時段都不能按」→ 直接擋住
--     · 只有部分時段請假（例如 15:00–16:00）→ 可以報，排時段時自動避開
--
--   抽籤（只有管理員 / HR 能按，抽一次就鎖定，不能重抽）     massage_run_draw
--     · 報名人數 ≤ 名額：不抽籤，照報名先後
--     · 報名人數 > 名額：全部一起隨機抽，名次 1..名額 為正取，其餘依名次為候補
--     · 上一期實際有按到、這期又抽中的人，系統會問他要不要把名額讓給候補，
--       由本人決定（不強制）                                    massage_answer_yield_as
--
--   排時段                                                  massage_assign_slots
--     · 照名次排，第 1 名 = 第 1 個時段
--     · 有部分請假的人，排在「離他原本順位最近、又不撞到請假」的時段，
--       其他人依名次往前或往後挪
--     · 真的排不開時照樣給一個時段，但標示「與請假衝突」，請他自己找人換
--
--   取消與遞補                       massage_release_as / massage_offer_next
--     · 取消期限（預設按摩當天 12:00）前取消 → 正常遞補
--     · 期限後才取消 → 一樣遞補，但這個人記為「未到」
--     · 本人取消（按摩開始前）空出的名額：依候補順序邀請，不設時限，
--       以候補第一位的回覆為優先
--     · 候補在空出的那個時段有請假 → 跳過他，問下一位（下一個空出的時段會再問他）
--
--   現場沒到                                              massage_mark_no_show
--     · 由管理者在現場按「沒到」→ 系統通知候補第一位，也通知負責人
--
--   管理者直接指定遞補                                  massage_assign_waitlist
--     · 管理者可以直接指定任何一位候補補上空出的時段，蓋過系統發出的邀請
--     · 系統顯示候補順序，但不強制照順序（使用者要求候補功能保留彈性：
--       現場第一位可能剛好不在座位上）
--
--   負責人                                                   massage_settings
--     · 全公司一位「按摩預約負責人」，所有給管理者的通知只發給他
--     · 操作權限仍是管理員與 HR 都可以
--
--   異動紀錄                                                   massage_events
--     · 上面每一個動作都記一筆（誰、什麼時候、做了什麼），只能新增、不能修改
--     · 只有管理員與 HR 看得到（使用者確認）
--     · 報名資料表上的欄位只存「現在的狀態」，會被後來的動作覆蓋（例如取消後
--       重新報名、換時段、遞補邀請重發）；完整經過只能從這裡查
--
--   時段交換                                              massage_move_slot
--     · 同仁私下講好之後告訴管理者，由管理者在系統裡改
--
--   出席                     massage_mark_done_as / massage_set_attendance
--     · 本人可以按「已完成」，管理員 / HR 也可以標記
--     · 「上期按過」只看實際有按到（attended）
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
  -- 現場有人沒到、改邀候補時，候補要在幾分鐘內回覆。null = 不設時限。
  -- （使用者尚未決定；本人提早取消的遞補一律不設時限，不看這個欄位）
  onsite_offer_window_minutes int check (onsite_offer_window_minutes between 1 and 60),
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
  draw_rank int,                           -- 1..n 的最終名次
  result text check (result in ('selected', 'waitlist')),
  went_last_time boolean,                  -- 抽籤當下：上一期是否實際有按到

  -- 「要不要讓給候補」：上期按過、這期又抽中、而且有人在候補時才會問
  yield_asked boolean not null default false,
  yield_answer text check (yield_answer in ('yielded', 'kept')),
  yield_answered_at timestamptz,

  -- 目前占用的時段（正取一開始就有；候補遞補成功後才有）
  slot_no int,
  slot_conflict boolean not null default false,  -- 排不開，時段跟請假撞到

  -- 取消（抽籤前 = 取消報名；抽籤後 = 釋出名額）
  released_at timestamptz,
  released_late boolean not null default false,

  -- 遞補邀請（只有候補會用到）
  offer_slot_no int,
  offered_at timestamptz,
  offer_expires_at timestamptz,            -- null = 不設時限
  -- superseded = 管理者直接指定了別人（或指定他去別的時段），這個邀請作廢
  offer_status text check (offer_status in ('pending', 'accepted', 'expired', 'declined', 'superseded')),
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
  'attended = 實際有按到（本人按「已完成」或管理者標記）。下一期判斷「上期按過」只看這個值。';
comment on column public.massage_signups.slot_conflict is
  '排時段時找不到跟他請假不衝突的空時段，只好照樣給一個。畫面上要提醒他自己找人換。';

-- 同一期同一個時段，同時間只能有一個人（已釋出的不算）
create unique index if not exists massage_signups_active_slot
  on public.massage_signups (session_id, slot_no)
  where slot_no is not null and released_at is null;

create index if not exists massage_signups_user on public.massage_signups (user_id);

-- 全公司共用的設定，只有一列（id 固定為 true）
create table if not exists public.massage_settings (
  id boolean primary key default true check (id),
  owner_id uuid references public.users(id),
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);
insert into public.massage_settings (id) values (true) on conflict (id) do nothing;

comment on column public.massage_settings.owner_id is
  '按摩預約負責人。遞補通知、隔天補標出席的提醒等「給管理者的通知」只發給這個人。';

-- 異動紀錄：只能新增。寫入一律透過下面的函式（massage_log），不開放直接寫。
create table if not exists public.massage_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.massage_sessions(id) on delete cascade,
  signup_id uuid references public.massage_signups(id) on delete cascade,
  user_id uuid references public.users(id),      -- 當事人
  actor_id uuid references public.users(id),     -- 誰做的；null = 系統自動
  event text not null,
  slot_no int,
  details jsonb not null default '{}'::jsonb,
  -- clock_timestamp 而不是 now()：同一個交易裡的多筆紀錄（例如取消 → 系統邀請
  -- 下一位）時間才會有先後
  created_at timestamptz not null default clock_timestamp()
);

comment on table public.massage_events is
  '按摩預約的異動紀錄（只能新增）。event 的種類見 massage_log 的說明。'
  '刪除「還沒抽籤」的期數時，那一期的紀錄會一起刪除（抽過籤的期數本來就不能刪）。';

create index if not exists massage_events_session on public.massage_events (session_id, id);
create index if not exists massage_events_user on public.massage_events (user_id);

-- 不能改：紀錄寫進去之後就固定了
create or replace function public.massage_events_no_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'massage_events_append_only: 異動紀錄只能新增，不能修改';
end;
$$;

drop trigger if exists massage_events_no_update on public.massage_events;
create trigger massage_events_no_update
  before update on public.massage_events
  for each row execute function public.massage_events_no_update();

/**
 * 寫一筆異動紀錄。只給其他函式內部呼叫，沒有開放給任何角色。
 *
 * event 的種類：
 *   signed_up        報名（details.reactivated = 取消後重新報名，附原本的報名時間）
 *   withdrew         抽籤前取消報名
 *   drawn            抽籤／排定時段（整期一筆，附人數、是否抽籤）
 *   draw_result      抽籤結果（每人一筆：名次、正取／候補、原本排到的時段）
 *   released         抽籤後取消／讓出名額（details.reason = cancel / yield）
 *   yield_answered   回答「要不要讓給候補」（選擇保留時記這筆；選擇讓出記 released）
 *   offered          系統邀請候補遞補
 *   offer_expired    有時限的邀請過期
 *   offer_lost       按「我要」時時段已被占用或已結束
 *   offer_superseded 管理者直接指定了別人，這個邀請作廢
 *   accepted         候補按「我要」
 *   assigned         管理者直接指定候補遞補
 *   moved            管理者改時段
 *   no_show          管理者在現場按「沒到」
 *   attendance       出席標記（本人按已完成，或管理者標記／清除）
 *   owner_changed    更換按摩預約負責人
 */
create or replace function public.massage_log(
  p_session_id uuid, p_signup_id uuid, p_user_id uuid, p_actor_id uuid,
  p_event text, p_slot_no int default null, p_details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.massage_events (session_id, signup_id, user_id, actor_id, event, slot_no, details)
  values (p_session_id, p_signup_id, p_user_id, p_actor_id, p_event, p_slot_no, coalesce(p_details, '{}'::jsonb));
$$;

revoke all on function public.massage_log(uuid, uuid, uuid, uuid, text, int, jsonb) from public;


-- ---------------------------------------------------------------------------
-- 時間計算
-- ---------------------------------------------------------------------------

-- 第 n 個時段的開始／結束時間（當天的時刻）
create or replace function public.massage_slot_from(p_start time, p_slot int, p_len int, p_break int)
returns time
language sql
immutable
as $$
  select p_start + make_interval(mins => (p_slot - 1) * (p_len + p_break));
$$;

create or replace function public.massage_slot_to(p_start time, p_slot int, p_len int, p_break int)
returns time
language sql
immutable
as $$
  select public.massage_slot_from(p_start, p_slot, p_len, p_break) + make_interval(mins => p_len);
$$;

-- 第 n 個時段的開始／結束（Asia/Taipei → timestamptz），給「時段開始了沒」這類判斷用
create or replace function public.massage_slot_start(p_session_id uuid, p_slot_no int)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select ((s.session_date
           + public.massage_slot_from(s.start_time, p_slot_no, s.slot_minutes, s.break_minutes))
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
 * 一張假單有沒有碰到某一天的 [p_from, p_to) 這段時間。
 *
 * 跨天的假單一律當成整天（請假單本身也是這樣算時數的：跨天時忽略時間、
 * 整天計算）。單日的假單才比對時間，只要有任何重疊就算。
 * 時間是空值的舊資料也當成整天，寧可多擋，不要漏擋。
 */
create or replace function public.massage_leave_touches(
  p_day date, p_from time, p_to time,
  p_start_date date, p_end_date date, p_start_time time, p_end_time time
)
returns boolean
language sql
immutable
as $$
  select p_day between p_start_date and p_end_date
     and (
       p_start_date <> p_end_date
       or (coalesce(p_start_time, '00:00') < p_to and coalesce(p_end_time, '23:59') > p_from)
     );
$$;

/**
 * 這個人在這一期「沒有請假衝突」的時段編號。
 * 審核中（pending）與已核准（approved）的假單都算；WFH 在系統裡就是一種假別，
 * 所以自然會被算進來。
 */
create or replace function public.massage_ok_slots(p_session_id uuid, p_user_id uuid)
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
     and not exists (
       select 1 from public.leave_requests lr
        where lr.requester_id = p_user_id
          and lr.status in ('pending', 'approved')
          and public.massage_leave_touches(
                s.session_date,
                public.massage_slot_from(s.start_time, n, s.slot_minutes, s.break_minutes),
                public.massage_slot_to(s.start_time, n, s.slot_minutes, s.break_minutes),
                lr.start_date::date, lr.end_date::date, lr.start_time::time, lr.end_time::time)
     );
$$;

/**
 * 第一張碰到這一期按摩時段（第一段開始 ～ 最後一段的休息結束）的假單，
 * 給畫面上的說明文字用。沒有就回 null。
 * 預設 13:00 + 9 × 20 分 = 16:00，跟試算表寫的「13:00–16:00」一致。
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
    from public.massage_sessions s
    join public.leave_requests lr on lr.requester_id = p_user_id
    left join public.leave_types lt on lt.id = lr.leave_type_id
   where s.id = p_session_id
     and lr.status in ('pending', 'approved')
     and public.massage_leave_touches(
           s.session_date,
           s.start_time,
           s.start_time + make_interval(mins => s.slot_count * (s.slot_minutes + s.break_minutes)),
           lr.start_date::date, lr.end_date::date, lr.start_time::time, lr.end_time::time)
   order by lr.start_date, lr.start_time
   limit 1;
$$;

/**
 * 網頁用：報名按鈕旁邊先顯示狀態，不用等按下去才知道。
 *   { state: 'none' }                    沒有請假
 *   { state: 'partial', leave: {...} }   部分時段請假：可以報，排時段時會避開
 *   { state: 'blocked', leave: {...} }   每個時段都撞到請假：不能報
 * 另外都帶 ok_slots（沒撞到請假的時段），已經排好時段的人可以用來即時判斷
 * 自己的時段是不是被後來的請假撞到了。
 */
create or replace function public.massage_my_leave_status(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when v.leave is null then jsonb_build_object('state', 'none')
    when cardinality(v.ok) = 0 then jsonb_build_object('state', 'blocked', 'leave', v.leave)
    else jsonb_build_object('state', 'partial', 'leave', v.leave)
  end || jsonb_build_object('ok_slots', to_jsonb(v.ok))
  from (
    select public.massage_leave_conflict(p_session_id, auth.uid()) as leave,
           public.massage_ok_slots(p_session_id, auth.uid()) as ok
  ) v;
$$;

/**
 * 管理頁用：這一期每一位報名者「沒撞到請假」的時段。
 * 指定遞補時，畫面要標出誰在那個時段有請假。非管理者呼叫會拿到空的結果。
 */
create or replace function public.massage_session_ok_slots(p_session_id uuid)
returns table (signup_id uuid, ok_slots int[])
language sql
stable
security definer
set search_path = public
as $$
  select g.id, public.massage_ok_slots(g.session_id, g.user_id)
    from public.massage_signups g
   where g.session_id = p_session_id
     and g.released_at is null
     and public.is_massage_manager();
$$;

revoke all on function public.massage_session_ok_slots(uuid) from public;
grant execute on function public.massage_session_ok_slots(uuid) to authenticated;

revoke all on function public.massage_slot_from(time, int, int, int) from public;
revoke all on function public.massage_slot_to(time, int, int, int) from public;
revoke all on function public.massage_slot_start(uuid, int) from public;
revoke all on function public.massage_slot_end(uuid, int) from public;
revoke all on function public.massage_leave_touches(date, time, time, date, date, time, time) from public;
revoke all on function public.massage_ok_slots(uuid, uuid) from public;
revoke all on function public.massage_leave_conflict(uuid, uuid) from public;
revoke all on function public.massage_my_leave_status(uuid) from public;
grant execute on function public.massage_slot_from(time, int, int, int) to authenticated, service_role;
grant execute on function public.massage_slot_to(time, int, int, int) to authenticated, service_role;
grant execute on function public.massage_slot_start(uuid, int) to authenticated, service_role;
grant execute on function public.massage_slot_end(uuid, int) to authenticated, service_role;
grant execute on function public.massage_ok_slots(uuid, uuid) to service_role;
grant execute on function public.massage_leave_conflict(uuid, uuid) to service_role;
grant execute on function public.massage_my_leave_status(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 報名
-- ---------------------------------------------------------------------------

/**
 * 回傳 jsonb：{ ok: true, signup_id, partial_leave } 或 { ok: false, code, ... }。
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
  v_leave jsonb;
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

  v_leave := public.massage_leave_conflict(p_session_id, p_user_id);
  -- 每一個時段都撞到請假才擋；只撞到部分時段的，排時段時會避開
  if v_leave is not null and cardinality(public.massage_ok_slots(p_session_id, p_user_id)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'leave_conflict', 'leave', v_leave);
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
    perform public.massage_log(p_session_id, v_row.id, p_user_id, p_user_id, 'signed_up', null,
      jsonb_build_object('reactivated', true, 'previous_signed_up_at', v_row.signed_up_at,
                         'partial_leave', v_leave is not null));
    return jsonb_build_object('ok', true, 'signup_id', v_row.id, 'partial_leave', v_leave);
  end if;

  insert into public.massage_signups (session_id, user_id)
  values (p_session_id, p_user_id)
  returning * into v_row;
  perform public.massage_log(p_session_id, v_row.id, p_user_id, p_user_id, 'signed_up', null,
    jsonb_build_object('partial_leave', v_leave is not null));
  return jsonb_build_object('ok', true, 'signup_id', v_row.id, 'partial_leave', v_leave);

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
-- 排時段（抽籤時呼叫）
-- ---------------------------------------------------------------------------

/**
 * 正取名單依名次排時段，避開請假。
 *
 * 第一輪：有部分請假的人（依名次），排在「離他原本順位最近、又不撞到請假」
 *         的空時段。原本順位 = 名次（第 3 名原本是第 3 個時段）。
 * 第二輪：其他人（以及第一輪排不進去的人）依名次，拿最早的空時段。
 *         排不進去的人會標 slot_conflict。
 *
 * 這樣有請假的人不會因為名次靠後就只剩撞到請假的時段可選；代價是其他人
 * 可能往前或往後挪一兩格。
 */
create or replace function public.massage_assign_slots(p_session_id uuid)
returns int   -- 排不開（slot_conflict）的人數
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  v_taken boolean[];
  v_ok int[];
  v_pick int;
  v_conflicts int := 0;
  r record;
begin
  select * into s from public.massage_sessions where id = p_session_id;
  v_taken := array_fill(false, array[s.slot_count]);

  for r in
    select id, user_id, draw_rank from public.massage_signups
     where session_id = p_session_id and result = 'selected' and released_at is null
     order by draw_rank
  loop
    v_ok := public.massage_ok_slots(p_session_id, r.user_id);
    if cardinality(v_ok) = s.slot_count then
      continue;   -- 沒有請假，第二輪再排
    end if;
    select n into v_pick
      from unnest(v_ok) n
     where not v_taken[n]
     order by abs(n - r.draw_rank), n
     limit 1;
    if v_pick is not null then
      update public.massage_signups set slot_no = v_pick, slot_conflict = false where id = r.id;
      v_taken[v_pick] := true;
    end if;
  end loop;

  for r in
    select id, user_id from public.massage_signups
     where session_id = p_session_id and result = 'selected'
       and released_at is null and slot_no is null
     order by draw_rank
  loop
    select n into v_pick
      from generate_series(1, s.slot_count) n
     where not v_taken[n]
     order by n
     limit 1;
    v_ok := public.massage_ok_slots(p_session_id, r.user_id);
    update public.massage_signups
       set slot_no = v_pick, slot_conflict = not (v_pick = any(v_ok))
     where id = r.id;
    if not (v_pick = any(v_ok)) then
      v_conflicts := v_conflicts + 1;
    end if;
    v_taken[v_pick] := true;
  end loop;

  return v_conflicts;
end;
$$;

revoke all on function public.massage_assign_slots(uuid) from public;
grant execute on function public.massage_assign_slots(uuid) to service_role;


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
  v_total int;
  v_selected int;
  v_conflicts int;
  v_asked int;
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

  select count(*) into v_total
    from public.massage_signups
   where session_id = p_session_id and released_at is null;

  -- 名次：人數未滿照報名先後；超過就全部一起隨機（每人一個亂數，先算好再排序）
  update public.massage_signups g
     set draw_rank = r.rn,
         result = case when r.rn <= s.slot_count then 'selected' else 'waitlist' end
    from (
      select a.id,
             row_number() over (
               order by
                 case when v_total <= s.slot_count then a.signed_up_at end,
                 a.rnd,
                 a.id
             ) as rn
        from (
          select id, signed_up_at, random() as rnd
            from public.massage_signups
           where session_id = p_session_id and released_at is null
        ) a
    ) r
   where g.id = r.id;

  -- 上一期 = 日期在這一期之前、最近一個已經抽過籤的
  select id into v_prev
    from public.massage_sessions
   where session_date < s.session_date and drawn_at is not null
   order by session_date desc, drawn_at desc
   limit 1;

  -- 上期按過（只看實際有按到）；上期按過、這期抽中、而且有人在候補的，系統會問他要不要讓
  update public.massage_signups g
     set went_last_time = (v_prev is not null and exists (
           select 1 from public.massage_signups p
            where p.session_id = v_prev and p.user_id = g.user_id and p.attendance = 'attended'))
   where g.session_id = p_session_id and g.released_at is null;

  update public.massage_signups
     set yield_asked = (result = 'selected' and went_last_time and v_total > s.slot_count)
   where session_id = p_session_id and released_at is null;

  v_conflicts := public.massage_assign_slots(p_session_id);

  perform set_config('massage.in_draw', 'on', true);
  update public.massage_sessions
     set drawn_at = now(), drawn_by = auth.uid()
   where id = p_session_id;
  perform set_config('massage.in_draw', 'off', true);

  select count(*) filter (where result = 'selected'),
         count(*) filter (where yield_asked)
    into v_selected, v_asked
    from public.massage_signups
   where session_id = p_session_id and released_at is null;

  -- 紀錄：整期一筆，加上每人一筆（之後換時段、遞補都會改到報名資料，
  -- 「抽籤當下的結果」只能從這裡查回來）
  perform public.massage_log(p_session_id, null, null, auth.uid(), 'drawn', null,
    jsonb_build_object('total', v_total, 'selected', v_selected, 'waitlist', v_total - v_selected,
                       'was_lottery', v_total > s.slot_count, 'slot_conflicts', v_conflicts,
                       'yield_asked', v_asked, 'previous_session_id', v_prev));
  insert into public.massage_events (session_id, signup_id, user_id, actor_id, event, slot_no, details)
  select g.session_id, g.id, g.user_id, auth.uid(), 'draw_result', g.slot_no,
         jsonb_build_object('rank', g.draw_rank, 'result', g.result,
                            'went_last_time', g.went_last_time, 'yield_asked', g.yield_asked,
                            'slot_conflict', g.slot_conflict,
                            'avoided_leave', cardinality(public.massage_ok_slots(g.session_id, g.user_id)) < s.slot_count)
    from public.massage_signups g
   where g.session_id = p_session_id and g.released_at is null
   order by g.draw_rank;

  return jsonb_build_object(
    'ok', true,
    'total', v_total,
    'selected', v_selected,
    'waitlist', v_total - v_selected,
    'was_lottery', v_total > s.slot_count,
    'slot_conflicts', v_conflicts,
    'yield_asked', v_asked
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
 * 候補順序 = 抽籤名次。跳過的人：
 *   · 已經有時段的、已經取消的
 *   · 手上已經有一個還沒回覆的邀請的
 *   · 「這個時段剛剛已經問過他、他沒回」的
 *   · 這個時段剛好有請假的（下一個空出的時段還是會再問他）
 *
 * p_window_minutes = null → 不設時限，等候補回覆。
 */
create or replace function public.massage_offer_next(p_session_id uuid, p_slot_no int, p_window_minutes int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_user uuid;
begin
  if p_slot_no is null or not exists (select 1 from public.massage_sessions where id = p_session_id) then
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

  select id, user_id into v_id, v_user
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
     and p_slot_no = any(public.massage_ok_slots(p_session_id, user_id))
   order by draw_rank
   limit 1
   for update skip locked;

  if v_id is null then
    return null;
  end if;

  update public.massage_signups
     set offer_slot_no = p_slot_no,
         offered_at = now(),
         offer_expires_at = case when p_window_minutes is null then null
                                 else now() + make_interval(mins => p_window_minutes) end,
         offer_status = 'pending'
   where id = v_id;

  perform public.massage_log(p_session_id, v_id, v_user, null, 'offered', p_slot_no,
    jsonb_build_object('window_minutes', p_window_minutes));

  return v_id;
end;
$$;

/**
 * 把已經過期的邀請（只有設了時限的才會過期）標成 expired，並把那個時段改邀下一位。
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
    select g.id, g.session_id, g.user_id, g.offer_slot_no, s.onsite_offer_window_minutes
      from public.massage_signups g
      join public.massage_sessions s on s.id = g.session_id
     where g.offer_status = 'pending' and g.offer_expires_at <= now()
     for update of g skip locked
  loop
    update public.massage_signups set offer_status = 'expired' where id = r.id;
    perform public.massage_log(r.session_id, r.id, r.user_id, null, 'offer_expired', r.offer_slot_no);
    perform public.massage_offer_next(r.session_id, r.offer_slot_no, r.onsite_offer_window_minutes);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.massage_offer_next(uuid, int, int) from public;
revoke all on function public.massage_expire_offers() from public;
grant execute on function public.massage_offer_next(uuid, int, int) to service_role;
grant execute on function public.massage_expire_offers() to service_role;


-- ---------------------------------------------------------------------------
-- 取消 / 釋出名額
-- ---------------------------------------------------------------------------

/**
 * 釋出名額的共用邏輯（本人取消、讓給候補都走這裡）。呼叫前要先鎖住那一列。
 * p_count_late = false 時，就算過了取消期限也不記未到（讓出名額是好意，不該被記）。
 * p_actor / p_reason 只用來寫異動紀錄（reason = cancel / yield）。
 */
drop function if exists public.massage_release_row(uuid, boolean);
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
begin
  select * into g from public.massage_signups where id = p_signup_id;
  select * into s from public.massage_sessions where id = g.session_id for update;

  -- 抽籤前：單純取消報名
  if s.drawn_at is null then
    update public.massage_signups set released_at = now() where id = g.id;
    perform public.massage_log(s.id, g.id, g.user_id, p_actor, 'withdrew');
    return jsonb_build_object('ok', true, 'phase', 'before_draw');
  end if;

  -- 自己的時段已經結束了，就不是「取消」而是「沒來」，交給出席標記處理
  if g.slot_no is not null and now() >= public.massage_slot_end(s.id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;

  v_late := p_count_late and g.slot_no is not null and now() >= s.cancel_deadline;
  -- 空出來要遞補的時段：自己占用的，或是手上還沒回覆的那個邀請
  v_free_slot := coalesce(g.slot_no, case when g.offer_status = 'pending' then g.offer_slot_no end);

  update public.massage_signups
     set released_at = now(),
         released_late = v_late,
         offer_status = case when offer_status = 'pending' then 'declined' else offer_status end,
         attendance = case when v_late then 'no_show' else attendance end,
         attendance_marked_at = case when v_late then now() else attendance_marked_at end
   where id = g.id;

  -- 先記「釋出」再邀請下一位，時間軸的順序才會對
  perform public.massage_log(s.id, g.id, g.user_id, p_actor, 'released', g.slot_no,
    jsonb_build_object('reason', p_reason, 'late', v_late, 'freed_slot', v_free_slot,
                       'declined_offer_slot', case when g.offer_status = 'pending' then g.offer_slot_no end));

  -- 本人在按摩開始前釋出：不設時限，等候補第一位回覆
  if v_free_slot is not null then
    v_offered := public.massage_offer_next(s.id, v_free_slot, null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', 'after_draw',
    'late', v_late,
    'freed_slot', v_free_slot,
    'offered_signup_id', v_offered
  );
end;
$$;

create or replace function public.massage_release_as(p_signup_id uuid, p_user_id uuid)
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
  if g.released_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_released');
  end if;
  return public.massage_release_row(g.id, true, p_user_id, 'cancel');
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

revoke all on function public.massage_release_row(uuid, boolean, uuid, text) from public;
revoke all on function public.massage_release_as(uuid, uuid) from public;
revoke all on function public.massage_release(uuid) from public;
grant execute on function public.massage_release_as(uuid, uuid) to service_role;
grant execute on function public.massage_release(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 上期按過又抽中：要不要讓給候補（本人決定，不強制）
-- ---------------------------------------------------------------------------
create or replace function public.massage_answer_yield_as(p_signup_id uuid, p_user_id uuid, p_yield boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  v_res jsonb;
begin
  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or p_user_id is null or g.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not g.yield_asked or g.released_at is not null then
    return jsonb_build_object('ok', false, 'code', 'not_asked');
  end if;
  if g.yield_answer is not null then
    return jsonb_build_object('ok', false, 'code', 'already_answered', 'answer', g.yield_answer);
  end if;

  if not p_yield then
    update public.massage_signups
       set yield_answer = 'kept', yield_answered_at = now()
     where id = g.id;
    perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'yield_answered', g.slot_no,
      jsonb_build_object('answer', 'kept'));
    return jsonb_build_object('ok', true, 'answer', 'kept');
  end if;

  v_res := public.massage_release_row(g.id, false, p_user_id, 'yield');
  if not (v_res->>'ok')::boolean then
    return v_res;
  end if;
  update public.massage_signups
     set yield_answer = 'yielded', yield_answered_at = now()
   where id = g.id;
  return v_res || jsonb_build_object('answer', 'yielded');
end;
$$;

create or replace function public.massage_answer_yield(p_signup_id uuid, p_yield boolean)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.massage_answer_yield_as(p_signup_id, auth.uid(), p_yield);
$$;

revoke all on function public.massage_answer_yield_as(uuid, uuid, boolean) from public;
revoke all on function public.massage_answer_yield(uuid, boolean) from public;
grant execute on function public.massage_answer_yield_as(uuid, uuid, boolean) to service_role;
grant execute on function public.massage_answer_yield(uuid, boolean) to authenticated;


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

  -- 時段已經結束：按了也沒意義
  if now() >= public.massage_slot_end(g.session_id, g.offer_slot_no) then
    update public.massage_signups set offer_status = 'expired' where id = g.id;
    perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'offer_lost', g.offer_slot_no,
      jsonb_build_object('reason', 'slot_over'));
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;

  -- 有時限的邀請過期了：照規則讓給下一位（不設時限的邀請 offer_expires_at 是 null，不會進來）
  if g.offer_expires_at is not null and now() > g.offer_expires_at then
    update public.massage_signups set offer_status = 'expired' where id = g.id;
    perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'offer_expired', g.offer_slot_no,
      jsonb_build_object('on_accept', true));
    perform public.massage_offer_next(
      g.session_id, g.offer_slot_no,
      (select onsite_offer_window_minutes from public.massage_sessions where id = g.session_id));
    return jsonb_build_object('ok', false, 'code', 'offer_expired');
  end if;

  if exists (
    select 1 from public.massage_signups
     where session_id = g.session_id and slot_no = g.offer_slot_no and released_at is null
  ) then
    update public.massage_signups set offer_status = 'expired' where id = g.id;
    perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'offer_lost', g.offer_slot_no,
      jsonb_build_object('reason', 'slot_taken'));
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;

  update public.massage_signups
     set slot_no = g.offer_slot_no,
         result = 'selected',
         offer_status = 'accepted',
         promoted_at = now()
   where id = g.id;

  perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'accepted', g.offer_slot_no,
    jsonb_build_object('rank', g.draw_rank));

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
-- 管理者：現場按「沒到」
-- ---------------------------------------------------------------------------

/**
 * 時段已經開始、人還沒來：記為未到、空出時段、通知候補第一位。
 * 系統沒辦法知道人到了沒有，所以由在現場的管理者判斷後按下（使用者確認）。
 */
create or replace function public.massage_mark_no_show(p_signup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  s public.massage_sessions;
  v_offered uuid;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or g.released_at is not null or g.slot_no is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into s from public.massage_sessions where id = g.session_id;

  if now() < public.massage_slot_start(s.id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'not_started');
  end if;
  if now() >= public.massage_slot_end(s.id, g.slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;

  update public.massage_signups
     set attendance = 'no_show',
         attendance_marked_by = auth.uid(),
         attendance_marked_at = now(),
         released_at = now()
   where id = g.id;

  perform public.massage_log(s.id, g.id, g.user_id, auth.uid(), 'no_show', g.slot_no);

  v_offered := public.massage_offer_next(s.id, g.slot_no, s.onsite_offer_window_minutes);

  return jsonb_build_object('ok', true, 'freed_slot', g.slot_no, 'offered_signup_id', v_offered);
end;
$$;

revoke all on function public.massage_mark_no_show(uuid) from public;
grant execute on function public.massage_mark_no_show(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 管理者：直接指定某位候補遞補
-- ---------------------------------------------------------------------------

/**
 * 把一位候補直接排進一個空的時段，不經過「邀請 → 按我要」。
 *
 * 給現場用：你走過去問到人了，直接按下去就好。刻意保留彈性：
 *   · 不強制照候補順序
 *   · 抽籤後、時段結束前都可以用（不限按摩當天）
 *   · 那個時段有人手上有系統邀請 → 邀請作廢（superseded）
 *   · 被指定的人自己手上如果有別的時段的邀請 → 也作廢，那個時段改邀下一位
 *   · 撞到他的請假也可以指定（現場講好的），只標示 slot_conflict
 */
create or replace function public.massage_assign_waitlist(p_signup_id uuid, p_slot_no int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.massage_signups;
  s public.massage_sessions;
  v_superseded uuid[];
  v_reoffered uuid;
  v_conflict boolean;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  select * into g from public.massage_signups where id = p_signup_id for update;
  if not found or g.released_at is not null or g.result is distinct from 'waitlist' or g.slot_no is not null then
    return jsonb_build_object('ok', false, 'code', 'not_waitlisted');
  end if;
  select * into s from public.massage_sessions where id = g.session_id for update;
  if p_slot_no is null or p_slot_no < 1 or p_slot_no > s.slot_count then
    return jsonb_build_object('ok', false, 'code', 'invalid_slot');
  end if;
  if now() >= public.massage_slot_end(s.id, p_slot_no) then
    return jsonb_build_object('ok', false, 'code', 'slot_over');
  end if;
  if exists (
    select 1 from public.massage_signups
     where session_id = s.id and slot_no = p_slot_no and released_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;

  -- 這個時段上別人手上的系統邀請作廢
  with x as (
    update public.massage_signups
       set offer_status = 'superseded'
     where session_id = s.id and offer_status = 'pending'
       and offer_slot_no = p_slot_no and id <> g.id
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_superseded from x;

  insert into public.massage_events (session_id, signup_id, user_id, actor_id, event, slot_no, details)
  select o.session_id, o.id, o.user_id, auth.uid(), 'offer_superseded', p_slot_no,
         jsonb_build_object('assigned_signup_id', g.id)
    from public.massage_signups o
   where o.id = any(v_superseded);

  v_conflict := not (p_slot_no = any(public.massage_ok_slots(s.id, g.user_id)));

  update public.massage_signups
     set slot_no = p_slot_no,
         result = 'selected',
         promoted_at = now(),
         slot_conflict = v_conflict,
         offer_status = case when offer_status = 'pending' and offer_slot_no = p_slot_no then 'accepted'
                             when offer_status = 'pending' then 'superseded'
                             else offer_status end
   where id = g.id;

  perform public.massage_log(s.id, g.id, g.user_id, auth.uid(), 'assigned', p_slot_no,
    jsonb_build_object('rank', g.draw_rank, 'slot_conflict', v_conflict,
                       'had_offer_slot', case when g.offer_status = 'pending' then g.offer_slot_no end));

  -- 他原本手上有「別的時段」的邀請：那個時段改邀下一位（不設時限）
  if g.offer_status = 'pending' and g.offer_slot_no is distinct from p_slot_no then
    v_reoffered := public.massage_offer_next(s.id, g.offer_slot_no, null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'slot_no', p_slot_no,
    'slot_conflict', v_conflict,
    'superseded_signup_ids', to_jsonb(v_superseded),
    'reoffered_signup_id', v_reoffered
  );
end;
$$;

revoke all on function public.massage_assign_waitlist(uuid, int) from public;
grant execute on function public.massage_assign_waitlist(uuid, int) to authenticated;


-- ---------------------------------------------------------------------------
-- 負責人
-- ---------------------------------------------------------------------------

-- 只能設成在職的管理員或 HR —— 收到通知卻沒有權限處理，等於沒通知
create or replace function public.massage_set_owner(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;
  if p_user_id is not null and not exists (
    select 1 from public.users
     where id = p_user_id and coalesce(is_active, true) and (is_admin or is_finance)
  ) then
    return jsonb_build_object('ok', false, 'code', 'owner_not_manager');
  end if;
  perform public.massage_log(null, null, p_user_id, auth.uid(), 'owner_changed', null,
    jsonb_build_object('from', (select owner_id from public.massage_settings where id), 'to', p_user_id));
  update public.massage_settings
     set owner_id = p_user_id, updated_by = auth.uid(), updated_at = now()
   where id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.massage_set_owner(uuid) from public;
grant execute on function public.massage_set_owner(uuid) to authenticated;


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

  -- 換過之後重新判斷有沒有撞到請假（只是標示，不擋：是兩人講好的）
  update public.massage_signups
     set slot_conflict = not (slot_no = any(public.massage_ok_slots(session_id, user_id)))
   where id in (g.id, v_other);

  perform public.massage_log(s.id, g.id, g.user_id, auth.uid(), 'moved', p_target_slot,
    jsonb_build_object('from', v_from, 'to', p_target_slot, 'swapped_with', v_other));
  if v_other is not null then
    perform public.massage_log(s.id, v_other, (select user_id from public.massage_signups where id = v_other),
      auth.uid(), 'moved', v_from,
      jsonb_build_object('from', p_target_slot, 'to', v_from, 'swapped_with', g.id));
  end if;

  return jsonb_build_object('ok', true, 'swapped_with', v_other);
end;
$$;

revoke all on function public.massage_move_slot(uuid, int) from public;
grant execute on function public.massage_move_slot(uuid, int) to authenticated;


-- ---------------------------------------------------------------------------
-- 出席
-- ---------------------------------------------------------------------------

-- 本人按「已完成」：只能標自己、只能標「有按到」、時段開始之後才能按
--
-- 刻意沒有「沒按到」可以讓本人自己選：「上期按過」只看有沒有按到，如果
-- 本人能自己回答「沒按到」，下一期就不會被問要不要讓出 —— 有說謊的誘因。
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
  perform public.massage_log(g.session_id, g.id, g.user_id, p_user_id, 'attendance', g.slot_no,
    jsonb_build_object('status', 'attended', 'by', 'self'));
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
  perform public.massage_log(g.session_id, g.id, g.user_id, auth.uid(), 'attendance', g.slot_no,
    jsonb_build_object('status', p_status, 'previous', g.attendance, 'by', 'manager'));
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
 *
 * 已經排好時段的人：只有撞到「自己那個時段」才算。
 * 還沒有時段的人（抽籤前、候補）：只有請假讓他「每個時段都不能按」才算
 * —— 只撞到部分時段的話，排時段 / 遞補時本來就會避開。
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
     and case
           when g.slot_no is not null then
             public.massage_leave_touches(
               s.session_date,
               public.massage_slot_from(s.start_time, g.slot_no, s.slot_minutes, s.break_minutes),
               public.massage_slot_to(s.start_time, g.slot_no, s.slot_minutes, s.break_minutes),
               lr.start_date::date, lr.end_date::date, lr.start_time::time, lr.end_time::time)
           else
             cardinality(public.massage_ok_slots(s.id, g.user_id)) = 0
             and public.massage_leave_touches(
               s.session_date, s.start_time,
               s.start_time + make_interval(mins => s.slot_count * (s.slot_minutes + s.break_minutes)),
               lr.start_date::date, lr.end_date::date, lr.start_time::time, lr.end_time::time)
         end
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
alter table public.massage_settings enable row level security;
alter table public.massage_events enable row level security;

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

  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_settings' and policyname = 'massage_settings_read_all') then
    create policy massage_settings_read_all on public.massage_settings
      for select to authenticated using (true);
  end if;

  -- 異動紀錄只有管理員與 HR 看得到（使用者確認）
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'massage_events' and policyname = 'massage_events_managers_read') then
    create policy massage_events_managers_read on public.massage_events
      for select to authenticated using (public.is_massage_manager());
  end if;

  -- massage_signups / massage_settings / massage_events 刻意沒有任何寫入政策：只能透過上面的函式寫入
end $$;

grant select on public.massage_sessions to authenticated;
grant insert, update, delete on public.massage_sessions to authenticated;
grant select on public.massage_signups to authenticated;
grant select on public.massage_settings to authenticated;
grant select on public.massage_events to authenticated;
grant select on public.massage_events to service_role;
grant all on public.massage_settings to service_role;
grant all on public.massage_sessions to service_role;
grant all on public.massage_signups to service_role;
