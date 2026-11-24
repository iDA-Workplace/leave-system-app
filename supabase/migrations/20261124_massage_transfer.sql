-- ============================================================================
-- 按摩預約：管理員把 A 的時段「換人」給 B（2026-11 使用者決定）
-- ============================================================================
--
-- 原本規定名額不能讓給別人（只能釋出，依候補順序遞補）。現在可以彈性讓位，
-- 但一樣只能由管理員（或 HR）在後台「現場面板」改名單，同仁不能自己轉讓。
--
-- 使用者決定的規則：
--   · B 可以是任何在職同仁：這期沒報名的、正在候補的、這期取消過的都可以
--   · B 這期已經有時段的不行（一人一個時段，跟現有規則一致）
--   · 時段開始前都可以換
--   · 管理員一定要寫說明（例如：A 臨時出差，讓給 B）
--   · A 的紀錄記為「讓給 B」：不算未到、也不算這期有按到 → 下次抽籤 A 一樣算「上一期沒按到」
--   · Minimon 私訊 A（附管理員的說明）與 B（寫出是 A 讓給他的）
--   · B 撞到請假：跟「加進空時段」一樣先提醒，管理員確認後仍然可以換
--
-- 這支做的事：
--   1. massage_signups 加欄位：A 那筆記「讓給誰、哪個時段、什麼時候」；B 那筆記「從誰那裡接手」
--      （說明只記在異動紀錄裡 —— 報名名單全公司都看得到，異動紀錄只有管理員與 HR 看得到）
--   2. massage_transfer_slot()：換人
--
-- A 讓出後，他那筆的時段會清空（記在 transferred_slot_no），所以不會被當成
-- 「等待期間釋出的名額」，也不能再「取消釋出」把時段拿回去。
--
-- 要先執行 20261019～20261026 的按摩 migration（正式資料庫早就有）。
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 欄位 ---------------------------------------------------------------------------
alter table public.massage_signups
  add column if not exists transferred_to uuid references public.users(id),
  add column if not exists transferred_slot_no int,
  add column if not exists transferred_at timestamptz,
  add column if not exists received_from uuid references public.users(id),
  add column if not exists received_at timestamptz;

comment on column public.massage_signups.transferred_to is
  '管理員把這個人的時段換給了誰（massage_transfer_slot，2026-11）。有值＝讓給他人，不算取消、不算未到。';
comment on column public.massage_signups.transferred_slot_no is '讓出去的是哪個時段（讓出後 slot_no 會清空）';
comment on column public.massage_signups.received_from is
  '這個時段是從誰那裡接手的（管理員換人）。有值而且 draw_rank 是 null 的，代表這期沒有自己報名。';


-- 2. 換人 ---------------------------------------------------------------------------
/**
 * 回傳 jsonb：
 *   { ok: true, slot_no, slot_conflict, from_signup_id, to_signup_id, via }
 *       via = added（這期沒報名）／reactivated（這期取消過）／waitlist（原本在候補）
 *   { ok: false, code: 'leave_conflict_confirm' }  B 撞到請假、還沒確認 → 畫面問管理者，確認後帶 p_force = true 再呼叫一次
 *   { ok: false, code }  其他：not_allowed / note_required / not_found / transfer_no_slot / slot_started /
 *                        same_person / user_inactive / already_has_slot
 */
