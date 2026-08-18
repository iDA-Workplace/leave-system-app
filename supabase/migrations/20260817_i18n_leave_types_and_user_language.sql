-- 中英文切換：兩件必須存在資料庫的東西
--
-- 1. leave_types.name_en —— 假別名稱是資料，不是介面文字，所以沒辦法寫死在
--    前端字典裡。加一個英文名欄位，前端切英文時優先顯示它；沒填就退回原本的
--    中文名（不會變空白）。下面順便把常見的假別自動填好，之後新增的假別由
--    財務在「員工假期管理 → 全公司預設額度」補上英文名。
--
-- 2. users.language —— 語言偏好原本只存在瀏覽器的 localStorage，Slack 的
--    Edge Function 讀不到。存進資料庫之後，Slack 通知才能跟著使用者的選擇
--    切成英文。
--
--    寫入不開放一般的 UPDATE policy：那等於讓每個人都能改自己這一列，
--    role / is_admin 就跟著門戶大開（RLS 沒辦法只鎖某幾個欄位）。改用一支
--    SECURITY DEFINER 函式，只准動 language 這一個欄位、而且只准動自己那列。
--
-- 在 Supabase Dashboard 的 SQL Editor 手動執行一次。可以重複執行。
--
-- ⚠️ 請先跑這支 migration，再部署前端。前端的假單查詢會把 leave_types 整張
--    帶出來（select 用 *），欄位不存在不會炸；但 users.language 的寫入會在
--    個人設定切語言時用到，沒跑會顯示存檔失敗。

-- ===== 1. 假別英文名 =====

alter table public.leave_types
  add column if not exists name_en text;

comment on column public.leave_types.name_en is
  '假別的英文名稱。介面切成 English 時顯示這個；留空則沿用 name（中文）。';

-- 常見假別先自動帶入，只補「還沒填」的，不會蓋掉手動改過的內容。
update public.leave_types set name_en = v.name_en
from (values
  ('特休',       'Annual Leave'),
  ('特休假',     'Annual Leave'),
  ('特別休假',   'Annual Leave'),
  ('年假',       'Annual Leave'),
  ('年休假',     'Annual Leave'),
  ('事假',       'Personal Leave'),
  ('病假',       'Sick Leave'),
  ('普通傷病假', 'Sick Leave'),
  ('婚假',       'Marriage Leave'),
  ('喪假',       'Bereavement Leave'),
  ('產假',       'Maternity Leave'),
  ('陪產假',     'Paternity Leave'),
  ('陪產檢及陪產假', 'Paternity Leave'),
  ('產檢假',     'Prenatal Checkup Leave'),
  ('生理假',     'Menstrual Leave'),
  ('家庭照顧假', 'Family Care Leave'),
  ('公假',       'Official Leave'),
  ('公傷病假',   'Occupational Injury Leave'),
  ('補休',       'Compensatory Leave'),
  ('育嬰假',     'Parental Leave'),
  ('育嬰留職停薪', 'Parental Leave'),
  ('防疫照顧假', 'Epidemic Care Leave')
) as v(name, name_en)
where public.leave_types.name = v.name
  and public.leave_types.name_en is null;

-- 上面是精準比對，差一個字就對不到（第一版就漏掉了「特休假」）。特休是唯一
-- 一個系統邏輯真的認得的假別（額度用年資算，跟其他假別不同），所以這裡再補
-- 一條模糊比對當保險。其他假別漏掉頂多是顯示中文名，特休漏掉最刺眼。
update public.leave_types
set name_en = 'Annual Leave'
where name_en is null and name like '%特休%';

-- ===== 2. 使用者語言偏好 =====

alter table public.users
  add column if not exists language text not null default 'zh';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_language_check'
  ) then
    alter table public.users
      add constraint users_language_check check (language in ('zh', 'en'));
  end if;
end $$;

comment on column public.users.language is
  '介面／Slack 通知語言：zh 或 en。網頁端由個人設定透過 set_my_language() 寫入。';

-- 只讓使用者改自己的 language 欄位，其他欄位一律碰不到。
create or replace function public.set_my_language(p_language text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_language not in ('zh', 'en') then
    raise exception 'unsupported language: %', p_language;
  end if;
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  update public.users set language = p_language where id = auth.uid();
end $$;

revoke all on function public.set_my_language(text) from public;
grant execute on function public.set_my_language(text) to authenticated;
