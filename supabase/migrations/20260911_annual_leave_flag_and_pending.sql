-- 兩件事：讓「特休」不再靠名字辨識，以及把審核中的假單算進已使用天數
--
--
-- 一、為什麼不能再靠名字判斷
--
-- 系統原本有四個地方是用「假別名稱裡有沒有『特休』兩個字」來認出特休的：
--
--   · 這個 view（寫死 lt.name = '特休假'，完全比對）
--   · src/lib/leaveEntitlements.js 的 isAnnualLeaveType（name.includes('特休')）
--   · supabase/functions/slack-interactions/index.ts 兩處（同樣是 includes）
--
-- 所以只要有人到「假別名稱設定」把它改名 —— 例如改成「年假」—— 這四個地方
-- 會同時失效，而且**不會跳任何錯誤**：畫面上每個人的特休已使用會變成 0 天、
-- 額度會改用一般假別的固定值、Slack 查餘額也會算錯。假單其實都還在，只是
-- 統計抓不到。這種「壞掉但看起來正常」最難察覺。
--
-- 改法是加一個 is_annual 標記欄位，四個地方都改成看這個標記。之後不管假別
-- 要叫「特休假」「年假」還是別的，都不會再壞。
--
-- 回填的條件用 like '%特休%' 而不是等於 '特休假'，是為了涵蓋已經被改過名的
-- 情況；如果貴公司的特休假別名稱完全不含「特休」二字，回填會抓不到，請手動
-- 執行最後面附的那一行補上。
--
--
-- 二、為什麼要把 pending 算進去
--
-- 原本 used_days 只算 status = 'approved'，審核中的不算。這留下一個漏洞：
-- 同一個人可以連送好幾張假單，每一張送出的當下檢查都會過（前面幾張還在
-- 審核中、不列入計算），等主管一次全部核准就直接超額。
--
-- 其他假別沒有這個問題 —— src/lib/leaveEntitlements.js 的 fetchUsedHours
-- 本來就把 pending 一起算，註解也寫明了這是刻意的。只有特休走這個 view，
-- 才漏掉。這次把兩邊的規則對齊。
--
-- 被駁回或收回的假單狀態不是 pending，時數會自動回到可用額度，行為合理。

-- ---------------------------------------------------------------------------
-- 1. 加上標記欄位並回填
-- ---------------------------------------------------------------------------
alter table public.leave_types
  add column if not exists is_annual boolean not null default false;

comment on column public.leave_types.is_annual is
  '這個假別是不是「特休」。特休的額度依年資由 annual_leave_summary 計算，不吃 annual_quota_hours。用旗標而不是比對名稱，是為了讓假別可以自由改名而不會弄壞統計。';

update public.leave_types
   set is_annual = true
 where name like '%特休%'
   and is_annual = false;

-- ---------------------------------------------------------------------------
-- 2. 重建 view：改用旗標、並把 pending 一起算進已使用
-- ---------------------------------------------------------------------------
-- 年資基準維持「今年 1 月 1 日」（歷年制），這次沒有動計算制度本身。
-- 10 年以上的級距沿用 migration 20260911_fix_annual_leave_10year_bracket
-- 修正過的 least(年資 + 6, 30)。

create or replace view public.annual_leave_summary as
 select
    id as user_id,
    full_name,
    hire_date,
    extract(year from current_date)::integer as year,
    extract(year from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_years,
    extract(month from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_months,
    extract(day from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_days,
    case
        when hire_date is null then 0
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '6 mons'::interval then 0
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '1 year'::interval then 3
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '2 years'::interval then 7
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '3 years'::interval then 10
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '5 years'::interval then 14
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '10 years'::interval then 15
        else least(extract(year from age(date_trunc('year'::text, current_date::timestamp with time zone), hire_date::timestamp with time zone))::integer + 6, 30)
    end as entitled_days,
    coalesce(( select sum(
                case
                    when lr.hours is not null then lr.hours / 8.0
                    else ( select count(*)::numeric as count
                       from generate_series(lr.start_date::timestamp with time zone, lr.end_date::timestamp with time zone, '1 day'::interval) d(d)
                      where extract(dow from d.d) <> all (array[0::numeric, 6::numeric]))
                end) as sum
           from leave_requests lr
             join leave_types lt on lt.id = lr.leave_type_id
          where lr.requester_id = u.id
            -- ↓ 這次改的兩個地方：審核中的也算，以及用旗標取代名稱比對
            and lr.status in ('approved', 'pending')
            and lt.is_annual
            and extract(year from lr.start_date) = extract(year from current_date)), 0::numeric) as used_days
   from users u
  where is_active = true;

comment on view public.annual_leave_summary is
  '每位在職員工今年的特休額度與已使用天數。歷年制：額度依「今年 1/1 為止的年資」對照勞基法第 38 條級距決定；已使用天數統計當年 1/1~12/31、狀態為已核准或審核中的特休假單（特休假別以 leave_types.is_annual 辨識，不是比對名稱）。定義見 migration 20260911。';

-- ---------------------------------------------------------------------------
-- 回填沒抓到的話，手動把正確的假別標起來（把 id 換成實際的值再執行）：
--
--   update public.leave_types set is_annual = true where id = '<特休假別的 id>';
--
-- 確認目前標了哪些：
--
--   select id, name, is_annual from public.leave_types order by name;
-- ---------------------------------------------------------------------------
