-- ============================================================================
-- 職務代理人「必填」＋「代理人先審批」（2026-11 使用者決定）
-- ============================================================================
--
-- 流程：A 請假、填 B 當職務代理人 → 送出後 B 先確認 →
--   · B 同意代理：再走 A 原本的簽核流程（主管 → 老闆…）。流程沒有任何關卡的人（老闆），
--     B 同意後就直接核准。
--   · B 不能代理：一定要寫原因；假單「退回」給 A，A 換一位代理人後重新送出。
--
-- 使用者決定的細節：
--   · 職務代理人必填（在家工作 WFH 也要），不能是自己、要是在職同仁
--   · 代理人審批時只看得到「誰、哪天、什麼假、幾點、幾小時」，看不到事由與附件（維持原本的隱私規則）
--   · HR 代同仁登記的假單維持現狀：代理人可填可不填、不用代理人審批
--   · 代理人在 Slack 私訊按鈕、或網頁首頁審批；最後核准時照樣通知代理人
--
-- 這支做的事：
--   1. leave_requests 加 proxy_status（pending 待代理人確認／approved 已同意／rejected 不能代理）、
--      proxy_decided_at、proxy_comment
--   2. 新增假單時：同仁自己送的一律要有代理人，代理人那一關從「待確認」開始
--   3. 簽核人只有在代理人同意之後才能核准／駁回（修改 leave_requests_guard 與簽核紀錄的規則）
--   4. proxy_decide()：代理人同意／不能代理（網頁用）；proxy_decide_as()：Slack 後台用
--   5. my_proxy_requests()：「待我確認的代理」清單（只給基本欄位）
--   6. 圖示數字、鈴鐺：多算「待我確認的代理」，簽核數不算還在等代理人的假單
--
-- 已經送出的舊假單（proxy_status 是空的）照原本的方式走，不受影響。
--
-- ⚠️ 要「先執行這支、再部署 function、再合併網站」：執行後舊版網站送出沒填代理人的假單會被擋
--    （系統 2027/1/1 才開放請假，目前沒有人在送假單，影響很小）。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 欄位 ---------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists proxy_status text,
  add column if not exists proxy_decided_at timestamptz,
  add column if not exists proxy_comment text,
  add column if not exists returned_at timestamptz,      -- 正式資料庫早就有（逾期退回用），這裡只是保險
  add column if not exists returned_reason text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leave_requests_proxy_status_check') then
    alter table public.leave_requests add constraint leave_requests_proxy_status_check
      check (proxy_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

comment on column public.leave_requests.proxy_status is
  '職務代理人確認狀態（2026-11）：pending 待代理人確認、approved 已同意、rejected 不能代理（假單退回）。空的＝不用代理人確認（舊假單、HR 代登）。';
comment on column public.leave_requests.proxy_comment is '代理人回覆的說明（不能代理時必填的原因）';


-- 2. 新增假單：代理人必填、從「待代理人確認」開始 ------------------------------------------
create or replace function public.leave_requests_proxy_init()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- HR 代登（維持現狀：代理人可填可不填、不用代理人審批），以及不是「審核中」的資料（例如匯入）
  if new.registered_by is not null or new.status is distinct from 'pending' then
    new.proxy_status := null;
    return new;
  end if;
  if new.proxy_user_id is null then
    raise exception 'proxy_required: 請選擇職務代理人' using errcode = 'P0001';
  end if;
  if new.proxy_user_id = new.requester_id then
    raise exception 'proxy_self: 職務代理人不能是自己' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.users where id = new.proxy_user_id and coalesce(is_active, true)) then
    raise exception 'proxy_inactive: 這位職務代理人的帳號已停用，請換一位' using errcode = 'P0001';
  end if;
  new.proxy_status := 'pending';
  new.proxy_decided_at := null;
  new.proxy_comment := null;
  return new;
end;
$$;

drop trigger if exists leave_requests_proxy_init on public.leave_requests;
create trigger leave_requests_proxy_init
  before insert on public.leave_requests
  for each row execute function public.leave_requests_proxy_init();


