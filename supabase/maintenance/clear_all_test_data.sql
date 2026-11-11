-- ############################################################################
-- ⚠️⚠️⚠️  只能在「正式上線前」使用  ⚠️⚠️⚠️
--
-- 這支不分辨是不是測試資料：所有請假單、所有考核作答、所有按摩期數都會被刪掉。
-- 上線後執行，會把同仁真實的請假、考核、按摩紀錄全部刪光，而且無法復原。
--
-- 上線後要清測試資料：先跑 test_data_list.sql 列出來，挑出要刪的，
-- 再另外寫「只刪那幾筆」的語法（2026-11 使用者決定的做法）。
-- ############################################################################
--
-- ============================================================================
-- 上線前清除測試資料：請假單、考核作答、按摩
-- ============================================================================
--
-- 2026-11 使用者決定（先用 test_data_list.sql 列出來確認過「全都是測試資料」）：
--   · 請假單＋簽核紀錄：全部刪除
--   · 考核：作答與主管評分刪除；考核週期與參與者名單「保留」，每個人的進度歸零
--   · 按摩：所有期數刪除（報名、抽籤結果、異動紀錄、Slack 討論串紀錄跟著刪）
--           Slack 上已發的報名公告：保留追蹤紀錄，排程會在一分鐘內把 60 天內的
--           公告改成「本期已取消」、拿掉報名按鈕（改原本那則，不會發新訊息）
--   · 個人假期額度的手動指定：保留（不動）
--   · 假單附件檔案：不在這支裡 —— Supabase 不允許用 SQL 刪 Storage 的檔案，
--     要到主控台 Storage 頁面刪（步驟見 README）
--
-- 不會動：同仁帳號、部門、職稱、入職日期、密碼、假別、簽核流程、考核題目範本、
--         考核週期、考核參與者名單、按摩負責人與測試模式設定、個人假期額度。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行（不用反白任何部分）。
--       最後會出現一張驗收表。可以重複執行，第二次跑就是沒有東西可刪。
--
-- 為什麼用 do $$ ... $$ 包起來：整段是「一個」指令，中途任何一步出錯就全部不算，
-- 不會刪一半。（之前在 SQL Editor 用 begin/commit 包整份沒有生效，do 區塊不受影響。）
-- ============================================================================

do $$
begin
  -- 1. 請假單：簽核紀錄的外鍵是 on delete cascade，會自動一起刪
  delete from public.leave_requests;

  -- 2. 考核：作答與評分刪掉；參與者留著、進度歸零
  delete from public.review_evaluations;
  delete from public.review_responses;
  update public.annual_review_participants
     set self_submitted          = false,
         self_submitted_at       = null,
         supervisor_submitted    = false,
         supervisor_submitted_at = null,
         current_step            = 1,
         final_score             = null,
         result_viewed_at        = null,
         calibration_status      = 'pending',
         calibration_note        = null,
         published_at            = null,
         acknowledged_at         = null,
         has_dispute             = false,
         dispute_comment         = null;

  -- 3. 按摩：「已抽籤的期數不能刪」是正式環境的保護，這裡暫時關掉、刪完馬上打開
  --    （出錯的話整段不算，保護也會維持原樣）
  --    期數刪掉 → 報名、異動紀錄、通知紀錄、Slack 討論串紀錄都是 on delete cascade
  alter table public.massage_sessions disable trigger massage_sessions_guard;
  delete from public.massage_sessions;
  alter table public.massage_sessions enable trigger massage_sessions_guard;
  delete from public.massage_events;   -- 不屬於任何期數的零星紀錄（通常沒有）
  -- 排程用來「同一件事只做一次」的記號：只清跟期數有關的
  delete from public.massage_jobs
   where split_part(job_key, ':', 1) in ('announce_open', 'signup_closing', 'signup_closed', 'draw_reminder');
  -- massage_announcements 刻意不刪：留著，排程才會把 Slack 公告改成「本期已取消」
end $$;


-- ============================================================================
-- 驗收：「應為 0」那幾列要是 0；「不該變少」那幾列跟執行前一樣
-- （SQL Editor 只顯示最後一段的結果，所以這段一定放最後）
-- ============================================================================
select '應為 0：請假單' as 項目, count(*) as 筆數 from public.leave_requests
union all select '應為 0：請假簽核紀錄', count(*) from public.leave_approvals
union all select '應為 0：考核自評作答', count(*) from public.review_responses
union all select '應為 0：考核主管評分', count(*) from public.review_evaluations
union all select '應為 0：考核有進度的人', count(*) from public.annual_review_participants
                  where self_submitted or supervisor_submitted or final_score is not null
union all select '應為 0：按摩期數', count(*) from public.massage_sessions
union all select '應為 0：按摩報名', count(*) from public.massage_signups
union all select '不該變少：員工帳號', count(*) from public.users
union all select '不該變少：考核週期', count(*) from public.annual_reviews
union all select '不該變少：考核參與者', count(*) from public.annual_review_participants
union all select '不該變少：個人假期額度手動指定', count(*) from public.user_leave_entitlements
union all select '不該變少：假別', count(*) from public.leave_types;
