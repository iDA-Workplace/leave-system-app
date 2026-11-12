-- ============================================================================
-- 國定假日上線前：哪些現有假單會受影響（唯讀，不會改任何資料）
-- ============================================================================
--
-- 先跑 ../migrations/20261113_holidays.sql（建假日資料表、放入 2026／2027 假日），
-- 再跑這份。看完沒問題，才跑 20261114_holidays_go_live.sql 正式啟用。
--
-- 列出兩種假單（只看審核中、已核准）：
--   A. 跨日假單，中間有國定假日 → 天數會變少（例如原本 5 天變 4 天）
--   B. 單日假單（填時數的），那一天剛好是國定假日 → 天數不會自動改（照填的時數算），
--      但那天本來就放假，建議 HR 確認後改掉或刪掉
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行（只有一段查詢）。
-- ============================================================================

select u.full_name                         as 同仁,
       coalesce(lt.name, '')               as 假別,
       lr.start_date::text
         || case when lr.end_date is distinct from lr.start_date then ' ~ ' || lr.end_date::text else '' end
                                           as 日期,
       lr.status                           as 狀態,
       case when lr.hours is null then 'A. 跨日，中間有國定假日' else 'B. 單日，當天是國定假日' end
                                           as 情況,
       case when lr.hours is null
            then (select count(*) from generate_series(lr.start_date, lr.end_date, interval '1 day') d
                   where extract(isodow from d) < 6)::text || ' 天'
            else lr.hours::text || ' 小時' end as 原本,
       case when lr.hours is null
            then public.count_workdays(lr.start_date, lr.end_date)::text || ' 天'
            else '（照填的時數，建議確認）' end   as 啟用後,
       (select string_agg(to_char(h.date, 'MM/DD') || ' ' || h.name, '、' order by h.date)
          from public.holidays h
         where h.is_holiday and h.date between lr.start_date and coalesce(lr.end_date, lr.start_date))
                                           as 碰到的假日
  from public.leave_requests lr
  join public.users u on u.id = lr.requester_id
  left join public.leave_types lt on lt.id = lr.leave_type_id
 where lr.status in ('pending', 'approved')
   and exists (select 1 from public.holidays h
                where h.is_holiday and h.date between lr.start_date and coalesce(lr.end_date, lr.start_date))
 order by lr.start_date, u.full_name;
