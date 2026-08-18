-- ============================================================================
-- 測試資料歸零 —— 步驟 1／2：先看看會動到哪些東西（唯讀，不會改任何資料）
-- ============================================================================
--
-- 用法：在 Supabase 主控台的 SQL Editor 貼上整份執行，看完數字確認沒問題，
--       再去跑 reset_test_data.sql。
--
-- 這份只有 select，重跑幾次都沒關係。
-- ============================================================================

-- 會被刪掉的資料
select '會刪除：請假單'          as 項目, count(*) as 筆數 from public.leave_requests
union all
select '會刪除：請假簽核紀錄',   count(*) from public.leave_approvals
union all
select '會刪除：考核自評作答',   count(*) from public.review_responses
union all
select '會刪除：考核主管評分',   count(*) from public.review_evaluations
union all
select '會刪除：個人假期額度手動調整', count(*) from public.user_leave_entitlements
union all
-- 會被改成「未開始」但不會刪掉的資料
select '會歸零(不刪)：考核參與者', count(*) from public.annual_review_participants
union all
-- 完全不動的資料
select '不動：員工帳號',         count(*) from public.users
union all
select '不動：考核週期',         count(*) from public.annual_reviews
union all
select '不動：假別設定',         count(*) from public.leave_types
union all
select '不動：請假簽核流程',     count(*) from public.approval_flows
union all
select '不動：考核簽核流程',     count(*) from public.review_flows
union all
select '不動：考核題目範本',     count(*) from public.review_templates
order by 1;

-- 請假單依狀態分佈，確認要刪掉的真的都是測試期間 key 的
select status as 假單狀態, count(*) as 筆數,
       min(created_at)::date as 最早, max(created_at)::date as 最晚
from public.leave_requests
group by status
order by count(*) desc;

-- 有附件的假單：這些檔案本體在 Storage（leave-attachments）裡，這次不會刪。
-- 假單資料列刪掉之後，檔案會變成沒有人指向的孤兒檔，需要的話之後再另外處理。
select count(*) as 有附件的假單筆數
from public.leave_requests
where attachment_url is not null and attachment_url <> '';

-- 考核參與者目前的狀態，歸零後這些數字應該全部變成 0
select
  count(*)                                          as 參與者總數,
  count(*) filter (where self_submitted)            as 已交自評,
  count(*) filter (where supervisor_submitted)      as 主管已評完,
  count(*) filter (where final_score is not null)   as 有最終分數
from public.annual_review_participants;
