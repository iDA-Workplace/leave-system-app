-- 記下「待審核通知」發到 Slack 的哪個位置
--
--
-- 要解決的問題
--
-- 同仁在 Slack 上收回假單之後，主管那則「有一張假單待您審核」要跟著改寫成
-- 「此假單已被收回」，核准／駁回按鈕也要消失。
--
-- 但 Slack 的 chat.update 需要知道「哪個對話、哪一則訊息」（channel ＋ ts），
-- 而這兩個值只有在當初 chat.postMessage 發出去的當下才拿得到。沒有記下來的
-- 話，事後就再也找不到那則訊息了。
--
-- 核准／駁回那條路徑不需要這個，因為它用的是 response_url —— Slack 在使用者
-- 按下按鈕時才附上的一次性網址。收回的人是「申請人」，他手上那則是自己的
-- 送出確認訊息，拿不到主管那則的 response_url，所以只能靠事先記下來。
--
--
-- 存什麼
--
-- 一個 JSON 陣列，每個元素是 { channel, ts, lang }：
--
--   [{"channel":"D01ABC","ts":"1726...","lang":"zh"}]
--
-- 一關可能有多位簽核人，所以是陣列。lang 一起記下來，是因為每則通知原本就
-- 是用「收件人自己的語言」發的 —— 改寫的時候也要用同一種語言，不然主管會
-- 看到一則中文訊息突然變成英文。
--
--
-- 為什麼是 jsonb 欄位而不是另開一張表
--
-- 這些資料的生命週期跟假單完全一致（假單沒了就沒有意義）、不會被單獨查詢、
-- 也不需要跟其他東西 join。另開一張表只會多一組要維護的外鍵與清理邏輯。
--
-- 每次通知新一關的簽核人時會整個覆蓋掉，不累加 —— 上一關那則訊息在核准的
-- 當下就已經被改寫成「已核准」了，不需要再動它。

alter table public.leave_requests
  add column if not exists approver_message_refs jsonb;

comment on column public.leave_requests.approver_message_refs is
  '待審核通知發到 Slack 的位置，格式 [{channel, ts, lang}]。申請人收回假單時用它把簽核人那幾則訊息改寫成「已被收回」。只在流程進到新的一關時整個覆蓋。';

-- ---------------------------------------------------------------------------
-- 確認生效：
--
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'leave_requests'
--      and column_name = 'approver_message_refs';
--
-- 看目前有記錄的假單（送出後、還沒走完流程的那些才會有）：
--
--   select id, status, approver_message_refs
--     from public.leave_requests
--    where approver_message_refs is not null
--    order by created_at desc
--    limit 20;
-- ---------------------------------------------------------------------------