-- 3. 簽核人要等代理人同意後才能動作 ------------------------------------------------------
-- 跟 20261110 的 leave_requests_guard 一字不差，只在 (a) 簽核人、(b) 沒有關卡的本人直接核准
-- 兩處多一個條件：proxy_status 不是「待代理人確認」。
create or replace function public.leave_requests_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  uid uuid := auth.uid();
  changed text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if public.is_hr_user() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'
       or new.registered_by is not null
       or new.acknowledged_at is not null
       or new.disputed_at is not null then
      raise exception '不允許的假單內容：新送出的假單只能是審核中' using errcode = '42501';
    end if;
    return new;
  end if;

  select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n
   where n.value is distinct from (to_jsonb(old) -> n.key);

  if changed = '{}' then
    return new;
  end if;

  -- (a) 當關簽核人：只能核准（最後一關）、送到下一關、駁回 —— 代理人還沒同意之前不行
  if old.status = 'pending' and old.proxy_status is distinct from 'pending'
     and public.is_flow_step_approver(old.flow_id, old.current_step) then
    if changed <@ array['current_step', 'status'] then
      if new.status = 'pending' and new.current_step = old.current_step + 1
         and old.current_step < public.flow_last_step(old.flow_id) then
        return new;
      end if;
      if new.status = 'approved' and new.current_step = old.current_step
         and old.current_step >= public.flow_last_step(old.flow_id) then
        return new;
      end if;
      if new.status = 'rejected' and new.current_step = old.current_step then
        return new;
      end if;
    end if;
  end if;

  -- (b) 申請人本人
  if old.requester_id = uid then
    if changed = array['status'] and old.status = 'pending' and new.status = 'withdrawn' then
      return new;
    end if;
    if changed = array['status'] and old.status = 'pending' and new.status = 'approved'
       and old.registered_by is null
       and old.proxy_status is distinct from 'pending'
       and old.flow_id is not distinct from public.user_default_flow(uid)
       and public.flow_last_step(old.flow_id) is null then
      return new;
    end if;
    if old.registered_by is not null
       and changed <@ array['acknowledged_at', 'auto_acknowledged', 'disputed_at', 'dispute_reason'] then
      return new;
    end if;
  end if;

  raise exception '沒有權限修改這張假單的這些內容（%）', array_to_string(changed, ', ')
    using errcode = '42501';
end;
$$;

drop policy if exists approvals_insert on public.leave_approvals;
create policy approvals_insert on public.leave_approvals
  for insert to authenticated
  with check (
    approver_id = auth.uid()
    and exists (
      select 1 from public.leave_requests lr
       where lr.id = leave_approvals.request_id
         and lr.status = 'pending'
         and lr.proxy_status is distinct from 'pending'
         and lr.current_step = leave_approvals.step_order
         and public.is_flow_step_approver(lr.flow_id, lr.current_step)
    )
  );


