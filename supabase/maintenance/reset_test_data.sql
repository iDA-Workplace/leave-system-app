-- ============================================================================
-- 測試資料歸零 —— 步驟 2／2：實際清除（會改資料，跑之前請先跑 preview）
-- ============================================================================
--
-- 這份腳本做的事：
--   1. 刪掉測試期間 key 的請假單與它的簽核紀錄
--   2. 刪掉考核的自評作答與主管評分
--   3. 考核參與者「人留著」，只把流程狀態退回最開始（未交自評、未評分、
--      沒有分數、未讀已讀標記清掉），主管一進系統就是乾淨的待辦清單
--   4. 把個人假期額度的「手動調整」清掉，全部回到「比照勞基法／全公司預設」
--
-- 這份腳本刻意不做的事（依照需求確認過的範圍）：
--   × 不刪、不改 users —— 同仁的帳號、部門、職稱、入職日期都是真實資料
--   × 不刪 Supabase Auth 的登入帳號 —— 大家的密碼與登入方式維持原樣
--   × 不刪 Storage（leave-attachments）裡的附件檔案
--   × 不刪考核週期 —— 測試期間開的那幾個週期先留著
--   × 不刪簽核流程、考核題目範本、假別，以及「全公司預設額度」
--
-- 附註：
--   · annual_leave_summary 是「檢視表(view)」不是資料表，特休的已用時數是
--     依請假單即時算出來的，假單一刪它自己就會歸零，不必也不能對它下 delete。
--   · 可以重複執行，第二次跑就是「沒有東西可刪」，不會出錯。
--
--
-- ⚠️ 這支刻意「不」用 begin / commit 包起來
--
-- 2026-09-29 發現同樣的交易寫法在 Supabase 的網頁 SQL Editor 裡會整份靜靜
-- 失效 —— 沒有錯誤訊息、資料一筆都沒少（當時已排除外鍵與權限：擁有者是
-- postgres、relforcerowsecurity 為 false）。拿掉交易包裝就正常了。
-- 網頁版 SQL Editor 有自己的一套執行與交易處理，跟 psql 不一樣。
--
-- 沒有交易的代價是「可能只做到一半」。這裡可以接受，因為每一步都是各自獨立
-- 的清除、而且整支可以重複執行 —— 真的中斷在一半，重跑一次就好。
--
-- ⚠️ 但也因為這樣，**跑完一定要看最下面那張驗收表**，不能因為它沒報錯就當作
--    成功。那張表才是唯一可信的依據。
-- ============================================================================

-- ---- 1. 請假 ----------------------------------------------------------------
-- leave_approvals.request_id 的外鍵是 on delete cascade，簽核紀錄會自動跟著
-- 一起刪，不需要也不應該另外下一行 delete —— 少一個步驟就少一個會出錯的地方。
delete from public.leave_requests;

-- ---- 2. 考核作答 ------------------------------------------------------------
delete from public.review_evaluations;
delete from public.review_responses;

-- ---- 3. 考核參與者：人留著，狀態歸零 -----------------------------------------
-- 這裡用 update 而不是 delete，是因為「誰要被考核、走哪一條簽核鏈」是設定好
-- 的名冊，不是測試資料；刪掉就要重加一次人。
update public.annual_review_participants
set
  self_submitted          = false,
  self_submitted_at       = null,
  supervisor_submitted    = false,
  supervisor_submitted_at = null,
  current_step            = 1,      -- 退回簽核鏈第一關
  final_score             = null,
  result_viewed_at        = null,   -- 員工端的「未讀」紅點會回來
  calibration_status      = 'pending',   -- 這欄不可為 null，'pending' 就是初始值
  calibration_note        = null,
  published_at            = null,
  acknowledged_at         = null,
  has_dispute             = false,
  dispute_comment         = null;

-- ---- 4. 個人假期額度：清掉手動調整，回到預設 --------------------------------
-- 這張表存的是「財務針對某個人、某個假別另外談定的額度」。沒有資料列＝這個人
-- 這個假別走預設（特休依入職日期與年資自動算，其他假別用全公司預設值），
-- 所以「歸零」就是把資料列刪掉，而不是把數字改成 0 —— 改成 0 會變成
-- 「這個人明確被設定成一天都不能請」，那是完全不同的意思。
-- 全公司預設額度存在別的地方，不會被這一行動到。
delete from public.user_leave_entitlements;


-- ============================================================================
-- 跑完之後的驗收：下面每一個數字都應該是 0
-- ============================================================================
select '請假單'        as 項目, count(*) as 應為0 from public.leave_requests
union all
select '請假簽核紀錄', count(*) from public.leave_approvals
union all
select '考核自評作答', count(*) from public.review_responses
union all
select '考核主管評分', count(*) from public.review_evaluations
union all
select '個人假期額度的手動調整', count(*) from public.user_leave_entitlements
union all
select '已交自評的人', count(*) from public.annual_review_participants where self_submitted
union all
select '已評完的人',   count(*) from public.annual_review_participants where supervisor_submitted
union all
select '還有分數的人', count(*) from public.annual_review_participants where final_score is not null
order by 1;

-- 這兩個相反，應該維持原本的人數（沒有被刪掉）
select '員工帳號（不該變少）' as 項目, count(*) as 筆數 from public.users
union all
select '考核參與者（不該變少）', count(*) from public.annual_review_participants;
