-- 特休改成「該年度跨進哪個級距，就給該級距的全額天數」
--
--
-- 公司實際的制度（2026-09 向人資確認）
--
-- 以 2025/4/28 到職的同仁為例：
--   · 114 年度（2025）：滿 6 個月給 3 天，在職至 114/10/28 後給予，計算至 12/31
--   · 115 年度（2026）：給 7 天
--   · 若當年度離職，才改依勞動部的年假系統按比例結算
--
-- 也就是說：**只要在該年度內跨進某個級距，就給那個級距的全額天數，不打折**。
-- 2026 年他是在 4/28 才滿一年，但整個 2026 年度就是給滿 7 天。
--
-- 離職結算那段是人資在離職當下另外處理的事，跟平常畫面上要顯示的額度無關，
-- 系統不需要處理。
--
--
-- 所以判斷基準是「年底」，不是「年初」
--
-- 舊的寫法看的是 1/1 當天的年資（date_trunc('year', current_date)），年中才
-- 跨級距的人整年都被鎖在舊級距 —— 上面那位同仁 2026 年只會拿到 3 天。
--
-- 改成看 **12/31 當天的年資**：那一天的年資就是他在這個年度內達到的最高級距，
-- 給那個級距的全額，正好就是公司的規則。
--
--
-- 另外一個條件：到職未滿 6 個月不給
--
-- 人資特別註明「在職至 114/10/28 後給予」，也就是到職當年要**實際滿 6 個月**
-- 才取得特休，不能從 1/1 就先預支。所以額外加一道判斷：以**今天**的年資來看，
-- 還沒滿 6 個月的人一律 0 天。
--
-- 這道判斷只會影響到職第一年的人（第二年之後年資必定超過 6 個月），
-- 對其他同仁沒有任何作用。
--
--
-- 跟「歷年制按比例」的差別
--
-- 純按比例的算法（一年之中跨級距時依天數加權）會算出 5.71 天，比公司政策的
-- 7 天少。公司這個做法比按比例更寬鬆，法規上沒有問題（不得低於勞基法標準，
-- 給更多是可以的）。這也是為什麼這支 migration 不採按比例。

-- ---------------------------------------------------------------------------
-- 1. 勞基法第 38 條級距：某人在某一天應有的特休天數
-- ---------------------------------------------------------------------------
-- 抽成函式，view 裡不必把同一串 case 寫兩次，法規真的修了也只要改一個地方。
-- 標成 stable 而不是 immutable，因為 age() 會受時區設定影響。

create or replace function public.statutory_leave_days(p_hire_date date, p_at_date date)
returns integer
language sql
stable
as $$
  select case
    when p_hire_date is null      then 0
    when p_at_date < p_hire_date  then 0   -- 還沒到職
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '6 mons'::interval  then 0
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '1 year'::interval  then 3
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '2 years'::interval then 7
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '3 years'::interval then 10
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '5 years'::interval then 14
    when age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone) < '10 years'::interval then 15
    -- 十年以上，每一年加給一日，加至三十日為止。基準是「滿 9 年」對應的
    -- 15 日，所以滿 N 年（N≥10）應得 15 + (N-9) = N + 6 日。
    else least(extract(year from age(p_at_date::timestamp with time zone, p_hire_date::timestamp with time zone))::integer + 6, 30)
  end;
$$;

comment on function public.statutory_leave_days(date, date) is
  '勞基法第 38 條特別休假級距：給到職日與某一個日期，回傳那一天該員工應有的特休天數。';

-- ---------------------------------------------------------------------------
-- 2. view 改用「年底級距」
-- ---------------------------------------------------------------------------
create or replace view public.annual_leave_summary as
 select
    u.id as user_id,
    u.full_name,
    u.hire_date,
    extract(year from current_date)::integer as year,
    extract(year from age(current_date::timestamp with time zone, u.hire_date::timestamp with time zone))::integer as service_years,
    extract(month from age(current_date::timestamp with time zone, u.hire_date::timestamp with time zone))::integer as service_months,
    extract(day from age(current_date::timestamp with time zone, u.hire_date::timestamp with time zone))::integer as service_days,
    case
      when u.hire_date is null then 0
      -- 到職未滿 6 個月還沒取得特休（以今天判斷，不是以年底）
      when age(current_date::timestamp with time zone, u.hire_date::timestamp with time zone) < '6 mons'::interval then 0
      -- 否則給「12/31 當天的年資」所對應級距的全額天數
      else public.statutory_leave_days(
             u.hire_date,
             (date_trunc('year', current_date) + '1 year'::interval - '1 day'::interval)::date
           )
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
            and lr.status in ('approved', 'pending')
            and lt.is_annual
            and extract(year from lr.start_date) = extract(year from current_date)), 0::numeric) as used_days
   from users u
  where u.is_active = true;

comment on view public.annual_leave_summary is
  '每位在職員工今年的特休額度與已使用天數。額度規則：以 12/31 當天的年資對照勞基法第 38 條級距，給該級距的全額天數（該年度跨進哪一級就給哪一級，不按比例）；但到職未滿 6 個月者為 0。已使用天數統計當年 1/1~12/31、狀態為已核准或審核中的特休假單（以 leave_types.is_annual 辨識假別）。定義見 migration 20260911。';
