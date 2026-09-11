-- 特休改成「歷年制按比例」計算
--
--
-- 為什麼要改
--
-- 原本的算法是：拿「今年 1 月 1 日當下的年資」去查勞基法級距表，得到的天數
-- 就是整年的額度。問題在於年中到職的人，整年都會被鎖在到職前一年的級距。
--
-- 例：2025/4/28 到職的人，2026/4/28 就滿一年（勞基法給 7 天），但因為系統
-- 只在 1/1 拍一次快照，那時年資才 8 個月，所以 2026 一整年都只給 3 天。
--
-- 勞動部的立場是：可以用歷年制，但換算後**不得低於勞基法標準**，而歷年制
-- 的正確做法是「按比例換算」—— 一年之中跨到不同級距時，各段依天數加權。
--
--
-- 新的算法
--
-- 把今年的每一天都看一次「那一天的年資對應幾天特休」，再取平均：
--
--   額度 = (今年每一天的級距天數總和) ÷ (今年的天數)
--
-- 同一個例子重算 2026 年：
--   · 1/1 ~ 4/27（117 天）年資未滿 1 年 → 級距 3 天
--   · 4/28 ~ 12/31（248 天）年資 1~2 年 → 級距 7 天
--   → (3×117 + 7×248) ÷ 365 = 5.71... → 進位後 6 天（原本只給 3 天）
--
-- 到職當年也吃同一套：到職日之前的日子算 0，所以自然就是按比例。
--
--
-- 不會有人變少
--
-- 年資只會往上，所以一年之中每天的級距天數是遞增的，1/1 那天必定是全年
-- 最低的一天。舊算法等於「只取 1/1 那天」，新算法取全年平均，因此
-- **新值一定大於或等於舊值**，不會有任何同仁的天數被調降。
--
--
-- 小數怎麼處理：無條件進位到整天
--
-- 按比例算出來的往往是小數（上面那個例子是 5.71），這裡一律**無條件進位
-- 到整天**，5.71 → 6 天。兩個理由：
--
--   1. 取進位而不是四捨五入，是因為法規要求不得低於標準 —— 寧可多給，
--      也不要因為進位而少給。
--   2. 特休大家習慣用「天」在講，整天也比較好排班與結算。
--
-- 技術上還有一個好處：entitled_days 維持整數型別，可以用
-- create or replace 就地更新 view。如果改成回傳小數，Postgres 會拒絕
-- （不允許用 replace 改欄位型別），必須先 drop 再 create —— 而 drop 會
-- 一併清掉這個 view 既有的授權與 RLS 相關設定，風險高很多。
--
-- 如果人資之後希望改成 0.5 天或 0.1 天為單位，改下面 ceil() 那一行即可
-- （例如 0.5 天是 ceil(avg*2)/2），但要注意那會改變欄位型別，得改用
-- drop + create，並且記得把原本的 grant 一起補回去。

-- ---------------------------------------------------------------------------
-- 1. 勞基法第 38 條級距：某人在某一天應有的特休天數
-- ---------------------------------------------------------------------------
-- 抽成函式有兩個好處：view 裡不用把同一串 case 寫兩次，而且以後法規真的修了
-- 只要改這一個地方。標成 stable 而不是 immutable，因為 age() 會受時區設定影響。

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
  '勞基法第 38 條特別休假級距：給到職日與某一個日期，回傳那一天該員工應有的特休天數。歷年制按比例計算時，會對整年每一天呼叫一次再取平均。';

-- ---------------------------------------------------------------------------
-- 2. view 改用按比例計算
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
    -- 今年每一天的級距天數取平均，再無條件進位到整天。
    -- 整年都在同一個級距的人（多數同仁）平均值就是那個整數，進位後不變。
    coalesce((
      select ceil(avg(public.statutory_leave_days(u.hire_date, d::date)))::integer
        from generate_series(
               date_trunc('year', current_date)::date,
               (date_trunc('year', current_date) + '1 year'::interval - '1 day'::interval)::date,
               '1 day'::interval
             ) d
    ), 0) as entitled_days,
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
  '每位在職員工今年的特休額度與已使用天數。歷年制按比例：額度是今年每一天依勞基法第 38 條級距應有天數的平均值（無條件進位到整天），年中到職或年中跨級距都會按比例反映。已使用天數統計當年 1/1~12/31、狀態為已核准或審核中的特休假單（以 leave_types.is_annual 辨識假別）。定義見 migration 20260911。';
