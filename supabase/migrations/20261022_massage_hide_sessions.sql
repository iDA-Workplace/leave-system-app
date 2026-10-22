-- ============================================================================
-- 按摩預約：隱藏期數（管理頁「各期」列表）
-- ============================================================================
--
-- 要先執行 20261019_massage_booking.sql。
--
-- 使用者決定（2026-10）：抽過籤的期數「不能刪除，只能隱藏」—— 抽籤結果與
-- 異動紀錄要完整保留。還沒抽籤的期數維持可以刪除。
--
-- 隱藏目前只影響管理頁的「各期」列表（預設不顯示，可以勾「顯示已隱藏」再
-- 取消隱藏）。同仁紀錄的統計、同仁看到的頁面、抽籤時「上一期」的判斷都
-- 不受影響。

alter table public.massage_sessions
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.users(id);

comment on column public.massage_sessions.hidden_at is
  '管理者把這一期從管理頁的「各期」列表隱藏的時間。只影響那個列表，紀錄與統計照常。';

/** 隱藏／取消隱藏。管理者才能用；寫一筆異動紀錄（誰、什麼時候）。 */
create or replace function public.massage_set_hidden(p_session_id uuid, p_hidden boolean)
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
  if (s.hidden_at is not null) = p_hidden then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  update public.massage_sessions
     set hidden_at = case when p_hidden then now() end,
         hidden_by = case when p_hidden then auth.uid() end
   where id = s.id;
  perform public.massage_log(s.id, null, null, auth.uid(), case when p_hidden then 'hidden' else 'unhidden' end);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.massage_set_hidden(uuid, boolean) from public, anon;
grant execute on function public.massage_set_hidden(uuid, boolean) to authenticated;
