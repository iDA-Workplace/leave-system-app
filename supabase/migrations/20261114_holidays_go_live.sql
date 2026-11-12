-- ============================================================================
-- 國定假日（第 2 階段第 3 步）—— 第 2 份，共 2 份：正式啟用
-- ============================================================================
--
-- 先跑過 20261113_holidays.sql，也看過 ../maintenance/holiday_impact_preview.sql
-- 列出的受影響假單，確認沒問題再跑這份。跑完之後：
--   1. 特休「已用天數」（annual_leave_summary）跨日假單改成只算上班日（扣掉國定假日）
--   2. 整張都落在假日（國定假日或週末）的假單不能送出，也不能把日期改成這樣
--      （網頁、Slack、HR 代登、HR 修改都擋）
--
-- 這份跑完要接著：部署新版 Edge Functions、合併網站（順序見 README）。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 特休已用天數：週一～週五 → 上班日（扣掉假日） --------------------------------
--
-- 為什麼不是整個 view 重寫：正式資料庫的 annual_leave_summary 改過好幾版（20260911
-- 有三份），repo 裡看不出正式環境最後是哪一版。重寫有可能把別的規則改回舊版。
-- 所以這裡拿「正式資料庫現在的定義」，只把「不是週六日」那一個條件換成
-- public.is_workday()，其他一個字都不動。找不到那個條件就停下來、什麼都不改。
do $$
declare
  def text := pg_get_viewdef('public.annual_leave_summary'::regclass);
  pattern text := 'EXTRACT\(dow FROM d\.d\) <> ALL \(ARRAY\[\(0\)::numeric, \(6\)::numeric\]\)';
  patched text;
begin
  if def like '%is_workday(%' then
    raise notice '特休已用天數已經是扣假日的版本，跳過。';
    return;
  end if;
  patched := regexp_replace(def, pattern, 'public.is_workday((d.d)::date)', 'g');
  if patched = def then
    raise exception '在 annual_leave_summary 裡找不到「排除週六日」的條件，沒有做任何修改。請把這段訊息貼給開發者。';
  end if;
  execute 'create or replace view public.annual_leave_summary as ' || patched;
end $$;

comment on view public.annual_leave_summary is
  '每位在職員工今年的特休額度與已使用天數。跨日假單的已使用天數只算上班日（週一～週五且不是 holidays 裡的國定假日，見 is_workday()，migration 20261114）。其餘規則見 migration 20260911。';


-- 2. 整張都落在假日（或週末）的假單不能送出、也不能改成這樣 ---------------------
--    網頁、Slack、HR 代登、HR 修改都會先檢查並顯示說明；這裡是最後一道防線（後台程式也擋）。
--    新增一律檢查；修改只在「日期有變」的時候檢查 —— 已經存在、剛好落在假日的舊假單
--    照樣能核准、撤回、確認（不會因為別的欄位變動被擋住）。
create or replace function public.leave_requests_not_all_holiday()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.start_date is not distinct from old.start_date
     and new.end_date is not distinct from old.end_date then
    return new;
  end if;
  if new.start_date is not null
     and public.count_workdays(new.start_date, coalesce(new.end_date, new.start_date)) = 0 then
    raise exception 'leave_on_holiday: 選的日期都是假日（國定假日或週末），不用請假'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists leave_requests_not_all_holiday on public.leave_requests;
create trigger leave_requests_not_all_holiday
  before insert or update of start_date, end_date on public.leave_requests
  for each row execute function public.leave_requests_not_all_holiday();


-- 驗收：兩列都要是「是」
select '特休已用天數已改成扣假日' as 項目,
       case when pg_get_viewdef('public.annual_leave_summary'::regclass) like '%is_workday(%' then '是' else '否' end as 結果
union all
select '擋下整張落在假日的假單（新增與修改日期）',
       case when exists (select 1 from pg_trigger where tgname = 'leave_requests_not_all_holiday') then '是' else '否' end;
