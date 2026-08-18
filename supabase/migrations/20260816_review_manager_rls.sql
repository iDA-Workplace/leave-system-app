-- 修正：主管在「部門考核設定 → 考核題目 → 新增模板」時出現
--   new row violates row-level security policy for table "review_templates"
-- 但同樣的操作老闆卻可以成功。
--
-- ── 根本原因 ────────────────────────────────────────────────────────
-- 這個系統的權限規則同時存在於「兩個地方」，而它們從來沒有對齊過：
--
--   1. 前端 Review.jsx 的 EVALUATOR_ROLES = supervisor / deputy_supervisor
--      / boss —— 決定「誰看得到部門考核設定這個畫面」
--   2. 資料庫的 RLS policy —— 決定「誰真的寫得進去」
--
-- review_templates、annual_reviews 這些表在這個專案開始之前就存在，它們
-- 原本的 policy 是照更早期的權限模型寫的（老闆／管理員才能寫）。後來前端
-- 把整個「部門考核設定」開放給主管，卻沒有人回頭補資料庫那一側 —— 於是
-- 主管看得到畫面、按得到按鈕，一送出就被資料庫擋下來。老闆剛好符合舊的
-- policy 條件，所以完全正常，問題只在主管身上顯現。
--
-- 20260813 修過 review_flows/review_flow_steps 的同一類問題，但那次只補了
-- 當下故障的那兩張表，沒有把「部門考核設定會寫到的其他表」一起檢查過 ——
-- 所以同樣的問題換一張表又冒出來。這支 migration 把 EVALUATOR_ROLES 會寫
-- 到的表「一次補齊」，就是為了不要再有下一次。
--
-- ── 為什麼用「新增 policy」而不是「修改既有 policy」 ────────────────
-- Postgres 的 permissive policy 是「OR」的關係：同一個操作只要有任何一條
-- policy 放行就通過。所以這裡只新增，完全不動既有的 policy —— 既不需要
-- 知道舊 policy 的內容，也不會破壞老闆／管理員原本就正常的權限。
--
-- 執行一次即可，重複執行安全（每條 policy 都有存在性檢查）。

-- 判斷「這個人是不是考核管理者」。
--
-- 用 SECURITY DEFINER 的理由：這個函式會查 users 表，如果之後有人把它用在
-- users 自己的 policy 上，一般函式會造成 RLS 遞迴查詢而失敗；DEFINER 讓它
-- 以函式擁有者的身分執行，繞開這個陷阱。stable 讓同一次查詢裡重複呼叫時
-- 只算一次。
create or replace function public.is_review_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (u.is_admin or u.role in ('supervisor', 'deputy_supervisor', 'boss'))
  );
$$;

comment on function public.is_review_manager() is
  '對應前端 Review.jsx 的 EVALUATOR_ROLES：主管／副主管／老闆／管理員。'
  '「部門考核設定」與「團隊管理」會寫入的所有資料表都用這個函式判斷寫入權限，'
  '前端與資料庫兩邊的權限規則才不會各走各的。';

revoke all on function public.is_review_manager() from public;
grant execute on function public.is_review_manager() to authenticated;


-- 一次補齊「部門考核設定」與「團隊管理」會寫到的所有資料表。
-- 清單來自 Review.jsx 裡所有的 insert / update / delete / upsert：
--   annual_reviews              考核週期
--   review_templates            考核題目（模板）
--   review_template_questions   考核題目（題目）
--   annual_review_participants  參與者、評分流程推進
--   review_evaluations          主管／老闆的評分內容
-- （review_flows / review_flow_steps 已在 20260813 補過；
--   review_responses 是員工自評，走員工自己的 policy，不在這裡。）
do $$
declare
  t text;
  op text;
  policy_name text;
begin
  foreach t in array array[
    'annual_reviews',
    'review_templates',
    'review_template_questions',
    'annual_review_participants',
    'review_evaluations'
  ] loop
    foreach op in array array['insert', 'update', 'delete'] loop
      policy_name := format('review_managers_can_%s_%s', op, t);

      if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = t and policyname = policy_name
      ) then
        -- INSERT 只能有 WITH CHECK，DELETE 只能有 USING，UPDATE 兩者都要
        if op = 'insert' then
          execute format(
            'create policy %I on public.%I for insert to authenticated with check (public.is_review_manager())',
            policy_name, t);
        elsif op = 'delete' then
          execute format(
            'create policy %I on public.%I for delete to authenticated using (public.is_review_manager())',
            policy_name, t);
        else
          execute format(
            'create policy %I on public.%I for update to authenticated using (public.is_review_manager()) with check (public.is_review_manager())',
            policy_name, t);
        end if;
      end if;
    end loop;
  end loop;
end $$;
