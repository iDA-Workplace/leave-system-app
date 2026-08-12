-- 考核結果「未讀通知」
--
-- 員工的「過往考核紀錄」分頁上要顯示一個未讀筆數的 badge，看過該筆結果後
-- 就消失，而且換電腦、換瀏覽器都要正確 —— 所以已讀狀態存在資料庫，不是
-- localStorage。
--
-- 冪等，重複執行安全。

alter table public.annual_review_participants
  add column if not exists result_viewed_at timestamptz;

comment on column public.annual_review_participants.result_viewed_at is
  '員工第一次點開「查看詳情」看到自己這次考核結果的時間。null = 尚未看過，'
  '「過往考核紀錄」分頁會把它算進未讀 badge 的數字裡。';


-- 標記已讀刻意走 SECURITY DEFINER 函式，而不是開一條「員工可以更新自己的
-- participant 資料列」的 RLS policy。
--
-- 原因：Postgres 的 RLS 是「整列」的權限，沒辦法只放行單一欄位。一旦開了
-- 那條 policy，員工就能連帶改自己的 final_score（最終分數）—— 用函式包起來
-- 就只有 result_viewed_at 這一個欄位會被動到，其他欄位完全碰不到。
--
-- where 條件同時鎖 user_id = auth.uid()，所以就算有人自己去呼叫這支 API 並
-- 帶入別人的 participant id，也只會影響到自己的資料列（0 rows updated）。
create or replace function public.mark_review_result_viewed(p_participant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.annual_review_participants
     set result_viewed_at = now()
   where id = p_participant_id
     and user_id = auth.uid()
     and supervisor_submitted = true
     and result_viewed_at is null;
$$;

comment on function public.mark_review_result_viewed(uuid) is
  '員工點開自己的考核結果時呼叫，只會寫入 result_viewed_at，且只會寫入自己的資料列。';

revoke all on function public.mark_review_result_viewed(uuid) from public;
grant execute on function public.mark_review_result_viewed(uuid) to authenticated;
