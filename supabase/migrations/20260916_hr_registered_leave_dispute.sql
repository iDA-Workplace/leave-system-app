-- 代登記假單：同仁可以「提出修改異議」
--
--
-- 要解決的問題
--
-- 20260915_hr_registered_leave 讓同仁可以「確認」HR 代登記的假單，但只有
-- 確認這一個選項 —— 如果內容是錯的（日期不對、假別不對、根本沒請這天），
-- 同仁只能私下去找 HR 講，系統裡不會留下任何紀錄。
--
-- 這在「3 天未確認視同確認」的規則下特別危險：同仁明明講過內容有誤，但
-- 因為沒有地方按，時間一到照樣自動生效，事後只剩下各說各話。
--
-- 所以補上「提出修改異議」：要填理由才能送出，送出後通知登記那筆的 HR。
--
--
-- 三個設計決定（2026-09 與使用者確認）
--
-- 1. 提出異議「不會」改變假單狀態 —— 維持已核准、時數照算。系統不自動
--    判斷誰對誰錯，只負責把話傳到並留下紀錄，改不改由 HR 判斷。
--
-- 2. 已經提出異議的假單「不會」自動視同確認。同仁已經明確表示過不同意，
--    再套用「未提出異議視同確認」在勞資爭議上站不住腳 —— 那句話的前提
--    就是「沒有提出異議」。所以有異議就停下來，一直等 HR 處理。
--
-- 3. 通知「登記那筆的 HR 本人」（registered_by），不是全體 HR。誰登的誰
--    處理，責任最清楚。
--
--
-- 為什麼異議要獨立成欄位，不塞進 acknowledged_at
--
-- 「確認」與「有異議」是兩種相反的表態，不是同一個欄位的兩個值。塞在一起
-- 的話，自動確認那支排程就分不出「還沒回應」與「已經說過不同意」——
-- 而這兩者正是它最需要分清楚的事（前者要自動確認，後者絕對不能）。

alter table public.leave_requests
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_reason text;

comment on column public.leave_requests.disputed_at is
  '同仁提出修改異議的時間。NULL＝沒有異議。有值的話，逾期自動確認會跳過這一筆（見 daily-leave-job）。';
comment on column public.leave_requests.dispute_reason is
  '同仁提出異議的理由（必填才能送出）。爭議發生時這是同仁當下的說法，不要覆寫。';

-- ---------------------------------------------------------------------------
-- 確認設定正確：
--
--   select id, requester_id, registered_by, ack_deadline,
--          acknowledged_at, auto_acknowledged, disputed_at, dispute_reason
--     from public.leave_requests
--    where registered_by is not null
--    order by created_at desc;
--
-- 目前有異議、還等著 HR 處理的（這些不會自動確認）：
--
--   select lr.id, u.full_name as 同仁, lr.start_date, lr.dispute_reason
--     from public.leave_requests lr
--     join public.users u on u.id = lr.requester_id
--    where lr.disputed_at is not null
--      and lr.acknowledged_at is null
--    order by lr.disputed_at;
-- ---------------------------------------------------------------------------
