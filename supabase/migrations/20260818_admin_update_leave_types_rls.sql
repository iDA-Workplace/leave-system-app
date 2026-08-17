-- 讓「管理員」也能改假別的英文名稱
--
-- 20260814 只給了財務 leave_types 的 UPDATE 權限（當時那張表上只有財務會動的
-- 「全公司預設額度」）。但假別的英文名是用字正確與否的問題，不是假期制度的
-- 問題 —— 財務不見得有把握哪個英文才對，所以管理員也要能改。
--
-- Postgres 的 permissive policy 是 OR 起來的：加這一條不用（也不該）動原本的
-- finance_can_update_leave_types，兩者並存，任一條通過就放行。
--
-- 沒跑這支的話，管理員在「管理後台 → 假別英文名稱」按儲存會看到
-- 「沒有權限寫入」—— 這是刻意的，因為 RLS 擋下 UPDATE 時 Postgres 只會回
-- 0 列、不會報錯，前端如果不把 0 列當失敗，就會變成假的成功訊息。
--
-- 在 Supabase Dashboard 的 SQL Editor 手動執行一次。可以重複執行。

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'leave_types'
      and policyname = 'admins_can_update_leave_types'
  ) then
    create policy admins_can_update_leave_types
      on public.leave_types for update
      to authenticated
      using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
      with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
  end if;
end $$;
