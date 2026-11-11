-- ============================================================================
-- 測試資料清單（唯讀，不會改任何資料）
-- ============================================================================
--
-- 用途：上線前清測試資料，先把「可能要刪的東西」全部列出來，看完再決定刪哪些。
--       2026-11 使用者要求：請假單＋簽核、考核、員工福利（按摩）、假單附件，
--       先列出來看。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。
--       整份只有一段 select，所以結果就是一張表（SQL Editor 只顯示最後一段的結果）。
--       結果可以按右上角下載成 CSV 慢慢看。
--
-- 結果的欄位：
--   類別      請假單／考核／按摩／附件檔案
--   同仁      請假的人、被考核的人、建立按摩期數的人、上傳附件的人
--   內容      假別、考核名稱、按摩期數名稱、檔名
--   日期      請假日期、按摩日期
--   狀態      假單狀態、考核進度、按摩是否抽過籤、附件是否還有假單在用
--   備註      有沒有附件、作答幾筆、報名幾人
--   建立時間
--
-- 這份「不」列的（不會刪）：同仁帳號、部門、職稱、入職日期、假別設定、簽核流程、
-- 考核題目範本、按摩負責人與測試模式設定、個人假期額度的手動指定（使用者決定保留）。
-- ============================================================================

select 類別, 同仁, 內容, 日期, 狀態, 備註, 建立時間
from (
  -- 1. 請假單（簽核紀錄跟著假單，刪假單就一起刪）
  select 1 as 排序,
         '請假單'::text as 類別,
         u.full_name as 同仁,
         coalesce(lt.name, '') as 內容,
         lr.start_date::text
           || case when lr.end_date is distinct from lr.start_date then ' ~ ' || lr.end_date::text else '' end as 日期,
         lr.status as 狀態,
         concat_ws('、',
           case when coalesce(lr.attachment_url, '') <> '' then '有附件' end,
           case when lr.registered_by is not null then 'HR 代登' end,
           (select count(*) || ' 筆簽核' from public.leave_approvals a where a.request_id = lr.id)) as 備註,
         lr.created_at as 建立時間
    from public.leave_requests lr
    join public.users u on u.id = lr.requester_id
    left join public.leave_types lt on lt.id = lr.leave_type_id

  union all

  -- 2. 考核：只列有填過東西或有進度的人（沒動過的參與者不列）
  select 2,
         '考核',
         u.full_name,
         coalesce(r.title, r.year::text, ''),
         '',
         coalesce(nullif(concat_ws('、',
           case when p.self_submitted then '已交自評' end,
           case when p.supervisor_submitted then '主管已評完' end,
           case when p.final_score is not null then '有分數 ' || p.final_score::text end,
           case when p.published_at is not null then '已公布' end), ''), '填寫中'),
         concat_ws('、',
           (select count(*) || ' 筆自評作答' from public.review_responses x where x.participant_id = p.id),
           (select count(*) || ' 筆主管評分' from public.review_evaluations x where x.participant_id = p.id)),
         null::timestamptz
    from public.annual_review_participants p
    join public.users u on u.id = p.user_id
    left join public.annual_reviews r on r.id = p.review_id
   where p.self_submitted or p.supervisor_submitted or p.final_score is not null
      or exists (select 1 from public.review_responses x where x.participant_id = p.id)
      or exists (select 1 from public.review_evaluations x where x.participant_id = p.id)

  union all

  -- 3. 按摩：一期一列
  select 3,
         '按摩',
         coalesce(u.full_name, ''),
         s.title,
         s.session_date::text,
         case when s.drawn_at is not null then '已抽籤' else '未抽籤' end,
         (select count(*) || ' 人報名' from public.massage_signups g where g.session_id = s.id),
         s.created_at
    from public.massage_sessions s
    left join public.users u on u.id = s.created_by

  union all

  -- 4. 假單附件檔案（Storage 的 leave-attachments；路徑開頭是上傳者的 id）
  select 4,
         '附件檔案',
         coalesce(u.full_name, ''),
         o.name,
         '',
         case when exists (select 1 from public.leave_requests lr where lr.attachment_url like '%' || o.name)
              then '還有假單在用' else '沒有假單在用' end,
         '',
         o.created_at
    from storage.objects o
    left join public.users u on u.id::text = split_part(o.name, '/', 1)
   where o.bucket_id = 'leave-attachments'
) t
order by 排序, 建立時間 desc nulls last, 同仁;
