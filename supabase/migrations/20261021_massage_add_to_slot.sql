-- ============================================================================
-- 按摩預約：管理者把任何一位在職同仁直接加進空的時段
-- ============================================================================
--
-- 要先執行 20261019_massage_booking.sql、20261020_massage_slack.sql。
--
-- 使用者決定的規則（2026-10）：
--   · 可以選「所有在職同仁」，包含這期沒報名的人
--   · 抽籤後，只要時段是空的、還沒結束，就可以加
--   · 撞到他的請假：先提醒，管理者確認後仍然可以加（標示 slot_conflict）
--   · 這期自己取消過的人也可以加回來（取消的那筆異動紀錄保留）
--   · 加進去之後，Slack 私訊通知當事人（massage-notify 看 'added' 這筆紀錄）
--
-- 選到的人如果正在候補：直接走「指定遞補」（massage_assign_waitlist），
-- 邀請作廢、改邀下一位那些細節都跟指定遞補一模一樣，不另寫一套。

-- 誰、什麼時候被管理者加進來的（給統計用：這種不算「自己報名」）
alter table public.massage_signups
  add column if not exists added_by uuid references public.users(id),
  add column if not exists added_at timestamptz;

comment on column public.massage_signups.added_at is
  '管理者直接加進空時段的時間（massage_add_to_slot）。有值而且 draw_rank 是 null 的，代表這期沒有自己報名。';

/**
 * 回傳 jsonb：
 *   { ok: true, slot_no, slot_conflict, via }   via = added / reactivated / assigned（候補走指定遞補）
 *   { ok: false, code: 'leave_conflict_confirm' }  撞到請假、還沒確認 → 畫面問管理者，確認後帶 p_force = true 再呼叫一次
 *   { ok: false, code }  其他：not_allowed / session_not_found / not_drawn / invalid_slot / slot_over /
 *                        user_inactive / already_has_slot / slot_taken
 */
create or replace function public.massage_add_to_slot(
  p_session_id uuid, p_user_id uuid, p_slot_no int, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
  g public.massage_signups;
  v_found boolean;
  v_conflict boolean;
  v_superseded uuid[];
  v_signup_id uuid;
  v_res jsonb;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

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
  if not exists (select 1 from public.users where id = p_user_id and coalesce(is_active, true)) then
    return jsonb_build_object('ok', false, 'code', 'user_inactive');
  end if;

  select * into g from public.massage_signups
   where session_id = s.id and user_id = p_user_id for update;
  v_found := found;
  if v_found and g.released_at is null and g.slot_no is not null then
    return jsonb_build_object('ok', false, 'code', 'already_has_slot');
  end if;
  if exists (
    select 1 from public.massage_signups
     where session_id = s.id and slot_no = p_slot_no and released_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'slot_taken');
  end if;

  v_conflict := not (p_slot_no = any(public.massage_ok_slots(s.id, p_user_id)));
  if v_conflict and not p_force then
    return jsonb_build_object('ok', false, 'code', 'leave_conflict_confirm');
  end if;

  -- 正在候補 → 跟「指定遞補」完全一樣
  if v_found and g.released_at is null then
    v_res := public.massage_assign_waitlist(g.id, p_slot_no);
    return v_res || jsonb_build_object('via', 'assigned');
  end if;

  -- 這個時段上別人手上的系統邀請作廢（同指定遞補）
  with x as (
    update public.massage_signups
       set offer_status = 'superseded'
     where session_id = s.id and offer_status = 'pending' and offer_slot_no = p_slot_no
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_superseded from x;

  if v_found then
    -- 這期取消過的人加回來。取消時如果是逾期取消、被記成未到，人既然回來按了，
    -- 未到的紀錄就清掉（原本的取消紀錄仍留在異動紀錄裡）
    update public.massage_signups
       set released_at = null,
           released_late = false,
           slot_no = p_slot_no,
           result = 'selected',
           slot_conflict = v_conflict,
           attendance = null,
           attendance_marked_by = null,
           attendance_marked_at = null,
           added_by = auth.uid(),
           added_at = now()
     where id = g.id;
    v_signup_id := g.id;
  else
    insert into public.massage_signups (session_id, user_id, result, slot_no, slot_conflict, added_by, added_at)
    values (s.id, p_user_id, 'selected', p_slot_no, v_conflict, auth.uid(), now())
    returning id into v_signup_id;
  end if;

  -- 先記「加入」，再記被作廢的邀請：時間軸上的因果順序才會對
  perform public.massage_log(s.id, v_signup_id, p_user_id, auth.uid(), 'added', p_slot_no,
    jsonb_build_object(
      'slot_conflict', v_conflict,
      'reactivated', v_found,
      'previous_released_at', case when v_found then g.released_at end,
      'previous_attendance', case when v_found then g.attendance end));

  insert into public.massage_events (session_id, signup_id, user_id, actor_id, event, slot_no, details)
  select o.session_id, o.id, o.user_id, auth.uid(), 'offer_superseded', p_slot_no,
         jsonb_build_object('added_signup_id', v_signup_id)
    from public.massage_signups o
   where o.id = any(v_superseded);

  return jsonb_build_object(
    'ok', true,
    'via', case when v_found then 'reactivated' else 'added' end,
    'signup_id', v_signup_id,
    'slot_no', p_slot_no,
    'slot_conflict', v_conflict,
    'superseded_signup_ids', to_jsonb(v_superseded));

exception when unique_violation then
  -- 兩位管理者同時把不同的人加進同一個時段
  return jsonb_build_object('ok', false, 'code', 'slot_taken');
end;
$$;

revoke all on function public.massage_add_to_slot(uuid, uuid, int, boolean) from public, anon;
grant execute on function public.massage_add_to_slot(uuid, uuid, int, boolean) to authenticated;
