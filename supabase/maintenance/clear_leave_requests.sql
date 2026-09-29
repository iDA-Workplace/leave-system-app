-- 只清掉請假單（不動其他任何東西）
--
--
-- 什麼時候用這支
--
-- 測試期間 key 了一堆假的假單，上線前要清乾淨；或是之後又做了一輪測試，
-- 要把測試假單清掉。
--
--
-- ⚠️ 這支跟 reset_test_data.sql 不一樣，請看清楚再選
--
--   reset_test_data.sql   請假單 ＋ 考核作答 ＋ 考核狀態 ＋ **個人假期額度的手動調整**
--   這一支                只有請假單與它的簽核紀錄
--
-- 差別最關鍵的是最後那一項：reset_test_data.sql 會把「HR 針對某個人另外指定
-- 的特休天數」全部刪掉，讓所有人回到依年資自動計算。如果你刻意替某些同仁設
-- 過個別天數（在「員工假期管理」裡顯示為手動指定的那些），跑那一支會把它們
-- 一起清掉，而且不會有任何提示。
--
-- 只想清假單的話，用這一支。
--
--
-- 這支會刪什麼
--   · public.leave_approvals   所有簽核紀錄
--   · public.leave_requests    所有請假單
--
-- 這支不會動什麼
--   × users            同仁的帳號、部門、職稱、入職日期都是真實資料
--   × Supabase Auth    大家的密碼與登入方式維持原樣
--   × user_leave_entitlements   個別指定的假期天數，原封不動
--   × leave_types      假別與全公司預設額度
--   × 考核的任何資料
--   × Storage 裡的附件檔案（見最後的說明）
--
--
-- 附註
--   · annual_leave_summary 是檢視表(view)不是資料表，已用天數是依請假單即時
--     算出來的 —— 假單一刪它自己就會歸零，不必也不能對它下 delete。
--   · 整份包在一個交易裡：中間任何一步出錯，全部都不會生效。
--   · 可以重複執行，第二次跑就是「沒有東西可刪」，不會出錯。


-- ---------------------------------------------------------------------------
-- 想先看會刪掉什麼的話，「只」把下面這段反白起來執行（不要整份跑）：
--
--   select u.full_name as 同仁, lt.name as 假別, lr.start_date as 日期,
--          lr.status as 狀態, lr.created_at as 建立時間
--     from public.leave_requests lr
--     join public.users u       on u.id = lr.requester_id
--     left join public.leave_types lt on lt.id = lr.leave_type_id
--    order by lr.created_at desc;
--
-- 確認全部都是測試資料之後，再整份執行這個檔案。
-- ---------------------------------------------------------------------------

begin;

-- 先刪簽核紀錄再刪假單：簽核紀錄指向假單，順序反了會被外鍵擋下來。
delete from public.leave_approvals;
delete from public.leave_requests;

commit;


-- ---------------------------------------------------------------------------
-- 驗收：前兩個數字應該是 0，後兩個應該維持原本的人數（沒有被刪掉）
--
-- ⚠️ Supabase 的 SQL Editor 只會顯示「最後一段」的結果，所以這段查詢一定要
--    放在最後。放中間的話你會看不到它，以為沒跑到。
-- ---------------------------------------------------------------------------
select '請假單（應為 0）'              as 項目, count(*) as 筆數 from public.leave_requests
union all
select '簽核紀錄（應為 0）',           count(*) from public.leave_approvals
union all
select '員工帳號（不該變少）',         count(*) from public.users
union all
select '個別指定的假期天數（不該變少）', count(*) from public.user_leave_entitlements
order by 1;


-- ---------------------------------------------------------------------------
-- 附件檔案
--
-- 假單刪掉之後，當初上傳的附件檔案仍然留在 Storage 的 leave-attachments 這個
-- bucket 裡，變成沒有任何假單指向它們的孤兒檔案。它們不會出現在系統的任何
-- 畫面上，也不影響使用，只是佔空間。
--
-- 要清的話：Supabase 主控台 → Storage → leave-attachments → 全選 → 刪除。
-- 這一步刻意不寫進 SQL —— 用 SQL 刪 Storage 需要額外的權限設定，而這件事
-- 一年做不到一次，在畫面上點一點反而更清楚、也不會誤刪。
--
-- ⚠️ 上線之後就不要再全選刪除了，那會刪到同仁真正的證明文件。
-- ---------------------------------------------------------------------------
