-- ============================================================================
-- App 推播通知＋圖示上的數字
-- ============================================================================
--
-- 使用者 2026-11 決定：
--   · 裝到手機／電腦的 App 要能「跳出通知」，App 圖示上要有數字
--   · 假單、按摩、考核三類，Slack 照發、推播也發（兩邊都發）
--   · 沒有 Slack ID 的同仁，只要有在 App 開啟通知，也收得到推播
--   · 推播金鑰（VAPID）由系統自動產生，存在只有後台讀得到的資料表，不經手任何人
--   · 圖示數字 ＝ 待我簽核的假單 ＋ 待我評分的考核 ＋ 待我填的自評 ＋ 未讀的推播
--     （「未讀的推播」記在每台裝置上，打開 App 就歸零，資料庫不需要記）
--
-- 這支做的事：
--   1. push_subscriptions：每台開啟通知的裝置一列（誰、推播網址、加密用的公鑰）
--      同仁只讀得到自己的；新增／移除一律走下面兩個函式
--   2. push_config：系統自動產生的推播金鑰，只有後台（service role）讀得到
--   3. app_badge_count()：圖示上「待處理」的數字（推播時由後台算、App 開著時由網頁算）
--   4. 考核通知的「已經通知過」記號，避免同一件事重複通知；
--      現有的考核名單一律當作「已經通知過」，這支執行後不會補發舊的通知
--
-- ⚠️ 要「先執行這支、再部署 send-push、再合併網站」。
--    執行後不會通知任何人：要等同仁自己在「設定 → App 通知」按開啟，才會收到推播。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 開啟通知的裝置 ----------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error text
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

comment on table public.push_subscriptions is
  '開啟 App 通知的裝置（2026-11）。endpoint 是瀏覽器給的推播網址，p256dh／auth 是加密推播內容用的公鑰，不是密碼。';

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

-- 開啟：同一台裝置（同一個 endpoint）以前是別人登入開的，就改成現在登入的人
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception '推播訂閱資料不完整';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_error = null;
end;
$$;

-- 關閉（或登出）：只能刪自己的
create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;


-- 2. 推播金鑰（系統自動產生，只有後台讀得到） --------------------------------------------
create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);
comment on table public.push_config is
  'App 推播的金鑰（VAPID），send-push 第一次用到時自動產生。只有後台讀得到。刪掉的話所有裝置都要重新開啟通知。';
alter table public.push_config enable row level security;   -- 不開任何規則＝網頁讀不到
revoke all on public.push_config from anon, authenticated;
grant all on public.push_config, public.push_subscriptions to service_role;   -- 後台程式（send-push）用


-- 3. 圖示上的數字 -------------------------------------------------------------------
-- 規則跟網頁上現有的數字一致：
--   待我簽核的假單：右上角鈴鐺（主管／副主管／老闆，假單目前這一關是我）
--   待我評分的考核：選單「考核管理」的紅色數字（主管／副主管／老闆，對方已交自評、輪到我這一關、週期進行中）
--   待我填的自評：我在進行中的考核名單裡、還沒送出自評
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
  -- 網頁只能查自己的；後台（沒有登入身分）可以查任何人
  if auth.uid() is not null and auth.uid() <> p_user then return 0; end if;
  select role into r from public.users where id = p_user and coalesce(is_active, true);
  if not found then return 0; end if;

  if r in ('supervisor', 'deputy_supervisor', 'boss') then
    n := n + (select count(*) from public.leave_requests lr
               where lr.status = 'pending'
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

create or replace function public.my_app_badge_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.uid() is null then 0 else public.app_badge_count(auth.uid()) end;
$$;

revoke all on function public.app_badge_count(uuid) from public, anon, authenticated;
grant execute on function public.app_badge_count(uuid) to service_role;
revoke all on function public.my_app_badge_count() from public, anon;
grant execute on function public.my_app_badge_count() to authenticated;


-- 4. 考核通知「已經通知過」的記號 ---------------------------------------------------------
alter table public.annual_review_participants
  add column if not exists invite_notified_at timestamptz,
  add column if not exists turn_notified_key text;
comment on column public.annual_review_participants.invite_notified_at is
  '已經通知本人「你被加入考核，請填自評」的時間（review-notify 寫入，避免重複通知）';
comment on column public.annual_review_participants.turn_notified_key is
  '最後一次通知評核人「輪到你評分」時的「流程:關卡」（review-notify 寫入，避免同一關重複通知）';

-- 現有的名單一律當作已經通知過：這支執行後不會補發任何舊的通知。
--   · 「請填自評」：名單上現有的人都不補發
--   · 「輪到你評分」：已經交了自評、正在等某一關評分的，那一關不補發；
--     還沒交自評的不標記 —— 他之後交出自評時，第 1 關的評核人要收到通知
update public.annual_review_participants
   set invite_notified_at = now()
 where invite_notified_at is null;
update public.annual_review_participants
   set turn_notified_key = flow_id::text || ':' || current_step::text
 where turn_notified_key is null and flow_id is not null and self_submitted;


-- ============================================================================
-- 驗收（SQL Editor 只顯示最後一段的結果）：三列都要是「是」
-- ============================================================================
select '裝置資料表已建立、網頁只讀得到自己的' as 項目,
       case when exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'push_subscriptions_select_own')
            then '是' else '否' end as 結果
union all
select '推播金鑰資料表網頁讀不到',
       case when not has_table_privilege('authenticated', 'public.push_config', 'select') then '是' else '否' end
union all
select '舊的考核名單都標成已通知（不會補發）',
       case when not exists (select 1 from public.annual_review_participants where invite_notified_at is null) then '是' else '否' end;