create or replace function public.massage_transfer_slot(
  p_signup_id uuid, p_to_user uuid, p_note text, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.massage_signups;
  b public.massage_signups;
  s public.massage_sessions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_slot int;
  v_found boolean;
  v_conflict boolean;
  v_to_id uuid;
  v_via text;
  v_reoffered uuid;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;
  if v_note is null then
    return jsonb_build_object('ok', false, 'code', 'note_required');
  end if;

  select * into a from public.massage_signups where id = p_signup_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  -- 先鎖期數再鎖報名，跟其他按摩函式的順序一樣
  select * into s from public.massage_sessions where id = a.session_id for update;
  select * into a from public.massage_signups where id = p_signup_id for update;
  if s.drawn_at is null or a.released_at is not null or a.slot_no is null then
    return jsonb_build_object('ok', false, 'code', 'transfer_no_slot');
  end if;
  v_slot := a.slot_no;
  if now() >= public.massage_slot_start(s.id, v_slot) then
    return jsonb_build_object('ok', false, 'code', 'slot_started');
  end if;
  if p_to_user is null or p_to_user = a.user_id then
    return jsonb_build_object('ok', false, 'code', 'same_person');
  end if;
  if not exists (select 1 from public.users where id = p_to_user and coalesce(is_active, true)) then
    return jsonb_build_object('ok', false, 'code', 'user_inactive');
  end if;

  select * into b from public.massage_signups
   where session_id = s.id and user_id = p_to_user for update;
  v_found := found;
  if v_found and b.released_at is null and b.slot_no is not null then
    return jsonb_build_object('ok', false, 'code', 'already_has_slot');
  end if;

  v_conflict := not (v_slot = any(public.massage_ok_slots(s.id, p_to_user)));
  if v_conflict and not p_force then
    return jsonb_build_object('ok', false, 'code', 'leave_conflict_confirm');
  end if;

  -- A：讓出（不算取消、不算未到）。時段清空，記在 transferred_slot_no
  update public.massage_signups
     set released_at = now(),
         released_late = false,
         slot_no = null,
         slot_conflict = false,
         transferred_to = p_to_user,
         transferred_slot_no = v_slot,
         transferred_at = now()
   where id = a.id;

  -- B：接手這個時段
  if not v_found then
    insert into public.massage_signups (session_id, user_id, result, slot_no, slot_conflict, received_from, received_at)
    values (s.id, p_to_user, 'selected', v_slot, v_conflict, a.user_id, now())
    returning id into v_to_id;
    v_via := 'added';
  elsif b.released_at is not null then
    -- 這期取消過的人：跟「加進空時段」一樣，逾期取消被記的未到一起清掉
    update public.massage_signups
       set released_at = null,
           released_late = false,
           slot_no = v_slot,
           result = 'selected',
           slot_conflict = v_conflict,
           attendance = null,
           attendance_marked_by = null,
           attendance_marked_at = null,
           offer_status = case when offer_status = 'pending' then 'superseded' else offer_status end,
           received_from = a.user_id,
           received_at = now()
     where id = b.id;
    v_to_id := b.id;
    v_via := 'reactivated';
  else
    -- 正在候補：手上如果有「別的時段」的遞補邀請，那個邀請作廢、改邀下一位（同指定遞補）
    update public.massage_signups
       set slot_no = v_slot,
           result = 'selected',
           slot_conflict = v_conflict,
           offer_status = case when offer_status = 'pending' then 'superseded' else offer_status end,
           received_from = a.user_id,
           received_at = now()
     where id = b.id;
    v_to_id := b.id;
    v_via := 'waitlist';
  end if;

  -- 異動紀錄：先記 A 讓出，再記 B 接手（說明只記在這裡，只有管理員與 HR 看得到）
  perform public.massage_log(s.id, a.id, a.user_id, auth.uid(), 'transferred_out', v_slot,
    jsonb_build_object('to_user_id', p_to_user, 'to_signup_id', v_to_id, 'note', v_note));
  perform public.massage_log(s.id, v_to_id, p_to_user, auth.uid(), 'transferred_in', v_slot,
    jsonb_build_object('from_user_id', a.user_id, 'from_signup_id', a.id, 'note', v_note,
                       'slot_conflict', v_conflict, 'via', v_via,
                       'previous_released_at', case when v_found then b.released_at end,
                       'previous_attendance', case when v_found then b.attendance end,
                       'had_offer_slot', case when v_found and b.offer_status = 'pending' then b.offer_slot_no end));

  if v_found and b.offer_status = 'pending' and b.offer_slot_no is not null then
    v_reoffered := public.massage_offer_next(s.id, b.offer_slot_no, null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'via', v_via,
    'slot_no', v_slot,
    'slot_conflict', v_conflict,
    'from_signup_id', a.id,
    'to_signup_id', v_to_id,
    'reoffered_signup_id', v_reoffered);

exception when unique_violation then
  -- 兩位管理者同時操作同一個時段
  return jsonb_build_object('ok', false, 'code', 'slot_taken');
end;
$$;

revoke all on function public.massage_transfer_slot(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.massage_transfer_slot(uuid, uuid, text, boolean) to authenticated;


-- 驗收：兩列都要是「是」
select '報名資料有「讓給誰／從誰接手」欄位' as 項目,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'massage_signups' and column_name = 'transferred_to')
             and exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'massage_signups' and column_name = 'received_from')
            then '是' else '否' end as 結果
union all
select '管理員換人的函式已建立',
       case when to_regprocedure('public.massage_transfer_slot(uuid, uuid, text, boolean)') is not null then '是' else '否' end;
