-- ============================================================================
-- 離職同仁專區（第 2 階段第 5 步）
-- ============================================================================
--
-- 使用者 2026-11 決定：
--   · 刪除（停用）帳號時必填「最後工作日」（管理員與 HR 都要填）
--   · 恢復帳號時最後工作日「保留」（當作紀錄，例如離職又回任）
--   · 已經刪除的帳號由 HR 在離職同仁專區補填
--   · 特休結算 = 離職當年度的全額 − 當年度已核准的特休
--
-- 這支做兩件事：
--   1. users 加 last_working_day 欄位（管理員與 HR 原本就能改 users，不用另外開權限）
--   2. annual_leave_settlement(user_id)：算離職同仁的特休結算（只有 HR 能呼叫）
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- 需要先跑過 20261113_holidays.sql（用到 count_workdays）。
-- ============================================================================

-- 1. 最後工作日 ---------------------------------------------------------------
alter table public.users add column if not exists last_working_day date;

comment on column public.users.last_working_day is
  '最後工作日。刪除（停用）帳號時必填；恢復帳號時保留不清除（使用者決定 2026-11）。';


-- 2. 特休結算 -----------------------------------------------------------------
--   年度   = 最後工作日那一年
--   應有   = HR 手動指定的特休天數（有的話）；否則照系統的規則：
--            到最後工作日為止年資未滿 6 個月 → 0；否則依當年 12/31 的年資給全額
--            （跟 annual_leave_summary 同一個級距函式 statutory_leave_days）
--   已用   = 那一年開始的「已核准」特休（跨日假單只算上班日，扣掉國定假日）
--   剩餘   = 應有 − 已用（可能是負的：請超過）
create or replace function public.annual_leave_settlement(p_user_id uuid)
returns table (year integer, entitled numeric, used numeric, remaining numeric, is_manual boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hire date;
  v_last date;
  v_year integer;
  v_manual numeric;
  v_entitled numeric;
  v_used numeric;
begin
  if not public.is_hr_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select u.hire_date, u.last_working_day into v_hire, v_last from public.users u where u.id = p_user_id;
  if v_last is null then
    return;   -- 還沒填最後工作日：沒有結算
  end if;
  v_year := extract(year from v_last)::integer;

  select e.quota_hours / 8.0 into v_manual
    from public.user_leave_entitlements e
    join public.leave_types lt on lt.id = e.leave_type_id
   where e.user_id = p_user_id and lt.is_annual and e.mode = 'manual' and e.quota_hours is not null
   limit 1;

  v_entitled := coalesce(v_manual, case
    when v_hire is null then 0
    when age(v_last::timestamp, v_hire::timestamp) < interval '6 mons' then 0
    else public.statutory_leave_days(v_hire, make_date(v_year, 12, 31))
  end);

  select coalesce(sum(case when lr.hours is not null then lr.hours / 8.0
                           else public.count_workdays(lr.start_date, lr.end_date) end), 0)
    into v_used
    from public.leave_requests lr
    join public.leave_types lt on lt.id = lr.leave_type_id
   where lr.requester_id = p_user_id
     and lr.status = 'approved'
     and lt.is_annual
     and extract(year from lr.start_date) = v_year;

  return query select v_year, round(v_entitled, 2), round(v_used, 2), round(v_entitled - v_used, 2), v_manual is not null;
end;
$$;

revoke all on function public.annual_leave_settlement(uuid) from public;
grant execute on function public.annual_leave_settlement(uuid) to authenticated;

comment on function public.annual_leave_settlement(uuid) is
  '離職同仁的特休結算（只有 HR）：最後工作日那一年的全額（或 HR 手動指定的天數）− 當年已核准的特休。定義見 migration 20261116。';


-- 驗收：已經停用、還沒填最後工作日的帳號（請 HR 在離職同仁專區補填）
select full_name as 同仁, department as 部門, hire_date as 到職日
  from public.users
 where is_active = false and last_working_day is null
 order by full_name;
