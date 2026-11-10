-- ============================================================================
-- 2026-11-10 安全修正（第二輪）：資料庫權限收緊
-- ============================================================================
--
-- 使用者同意後修正。正式資料庫的權限規則（2026-11 匯出檢查）有這些洞：
--
--   1. users_update_self：每個人都能改「自己的員工資料」而且不限欄位
--      → 任何同仁都能把自己改成管理員／HR／老闆。
--   2. requests_update_own：申請人能改自己的假單、不限欄位 → 可以把自己的假單
--      直接改成「已核准」；同一條規則還讓「主管」角色能改任何人假單的任何欄位。
--      requests_insert 也沒限制狀態 → 可以直接新增一張「已核准」的假單。
--   3. users_select（對 public 開放）：沒登入的人也讀得到全公司員工名單。
--      annual_leave_summary 檢視表也一樣（姓名、到職日、特休使用量）。
--   4. approvals_insert：任何人都能替任何假單新增一筆「我核准了」的審核紀錄。
--   5. users_insert（check true）：任何人都能在員工資料表新增一筆。
--   6. handle_new_user：新登入帳號的角色取自註冊時帶的資料 → 如果 Supabase 開著
--      「允許自行註冊」，外人註冊時可以把自己設成老闆。
--   7. （既有 bug）notification_targets 的寫入規則只認 role = 'admin'，但管理員
--      是用 is_admin 勾選框，沒有人的 role 是 'admin' → 「通知對象」的新增／停用／
--      移除一直沒有真的存進去。
--
-- 修法原則：網站程式不用改，現有功能全部照舊。
--   - 假單用「觸發器」檢查「誰能改哪些欄位」（權限規則只能管「能不能碰這一筆」，
--     管不到欄位），只對從網站／API 來的請求（anon / authenticated）生效；
--     Slack 互動、每日排程等用 service role 的後台程式不受影響。
--   - 查身分的小函式都用 security definer，之後收緊其他資料表的讀取權限時，
--     這裡的判斷不會跟著壞掉。
--
-- 可以重複執行。

-- ── 0. 身分判斷的小函式 ─────────────────────────────────────────────────

create or replace function public.is_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users
                  where id = auth.uid() and is_admin and is_active is not false)
$$;

create or replace function public.is_hr_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users
                  where id = auth.uid() and is_finance and is_active is not false)
$$;

-- 這個人是不是「這個簽核流程第 p_step 關」的簽核人
create or replace function public.is_flow_step_approver(p_flow uuid, p_step integer)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.approval_flow_steps
                  where flow_id = p_flow and step_order = p_step and approver_id = auth.uid())
$$;

-- 簽核流程的最後一關（沒有關卡回 null）
create or replace function public.flow_last_step(p_flow uuid)
returns integer language sql stable security definer set search_path = public as $$
  select max(step_order) from public.approval_flow_steps where flow_id = p_flow
$$;

