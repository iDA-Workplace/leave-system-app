-- HR 代同仁登記請假，同仁事後確認
--
--
-- 要解決的問題
--
-- 有些人臨時請假是直接口頭告訴 HR，HR 請他自己補假單，但同仁常常忘記補。
-- 結果結算的時候那幾天沒被算到，該扣的沒扣，對有乖乖補假單的人不公平。
--
-- 做法：把「建立假單」這件事的責任從「會忘記的人」移到「真正在乎這件事的
-- 人」身上 —— HR 直接代為登記，同仁的角色從「要記得做一件事」變成「確認
-- 一件已經做好的事」。這個差別在實務上很大。
--
--
-- 三個設計決定（2026-09 與使用者確認）
--
-- 1. 代登記的假單「不走主管簽核，直接核准」。這種假已經請完了（人真的沒來、
--    HR 也知道），再送給主管核准有點倒因為果，而且主管沒按就永遠卡住。
--
-- 2. 同仁 3 天內沒按確認，「自動視同確認」，並且再發一則通知留下紀錄。
--    通知文字會明寫「3 天內未確認視同確認」，避免事後爭議 —— 這是使用者
--    特別要求的重點。
--
-- 3. 入口放在現有的「假單管理」頁面，HR 多一顆「代同仁登記請假」按鈕。
--
--
-- 為什麼確認狀態要獨立於 status
--
-- status 講的是「這張假單的簽核走到哪」（pending/approved/rejected…），
-- 確認講的是「當事人知不知道這件事」。兩件事互相獨立：代登記的假單一建立
-- 就是 approved，但還沒被確認。硬塞進 status 會讓原本的簽核邏輯全部要改，
-- 而且語意也不對。

-- ---------------------------------------------------------------------------
-- 1. 欄位
-- ---------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists registered_by uuid references public.users(id),
  add column if not exists ack_deadline timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists auto_acknowledged boolean not null default false;

comment on column public.leave_requests.registered_by is
  'NULL＝同仁自己送的假單。有值＝這張是 HR 代為登記的，值是登記者的 user id。';
comment on column public.leave_requests.ack_deadline is
  '代登記假單的確認期限。過了這個時間還沒確認，daily-leave-job 會自動視同確認。只有代登記的假單才有值。';
comment on column public.leave_requests.acknowledged_at is
  '同仁確認的時間。NULL＝還沒確認。自動視同確認時也會填上當下時間，並把 auto_acknowledged 設為 true。';
comment on column public.leave_requests.auto_acknowledged is
  'true＝這筆的確認是逾期自動生效的，不是同仁本人按的。查爭議時要分得出來。';

-- 撈「還沒確認、已經逾期」的那幾筆時會用到（排程每天掃一次）
create index if not exists leave_requests_pending_ack_idx
  on public.leave_requests (ack_deadline)
  where acknowledged_at is null and registered_by is not null;

-- ---------------------------------------------------------------------------
-- 2. 權限：HR 可以幫別人建立假單
-- ---------------------------------------------------------------------------
-- 原本的 insert 政策只允許「requester_id = 自己」，所以 HR 代別人建立會被擋。
-- 這裡additive 加一條，只放行 is_finance 的人，而且必須把 registered_by 填成
-- 自己 —— 不准匿名代登記，出事要查得到是誰登的。
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leave_requests'
      and policyname = 'finance_can_register_leave_for_others'
  ) then
    create policy finance_can_register_leave_for_others
      on public.leave_requests for insert
      to authenticated
      with check (
        registered_by = auth.uid()
        and exists (select 1 from public.users u where u.id = auth.uid() and u.is_finance)
      );
  end if;
end $$;

-- 同仁要能把自己那張代登記假單標記成已確認。
-- 原本的 update 政策是給「申請人本人」與「簽核人」用的，語意不同，這裡另外加。
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leave_requests'
      and policyname = 'requester_can_acknowledge_registered_leave'
  ) then
    create policy requester_can_acknowledge_registered_leave
      on public.leave_requests for update
      to authenticated
      using (requester_id = auth.uid() and registered_by is not null)
      with check (requester_id = auth.uid() and registered_by is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 確認設定正確：
--
--   select id, requester_id, registered_by, ack_deadline, acknowledged_at,
--          auto_acknowledged, status
--     from public.leave_requests
--    where registered_by is not null
--    order by created_at desc;
--
-- 還沒被確認、而且已經逾期的（排程會處理這些）：
--
--   select count(*) from public.leave_requests
--    where registered_by is not null
--      and acknowledged_at is null
--      and ack_deadline < now();
-- ---------------------------------------------------------------------------
