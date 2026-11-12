-- ============================================================================
-- 假單資料權限＋附件不公開（第 2 階段第 6 步）
-- ============================================================================
--
-- 使用者 2026-11 決定（資料庫層級，不只是畫面藏起來）：
--
--   誰                         看得到「完整」假單（事由、附件、簽核紀錄…）
--   ─────────────────────────  ───────────────────────────────────────────────
--   本人                       自己的全部假單
--   簽核人                     自己在那張假單簽核流程裡的任一關（輪到了沒、簽完了沒都算），
--                              以及自己簽過的
--   主管                       直屬部屬（users.manager_id = 自己）的假單
--   HR                         全部
--   只有管理員身分的帳號        跟一般同仁一樣
--   職務代理人                  跟一般同仁一樣（只看得到誰、哪天、什麼假）
--
--   其他同仁的假：只看得到「已核准」的假單是「誰、哪天、什麼假、幾點到幾點」
--   （首頁日曆、某天誰請假），走 approved_leaves_between()，拿不到事由與附件。
--
--   附件：儲存空間（leave-attachments）改成不公開。網站用「有時效的連結」開啟，
--   只有看得到那張假單完整內容的人（加上上傳的本人）開得了。
--
-- 這支做的事：
--   1. can_view_leave()：判斷「這張假單我能不能看完整內容」
--   2. leave_requests 的讀取規則換成 can_view_leave()（原本是登入就全部看得到）
--   3. leave_approvals（簽核紀錄、簽核意見）跟著假單走：看得到假單才看得到簽核紀錄
--   4. approved_leaves_between()：給首頁日曆用，只回「已核准、不含事由」的欄位
--   5. 附件：leave_requests 加 attachment_path；儲存空間改不公開；讀取／上傳規則
--
-- Slack、每日彙整、按摩等後台程式用的是後台身分（service role），不受影響。
--
-- ⚠️ 這支要「先執行、再合併網站」：新版網站的首頁日曆要用 approved_leaves_between()。
--    舊版網站在這支執行後、合併前的空檔：首頁「某天誰請假」只會列出自己看得到的人，
--    附件因為原本就沒有地方可以打開，不受影響。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以重複執行。
-- ============================================================================


-- 1. 能不能看這張假單的完整內容 ---------------------------------------------------
create or replace function public.can_view_leave(p_requester uuid, p_flow uuid, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
       p_requester = auth.uid()                                          -- 本人
    or public.is_hr_user()                                               -- HR（在職）
    or exists (select 1 from public.users u                              -- 直屬主管
                where u.id = p_requester and u.manager_id = auth.uid())
    or (p_flow is not null and exists (select 1 from public.approval_flow_steps s   -- 流程裡的簽核人
                where s.flow_id = p_flow and s.approver_id = auth.uid()))
    or exists (select 1 from public.leave_approvals a                    -- 簽過這張的人（流程後來改過也算）
                where a.request_id = p_id and a.approver_id = auth.uid())
  );
$$;