-- 申請人「現在」的預設簽核流程
create or replace function public.user_default_flow(p_user uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select default_flow_id from public.users where id = p_user
$$;

revoke all on function public.is_admin_user(), public.is_hr_user(),
  public.is_flow_step_approver(uuid, integer), public.flow_last_step(uuid),
  public.user_default_flow(uuid) from public, anon;
grant execute on function public.is_admin_user(), public.is_hr_user(),
  public.is_flow_step_approver(uuid, integer), public.flow_last_step(uuid),
  public.user_default_flow(uuid) to authenticated, service_role;

-- ── 1. 員工資料（users）─────────────────────────────────────────────────

-- 不能再改自己的資料。網站本來就沒有讓同仁自己改 users 的地方：
-- 切換語言走 set_my_language()（security definer，不受這條影響）；
-- 姓名、部門、權限等由管理員／HR 修改（admins_can_update_users / finance_can_update_users）。
drop policy if exists users_update_self on public.users;

-- 新的員工資料只會由「新增登入帳號」的觸發器 handle_new_user() 建立（security definer），
-- 網站和 API 都不需要直接新增。
drop policy if exists users_insert on public.users;

-- 只有登入的人讀得到員工名單
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated using (true);

-- 特休摘要檢視表：沒登入的人不能讀
revoke select on public.annual_leave_summary from anon;

-- 新帳號一律先是「員工」；角色由管理員／HR 在 manage-users 建立帳號後設定。
-- （以前取自註冊時帶的資料，等於讓註冊的人自己選角色。）
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  default_flow uuid;
begin
  select id into default_flow from public.approval_flows where is_default = true limit 1;

  insert into public.users (id, email, full_name, role, default_flow_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'employee',
    default_flow
  );
  return new;
end;
$$;

-- ── 2. 假單（leave_requests）──────────────────────────────────────────

-- 這條讓申請人和「主管」角色能改任何欄位；拿掉後：
--   申請人 → approvers_can_update_leave_requests / requester_can_acknowledge_registered_leave
--   簽核人 → approvers_can_update_leave_requests
--   HR    → finance_can_update_leave_requests
-- 各自能改哪些欄位，再由下面的觸發器把關。
drop policy if exists requests_update_own on public.leave_requests;

create or replace function public.leave_requests_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  uid uuid := auth.uid();
  changed text[];
begin
  -- 只管從網站／API 來的請求；後台程式（service role）、排程、SQL Editor 不受影響。
  -- （這個函式刻意不用 security definer，current_user 才會是呼叫者的角色。）
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- HR 照原本的規則（能新增代登、能修改；範圍由 finance_can_* 權限規則決定）
  if public.is_hr_user() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- 自己送出的假單：一律從「審核中」開始，不能自己填核准、代登、確認、異議
    if new.status is distinct from 'pending'
       or new.registered_by is not null
       or new.acknowledged_at is not null
       or new.disputed_at is not null then
      raise exception '不允許的假單內容：新送出的假單只能是審核中' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE：列出這次改了哪些欄位
  select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n
   where n.value is distinct from (to_jsonb(old) -> n.key);

  if changed = '{}' then
    return new;
  end if;

  -- (a) 當關簽核人：只能核准（最後一關）、送到下一關、駁回
  if old.status = 'pending' and public.is_flow_step_approver(old.flow_id, old.current_step) then
    if changed <@ array['current_step', 'status'] then
      -- 送到下一關
      if new.status = 'pending' and new.current_step = old.current_step + 1
         and old.current_step < public.flow_last_step(old.flow_id) then
        return new;
      end if;
      -- 最後一關核准
      if new.status = 'approved' and new.current_step = old.current_step
         and old.current_step >= public.flow_last_step(old.flow_id) then
        return new;
      end if;
      -- 駁回
      if new.status = 'rejected' and new.current_step = old.current_step then
        return new;
      end if;
    end if;
  end if;

  -- (b) 申請人本人
  if old.requester_id = uid then
    -- 撤回審核中的假單
    if changed = array['status'] and old.status = 'pending' and new.status = 'withdrawn' then
      return new;
    end if;
    -- 沒有簽核關卡的人（目前只有老闆）送出後直接核准：
    -- 假單的流程必須就是他「現在」的預設流程，而且那個流程沒有任何關卡
    if changed = array['status'] and old.status = 'pending' and new.status = 'approved'
       and old.registered_by is null
       and old.flow_id is not distinct from public.user_default_flow(uid)
       and public.flow_last_step(old.flow_id) is null then
      return new;
    end if;
    -- HR 代登的假單：只能確認或提出異議
    if old.registered_by is not null
       and changed <@ array['acknowledged_at', 'auto_acknowledged', 'disputed_at', 'dispute_reason'] then
      return new;
    end if;
  end if;

  raise exception '沒有權限修改這張假單的這些內容（%）', array_to_string(changed, ', ')
    using errcode = '42501';
end;
$$;

drop trigger if exists leave_requests_guard on public.leave_requests;
create trigger leave_requests_guard
  before insert or update on public.leave_requests
  for each row execute function public.leave_requests_guard();

-- ── 3. 審核紀錄（leave_approvals）─────────────────────────────────────

-- 只有「這張假單現在這一關的簽核人」能新增紀錄，而且關卡要對得上
drop policy if exists approvals_insert on public.leave_approvals;
create policy approvals_insert on public.leave_approvals
  for insert to authenticated
  with check (
    approver_id = auth.uid()
    and exists (
      select 1 from public.leave_requests lr
       where lr.id = leave_approvals.request_id
         and lr.status = 'pending'
         and lr.current_step = leave_approvals.step_order
         and public.is_flow_step_approver(lr.flow_id, lr.current_step)
    )
  );

-- ── 4. 通知對象（notification_targets）────────────────────────────────

-- 舊規則認 role = 'admin'（沒有人是），管理員一直寫不進去。改認「管理員」勾選框。
-- （舊規則 notif_targets_admin 留著不動：它不會讓任何人多出權限。）
drop policy if exists admins_can_manage_notification_targets on public.notification_targets;
create policy admins_can_manage_notification_targets on public.notification_targets
  for all to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());
