-- 修正特休年資滿 10 年以上少給一天的問題
--
-- 勞基法第 38 條：「十年以上者，每一年加給一日，加至三十日為止。」
-- 起算基準是「五年以上十年未滿」那一級的 15 日，所以滿 10 年當下就是
-- 15 + 1 = 16 日，不是 15 日。勞動部的日數表也是這樣列的。
--
-- 原本的寫法是：
--     least(15 + 年資 - 10, 30)
-- 這在滿 10 年時算出 15，整整比法定少一天，而且一路少到 24 年
-- （24 年法定 30 日，原式只給 29）。25 年以上因為都撞到 30 日上限，
-- 才又對上。換句話說，年資 10～24 年的同仁每人每年被少給一天特休。
--
-- 正確的寫法是：
--     least(年資 + 6, 30)
-- 因為 15 日的基準對應的是「滿 9 年」，滿 N 年（N ≥ 10）應得
-- 15 + (N - 9) = N + 6 日。驗算：10 年→16、11 年→17、15 年→21、
-- 24 年→30、25 年以上→30（封頂）。
--
-- 其餘五個級距（未滿 6 個月、6 個月～1 年、1～2 年、2～3 年、3～5 年、
-- 5～10 年）本來就與勞基法一致，這次完全沒有動，改完前後算出來的天數
-- 一模一樣。
--
--
-- ⚠️ 這支 migration 同時做了另一件事：把這個 view 的定義納入版本控制。
--
-- annual_leave_summary 是在這個專案開始用 migration 追蹤變更「之前」就
-- 直接建在資料庫裡的，所以它的定義從來沒有出現在 repo 裡 —— 也就是說，
-- 過去不管誰檢查程式碼，都看不到這段最關鍵的特休計算邏輯，這正是這個
-- 錯誤一直沒被發現的原因。之後要再改特休規則，改這個檔案就好，不要再
-- 直接去資料庫動 view，否則下一個人一樣會看不到。
--
--
-- 以下是完整定義，除了上面說的那一支 else 之外，與原本的 view 逐字相同。
-- 用 create or replace 而不是 drop + create，這樣相依的權限設定不會掉。

create or replace view public.annual_leave_summary as
 select
    id as user_id,
    full_name,
    hire_date,
    extract(year from current_date)::integer as year,
    extract(year from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_years,
    extract(month from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_months,
    extract(day from age(current_date::timestamp with time zone, hire_date::timestamp with time zone))::integer as service_days,
    -- 年資一律以「今年 1 月 1 日」為基準（date_trunc('year', current_date)），
    -- 也就是歷年制：整年的天數在 1/1 就定下來，年中到職不會改變當年的額度。
    -- 下面 used_days 的年度區間也是同一套基準，兩邊是對齊的。
    case
        when hire_date is null then 0
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '6 mons'::interval then 0
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '1 year'::interval then 3
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '2 years'::interval then 7
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '3 years'::interval then 10
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '5 years'::interval then 14
        when (date_trunc('year'::text, current_date::timestamp with time zone) - hire_date::timestamp with time zone) < '10 years'::interval then 15
        -- ↓ 這一行是這次唯一的修正：原本是 15 + 年資 - 10
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
          where lr.requester_id = u.id and lr.status = 'approved'::text and lt.name = '特休假'::text and extract(year from lr.start_date) = extract(year from current_date)), 0::numeric) as used_days
   from users u
  where is_active = true;

comment on view public.annual_leave_summary is
  '每位在職員工今年的特休額度與已使用天數。歷年制：額度依「今年 1/1 為止的年資」對照勞基法第 38 條級距決定，已使用天數統計當年 1/1~12/31 的已核准特休假單。定義見 migration 20260911。';
