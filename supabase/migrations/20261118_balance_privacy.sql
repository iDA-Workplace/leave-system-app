-- ============================================================================
-- 特休餘額也鎖起來（第 2 階段第 6 步的補充）
-- ============================================================================
--
-- 使用者 2026-11 決定：每個人的特休應有／已用天數（annual_leave_summary），
-- 只有「本人、直屬主管、HR」查得到。原本任何登入的人都能直接向資料庫查到全公司的餘額
-- （網頁上只顯示自己的，但技術上查得到）。
--
-- 做法跟 20261114 一樣：拿正式資料庫現在的 view 定義，只在最後的 WHERE 加一個條件，
-- 其他一個字都不動。找不到要加的地方就停下來、什麼都不改。
--
-- 沒有登入身分的查詢（Slack 查餘額、每日彙整等後台程式用的 service role，以及
-- SQL Editor）照常看得到全部：沒登入的網頁訪客（anon）本來就沒有讀這個 view 的權限
-- （20261110 已收回）。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

create or replace function public.can_view_balance(p_user uuid, p_manager uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null          -- 後台程式（service role）、SQL Editor
      or p_user = auth.uid()         -- 本人
      or p_manager = auth.uid()      -- 直屬主管
      or public.is_hr_user();        -- HR
$$;

revoke all on function public.can_view_balance(uuid, uuid) from public, anon;
grant execute on function public.can_view_balance(uuid, uuid) to authenticated, service_role;

do $$
declare
  def text := pg_get_viewdef('public.annual_leave_summary'::regclass);
  patched text;
begin
  if def like '%can_view_balance(%' then
    raise notice '特休餘額已經鎖過了，跳過。';
    return;
  end if;
  -- 定義最後是「WHERE (is_active = true);」（只有在職的人；Postgres 有時寫成 u.is_active），
  -- 在後面加上權限條件
  patched := regexp_replace(def, 'WHERE \((u\.)?is_active = true\);?\s*$',
                            'WHERE ((u.is_active = true) AND public.can_view_balance(u.id, u.manager_id))');
  if patched = def then
    raise exception '在 annual_leave_summary 裡找不到「只算在職同仁」的條件，沒有做任何修改。請把這段訊息貼給開發者。';
  end if;
  execute 'create or replace view public.annual_leave_summary as ' || patched;
end $$;


-- 驗收：要是「是」
select '特休餘額只有本人、直屬主管、HR 查得到' as 項目,
       case when pg_get_viewdef('public.annual_leave_summary'::regclass) like '%can_view_balance(%' then '是' else '否' end as 結果;