-- 4. 代理人同意／不能代理 ----------------------------------------------------------------
-- 回傳：approved（同意，接著走簽核流程）、approved_final（同意，流程沒有關卡＝直接核准）、
--       returned（不能代理，假單退回）、reason_required、not_found、not_proxy、already_handled
create or replace function public.proxy_decide_as(p_actor uuid, p_request uuid, p_approve boolean, p_comment text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.leave_requests%rowtype;
  c text := nullif(trim(coalesce(p_comment, '')), '');
begin
  select * into r from public.leave_requests where id = p_request for update;
  if not found then return 'not_found'; end if;
  if r.proxy_user_id is distinct from p_actor then return 'not_proxy'; end if;
  if r.status <> 'pending' or r.proxy_status is distinct from 'pending' then return 'already_handled'; end if;

  if p_approve then
    if public.flow_last_step(r.flow_id) is null then
      update public.leave_requests
         set proxy_status = 'approved', proxy_decided_at = now(), proxy_comment = c, status = 'approved'
       where id = r.id;
      return 'approved_final';
    end if;
    update public.leave_requests
       set proxy_status = 'approved', proxy_decided_at = now(), proxy_comment = c
     where id = r.id;
    return 'approved';
  end if;

  if c is null then return 'reason_required'; end if;
  update public.leave_requests
     set proxy_status = 'rejected', proxy_decided_at = now(), proxy_comment = c,
         status = 'returned', returned_at = now(), returned_reason = c
   where id = r.id;
  return 'returned';
end;
$$;

create or replace function public.proxy_decide(p_request uuid, p_approve boolean, p_comment text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  return public.proxy_decide_as(auth.uid(), p_request, p_approve, p_comment);
end;
$$;

revoke all on function public.proxy_decide_as(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.proxy_decide_as(uuid, uuid, boolean, text) to service_role;
revoke all on function public.proxy_decide(uuid, boolean, text) from public, anon;
grant execute on function public.proxy_decide(uuid, boolean, text) to authenticated;


-- 5. 待我確認的代理（只給基本欄位：看不到事由與附件） --------------------------------------
create or replace function public.my_proxy_requests()
returns table (
  id uuid,
  requester_name text,
  leave_type_name text,
  leave_type_name_en text,
  start_date date,
  end_date date,
  start_time text,
  end_time text,
  hours numeric,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select lr.id, u.full_name, lt.name, lt.name_en,
         lr.start_date, coalesce(lr.end_date, lr.start_date),
         lr.start_time::text, lr.end_time::text, lr.hours, lr.created_at
    from public.leave_requests lr
    join public.users u on u.id = lr.requester_id
    left join public.leave_types lt on lt.id = lr.leave_type_id
   where auth.uid() is not null
     and lr.proxy_user_id = auth.uid()
     and lr.status = 'pending'
     and lr.proxy_status = 'pending'
   order by lr.start_date, lr.created_at;
$$;

revoke all on function public.my_proxy_requests() from public, anon;
grant execute on function public.my_proxy_requests() to authenticated;


-- 6. 圖示數字：多算「待我確認的代理」；簽核數不算還在等代理人的假單 -------------------------
create or replace function public.app_badge_count(p_user uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r text;
  n int := 0;
begin
  if auth.uid() is not null and auth.uid() <> p_user then return 0; end if;
  select role into r from public.users where id = p_user and coalesce(is_active, true);
  if not found then return 0; end if;

  -- 待我確認的代理（每個人都可能是代理人）
  n := n + (select count(*) from public.leave_requests lr
             where lr.proxy_user_id = p_user and lr.status = 'pending' and lr.proxy_status = 'pending');

  if r in ('supervisor', 'deputy_supervisor', 'boss') then
    n := n + (select count(*) from public.leave_requests lr
               where lr.status = 'pending'
                 and lr.proxy_status is distinct from 'pending'
                 and exists (select 1 from public.approval_flow_steps s
                              where s.flow_id = lr.flow_id and s.step_order = lr.current_step
                                and s.approver_id = p_user));
    n := n + (select count(*) from public.annual_review_participants p
                join public.annual_reviews rv on rv.id = p.review_id
               where rv.status = 'active'
                 and p.self_submitted and not coalesce(p.supervisor_submitted, false)
                 and exists (select 1 from public.review_flow_steps s
                              where s.flow_id = p.flow_id and s.step_order = p.current_step
                                and s.evaluator_id = p_user));
  end if;

  n := n + (select count(*) from public.annual_review_participants p
              join public.annual_reviews rv on rv.id = p.review_id
             where p.user_id = p_user and rv.status = 'active'
               and not coalesce(p.self_submitted, false));
  return n;
end;
$$;

revoke all on function public.app_badge_count(uuid) from public, anon, authenticated;
grant execute on function public.app_badge_count(uuid) to service_role;


-- ============================================================================
-- 驗收：三列都要是「是」
-- ============================================================================
select '假單有代理人確認欄位' as 項目,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'leave_requests' and column_name = 'proxy_status')
            then '是' else '否' end as 結果
union all
select '送出假單時代理人必填、從待代理人確認開始',
       case when exists (select 1 from pg_trigger where tgname = 'leave_requests_proxy_init') then '是' else '否' end
union all
select '代理人審批用的函式已建立',
       case when to_regprocedure('public.proxy_decide(uuid, boolean, text)') is not null
             and to_regprocedure('public.my_proxy_requests()') is not null then '是' else '否' end;
