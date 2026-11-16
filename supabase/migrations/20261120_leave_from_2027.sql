-- ============================================================================
-- 只能請 2027/1/1 以後的假（2026-11 使用者決定）
-- ============================================================================
--
-- 請假紀錄要以「整個年度」統計，系統從 2027 年度正式啟用：
--   · 假期的開始日期必須在 2027/1/1（含）以後
--   · 2026 年的假「永遠」不能請，1/1 之後也不能補請
--   · 所有入口都擋：同仁自己請（網頁、Slack）、HR 代登記、HR 修改日期
--   · 不需要開關、1/1 也不用做任何事：2027 之後的假本來就符合規則
--   · 按摩預約不受影響
--
-- 已經在資料庫裡的 2026 假單（測試資料）不受影響：核准、退回、撤回、確認都照常，
-- 只有「新增」或「改日期」才檢查。網站與 Slack 會先擋並給清楚的訊息，這裡是最後一道關。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================

-- 開放請假的第一天（改這裡的話，網站 src/lib/leavePolicy.js、Slack 的 slack-interactions 也要一起改）
create or replace function public.leave_open_from()
returns date
language sql
immutable
as $$ select date '2027-01-01' $$;

grant execute on function public.leave_open_from() to authenticated, service_role;

create or replace function public.leave_requests_from_open_date()
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
  if new.start_date is not null and new.start_date < public.leave_open_from() then
    raise exception 'leave_before_open_date: 系統從 % 起開放請假，這之前的假請用原本的方式申請',
      to_char(public.leave_open_from(), 'YYYY/MM/DD')
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists leave_requests_from_open_date on public.leave_requests;
create trigger leave_requests_from_open_date
  before insert or update of start_date, end_date on public.leave_requests
  for each row execute function public.leave_requests_from_open_date();


-- 驗收：要是「是」
select '只能請 2027/1/1 以後的假（新增與修改日期）' as 項目,
       case when exists (select 1 from pg_trigger where tgname = 'leave_requests_from_open_date') then '是' else '否' end as 結果;
