-- ============================================================================
-- 國定假日（第 2 階段第 3 步）—— 第 1 份，共 2 份
-- ============================================================================
--
-- 使用者決定（2026-11）：
--   · 依行政院人事行政總處的「政府行政機關辦公日曆表」
--   · 公司不補班：政府的補班週六照樣不上班；「調整放假」的日子公司照放
--     → 只記「週一～週五、日曆上是放假」的日子；週末本來就不上班，不用記
--   · 管理員與 HR 都能「匯入」；新增、修改、刪除假日只有 HR
--   · 全系統計算請假天數都扣掉假日；整張假單都落在假日（或週末）的不能送出
--   · 上線前先列出受影響的假單給使用者看
--
-- 這一份只做「準備」，跑完網站與特休餘額的算法都還不會變：
--   1. 建 holidays 資料表與權限
--   2. 建 is_workday() / count_workdays() 兩個共用函式
--   3. 預先放入 2026、2027 年的假日（使用者 2026-11 提供的人事行政總處官方檔案）
--
-- 跑完這份之後：
--   → 跑 ../maintenance/holiday_impact_preview.sql 看哪些現有假單的天數會變
--   → 確認後再跑第 2 份 20261114_holidays_go_live.sql（特休餘額改成扣假日、擋下整張落在假日的假單）
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 假日資料表 ---------------------------------------------------------------
create table if not exists public.holidays (
  date        date primary key,
  name        text not null default '',
  -- false = HR 刪掉的（保留這一列當作記號，之後自動匯入才不會又把它加回來）
  is_holiday  boolean not null default true,
  source      text not null default 'manual' check (source in ('dgpa', 'manual')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null
);

comment on table public.holidays is
  '公司的國定假日（只記週一～週五）。來源：人事行政總處辦公日曆（source=dgpa）或 HR 手動（manual）。'
  'is_holiday=false 表示 HR 刪掉的日子，保留這一列，自動匯入才不會加回來。定義見 migration 20261113。';

alter table public.holidays enable row level security;

-- 每個登入的人都要讀得到（請假表單要算天數）
drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays
  for select to authenticated using (true);

-- 新增、修改、刪除：只有 HR。匯入走 Edge Function（import-holidays），用後台身分寫入，
-- 管理員與 HR 都能按「匯入」（使用者決定）。
drop policy if exists holidays_hr_write on public.holidays;
create policy holidays_hr_write on public.holidays
  for all to authenticated
  using (public.is_hr_user())
  with check (public.is_hr_user());

grant select on public.holidays to authenticated;
grant insert, update, delete on public.holidays to authenticated;
revoke all on public.holidays from anon;


-- 2. 共用函式 -----------------------------------------------------------------
-- 上班日 = 週一～週五，而且不是假日
create or replace function public.is_workday(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select extract(isodow from p_date) < 6
     and not exists (select 1 from public.holidays h where h.date = p_date and h.is_holiday);
$$;

-- 起訖日期之間有幾個上班日（含頭尾）
create or replace function public.count_workdays(p_start date, p_end date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from generate_series(p_start, coalesce(p_end, p_start), interval '1 day') d
   where public.is_workday(d::date);
$$;

revoke all on function public.is_workday(date), public.count_workdays(date, date) from public;
grant execute on function public.is_workday(date), public.count_workdays(date, date)
  to authenticated, service_role;


-- 3. 2026、2027 年的假日（人事行政總處官方檔案，週一～週五、是否放假 = 2）---------
--    已經有的日期不動（HR 改過名稱或刪掉的會保留 HR 的版本）
insert into public.holidays (date, name, source) values
  ('2026-01-01', '開國紀念日', 'dgpa'),
  ('2026-02-16', '農曆除夕', 'dgpa'),
  ('2026-02-17', '春節', 'dgpa'),
  ('2026-02-18', '春節', 'dgpa'),
  ('2026-02-19', '春節', 'dgpa'),
  ('2026-02-20', '補假', 'dgpa'),
  ('2026-02-27', '補假', 'dgpa'),
  ('2026-04-03', '補假', 'dgpa'),
  ('2026-04-06', '補假', 'dgpa'),
  ('2026-05-01', '勞動節', 'dgpa'),
  ('2026-06-19', '端午節', 'dgpa'),
  ('2026-09-25', '中秋節', 'dgpa'),
  ('2026-09-28', '孔子誕辰紀念日/教師節', 'dgpa'),
  ('2026-10-09', '補假', 'dgpa'),
  ('2026-10-26', '補假', 'dgpa'),
  ('2026-12-25', '行憲紀念日', 'dgpa'),
  ('2027-01-01', '開國紀念日', 'dgpa'),
  ('2027-02-04', '小年夜', 'dgpa'),
  ('2027-02-05', '農曆除夕', 'dgpa'),
  ('2027-02-08', '春節', 'dgpa'),
  ('2027-02-09', '補假', 'dgpa'),
  ('2027-02-10', '補假', 'dgpa'),
  ('2027-03-01', '補假', 'dgpa'),
  ('2027-04-05', '清明節', 'dgpa'),
  ('2027-04-06', '補假', 'dgpa'),
  ('2027-04-30', '補假', 'dgpa'),
  ('2027-06-09', '端午節', 'dgpa'),
  ('2027-09-15', '中秋節', 'dgpa'),
  ('2027-09-28', '孔子誕辰紀念日/教師節', 'dgpa'),
  ('2027-10-11', '補假', 'dgpa'),
  ('2027-10-25', '臺灣光復暨金門古寧頭大捷紀念日', 'dgpa'),
  ('2027-12-24', '補假', 'dgpa'),
  ('2027-12-31', '補假', 'dgpa')
on conflict (date) do nothing;


-- 驗收：2026、2027 各有幾天假日（應該是 16、17）
select extract(year from date)::int as 年度, count(*) filter (where is_holiday) as 假日天數
  from public.holidays group by 1 order by 1;