revoke all on function public.can_view_leave(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_view_leave(uuid, uuid, uuid) to authenticated, service_role;


-- 2. 假單的讀取規則 ---------------------------------------------------------------
-- 原本的 requests_select 是「登入就能讀全部」。新增、修改、刪除的規則不動。
drop policy if exists requests_select on public.leave_requests;
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (public.can_view_leave(requester_id, flow_id, id));


-- 3. 簽核紀錄跟著假單走 -------------------------------------------------------------
-- 原本：簽核人本人、申請人、role = 'admin'（沒有人是）。HR 與主管讀不到別人的簽核紀錄。
drop policy if exists approvals_select on public.leave_approvals;
create policy approvals_select on public.leave_approvals
  for select to authenticated
  using (exists (select 1 from public.leave_requests lr
                  where lr.id = leave_approvals.request_id
                    and public.can_view_leave(lr.requester_id, lr.flow_id, lr.id)));


-- 4. 其他同仁的假（首頁日曆、某天誰請假）：只有已核准、只有基本欄位 ---------------------
create or replace function public.approved_leaves_between(p_start date, p_end date)
returns table (
  id uuid,
  requester_id uuid,
  requester_name text,
  leave_type_name text,
  leave_type_name_en text,
  start_date date,
  end_date date,
  start_time text,
  end_time text,
  hours numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select lr.id, lr.requester_id, u.full_name, lt.name, lt.name_en,
         lr.start_date, coalesce(lr.end_date, lr.start_date),
         lr.start_time::text, lr.end_time::text, lr.hours
    from public.leave_requests lr
    join public.users u on u.id = lr.requester_id
    left join public.leave_types lt on lt.id = lr.leave_type_id
   where auth.uid() is not null
     and lr.status = 'approved'
     and lr.start_date <= p_end
     and coalesce(lr.end_date, lr.start_date) >= p_start
   order by lr.start_date, u.full_name;
$$;

revoke all on function public.approved_leaves_between(date, date) from public, anon;
grant execute on function public.approved_leaves_between(date, date) to authenticated;


-- 5. 附件不公開 -------------------------------------------------------------------
-- 5-1. 存「檔案在儲存空間裡的路徑」：以前只存公開網址，改成不公開後要用路徑產生有時效的連結
alter table public.leave_requests add column if not exists attachment_path text;
comment on column public.leave_requests.attachment_path is
  '附件在 leave-attachments 儲存空間裡的路徑（<上傳者 id>/<時間>-<檔名>）。2026-11 起附件不公開，網站用這個產生有時效的連結。';

-- 網址裡的 %XX 轉回原本的字（中文檔名會被編碼）
create or replace function public.url_decode_path(p text)
returns text language plpgsql immutable as $$
declare
  out_bytes bytea := ''::bytea;
  i integer := 1;
  n integer := length(p);
  ch text;
begin
  while i <= n loop
    ch := substr(p, i, 1);
    if ch = '%' and i + 2 <= n and substr(p, i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
      out_bytes := out_bytes || decode(substr(p, i + 1, 2), 'hex');
      i := i + 3;
    else
      out_bytes := out_bytes || convert_to(ch, 'UTF8');
      i := i + 1;
    end if;
  end loop;
  return convert_from(out_bytes, 'UTF8');
exception when others then
  return p;   -- 解不出來就原樣保留
end;
$$;

update public.leave_requests
   set attachment_path = public.url_decode_path(substring(attachment_url from '/leave-attachments/([^?#]+)'))
 where attachment_path is null and attachment_url like '%/leave-attachments/%';

-- 5-2. 能不能開這個檔案：上傳的本人，或看得到那張假單完整內容的人
create or replace function public.can_view_leave_attachment(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
       split_part(p_name, '/', 1) = auth.uid()::text
    or exists (select 1 from public.leave_requests lr
                where lr.attachment_path = p_name
                  and public.can_view_leave(lr.requester_id, lr.flow_id, lr.id))
  );
$$;

revoke all on function public.can_view_leave_attachment(text) from public, anon;
grant execute on function public.can_view_leave_attachment(text) to authenticated;

-- 5-3. 儲存空間改不公開
update storage.buckets set public = false where id = 'leave-attachments';

drop policy if exists "leave-attachments public read" on storage.objects;
drop policy if exists "leave-attachments read" on storage.objects;
create policy "leave-attachments read" on storage.objects
  for select to authenticated
  using (bucket_id = 'leave-attachments' and public.can_view_leave_attachment(name));

-- 上傳只能放進自己的資料夾（網站本來就是這樣放：<自己的 id>/...）
drop policy if exists "leave-attachments authenticated upload" on storage.objects;
drop policy if exists "leave-attachments upload own folder" on storage.objects;
create policy "leave-attachments upload own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'leave-attachments' and split_part(name, '/', 1) = auth.uid()::text);


-- ============================================================================
-- 驗收（SQL Editor 只顯示最後一段的結果）
--   leave_requests 的讀取規則應該只有 leave_requests_select 一條；
--   leave-attachments 應該是「不公開」；有附件的假單都要有路徑
-- ============================================================================
select '假單讀取規則' as 項目, string_agg(policyname, '、') as 結果
  from pg_policies where schemaname = 'public' and tablename = 'leave_requests' and cmd = 'SELECT'
union all
select '附件儲存空間', case when public then '公開（不對）' else '不公開' end
  from storage.buckets where id = 'leave-attachments'
union all
select '有附件但沒有路徑的假單（應為 0）', count(*)::text
  from public.leave_requests where attachment_url is not null and attachment_path is null;
