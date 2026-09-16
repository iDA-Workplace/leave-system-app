-- 讓 leave_requests.flow_id 可以留空
--
--
-- 要解決的問題
--
-- HR 代同仁登記請假時會出現：
--
--   null value in column "flow_id" of relation "leave_requests"
--   violates not-null constraint
--
-- 代登記的假單刻意不走簽核（見 20260915_hr_registered_leave.sql 的說明：
-- 這種假已經請完了，再送主管核准是倒因為果），所以沒有流程可以填。但這個
-- 欄位從一開始就是 not null —— 因為在代登記這個功能出現之前，每一張假單
-- 都一定屬於某個簽核流程，那時候這個限制是對的。
--
--
-- 為什麼是放寬限制，而不是隨便塞一個 flow_id 進去
--
-- 塞一個流程 id 進去可以讓錯誤消失，但那是在資料庫裡寫下一句不實的話：
-- 「這張假單走過這個流程」。之後任何人去查核簽核紀錄，都會看到一張掛著
-- 流程、卻沒有任何簽核動作的假單，查起來只會更亂。NULL 才是誠實的答案：
-- 這張沒有流程。
--
--
-- 這樣放寬會不會讓一般假單漏掉流程？
--
-- 不會。兩個送假單的入口都在寫入「之前」就先擋掉沒有流程的情況：
--   - 網頁 src/pages/LeaveForm.jsx：沒有 default_flow_id 時送出鈕是停用的
--   - Slack supabase/functions/slack-interactions：回「您尚未被指定審核流程」
-- 所以 NULL 只會出現在刻意不走簽核的代登記假單上。
--
-- 待審核清單那邊也不受影響：它是拿 flow_id ＋ current_step 去比對簽核關卡
-- （src/components/Layout.jsx、src/pages/MyLeaves.jsx），NULL 比對不到任何
-- 一關，所以代登記的假單不會跑進任何人的待辦，這正是我們要的。

alter table public.leave_requests
  alter column flow_id drop not null;

comment on column public.leave_requests.flow_id is
  'NULL＝這張假單不走簽核流程（目前只有 HR 代登記的假單，見 registered_by）。有值＝走這個簽核流程。';

-- current_step 是「走到第幾關」，沒有流程的假單同樣無話可說，代登記時也是
-- 留空的。Postgres 一次只報第一個違規的欄位，所以修好 flow_id 之後很可能
-- 換成這一欄跳出同樣的錯誤 —— 一起放寬，不要讓使用者再撞一次。
-- 這個欄位如果本來就允許 NULL，下面這句不會有任何作用，也不會報錯。
alter table public.leave_requests
  alter column current_step drop not null;

comment on column public.leave_requests.current_step is
  'NULL＝這張假單不走簽核流程（配合 flow_id）。有值＝目前輪到第幾關簽核。';

-- ---------------------------------------------------------------------------
-- 確認生效（兩欄的 is_nullable 都應該是 YES）：
--
--   select column_name, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'leave_requests'
--      and column_name in ('flow_id', 'current_step');
--
-- 如果代登記還是送不出去，用這句把「還有哪些欄位不能留空、而且沒有預設值」
-- 全部列出來 —— 代登記沒有填的欄位如果出現在這張清單裡，就是下一個會擋住
-- 的原因：
--
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'leave_requests'
--      and is_nullable = 'NO'
--      and column_default is null
--    order by column_name;
-- ---------------------------------------------------------------------------
