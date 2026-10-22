-- ============================================================================
-- 按摩預約：提前截止報名
-- ============================================================================
--
-- 要先執行 20261019_massage_booking.sql。
--
-- 管理頁「編輯這一期」的「提前截止」按鈕（使用者要求）：按一下就把報名截止
-- 時間設成「現在」，不用自己去改日期時間。用資料庫的時間（不是各人電腦的
-- 時鐘），並記一筆異動紀錄（誰、什麼時候、原本的截止時間）。
--
-- 只有還沒抽籤、報名還沒截止的期數能用。其他時間（取消期限、預計抽籤時間）不動。

create or replace function public.massage_close_signup(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.massage_sessions;
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;
  select * into s from public.massage_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if s.drawn_at is not null then
    return jsonb_build_object('ok', false, 'code', 'already_drawn');
  end if;
  if now() >= s.signup_deadline then
    return jsonb_build_object('ok', false, 'code', 'signup_closed');
  end if;

  update public.massage_sessions set signup_deadline = now() where id = s.id;
  perform public.massage_log(s.id, null, null, auth.uid(), 'signup_closed_early', null,
    jsonb_build_object('previous_deadline', s.signup_deadline));
  return jsonb_build_object('ok', true, 'signup_deadline', now());
end;
$$;

revoke all on function public.massage_close_signup(uuid) from public, anon;
grant execute on function public.massage_close_signup(uuid) to authenticated;
