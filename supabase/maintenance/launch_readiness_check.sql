-- ============================================================================
-- 上線前檢查（只讀取、不修改任何資料）
-- ============================================================================
--
-- 一次列出上線前要確認的項目：測試資料清了沒、按摩測試模式關了沒、
-- 每位在職同仁的帳號資料齊不齊（Slack ID、審核流程、直屬主管、入職日期、部門）。
--
-- 用法：Supabase 主控台 → SQL Editor，整份貼上執行。可以隨時重複執行。
-- 「名單」欄位是同仁姓名，只在你自己的 SQL Editor 顯示。
-- ============================================================================

with active as (
  select * from public.users where coalesce(is_active, true)
)
select 1 as 順序, '測試資料：請假單（上線前應為 0）' as 項目,
       (select count(*) from public.leave_requests)::text as 數量, null::text as 名單
union all
select 2, '測試資料：考核作答＋主管評分（上線前應為 0）',
       ((select count(*) from public.review_responses) + (select count(*) from public.review_evaluations))::text, null
union all
select 3, '測試資料：按摩期數（上線前應為 0，除非已經開了正式的一期）',
       (select count(*) from public.massage_sessions)::text,
       (select string_agg(title || '（' || session_date || '）', '、' order by session_date) from public.massage_sessions)
union all
select 4, '按摩測試模式（上線應為「關」）',
       coalesce((select case when test_mode then '開' else '關' end from public.massage_settings limit 1), '開（沒有設定，預設是開）'), null
union all
select 5, '按摩負責人',
       coalesce((select u.full_name from public.massage_settings s join public.users u on u.id = s.owner_id limit 1), '未設定'), null
union all
select 6, '新人開通申請（測試的可在網頁「待開通」移除）',
       (select count(*) from public.onboarding_requests where status = 'pending')::text || ' 筆待開通',
       (select string_agg(full_name, '、') from public.onboarding_requests where status = 'pending')
union all
select 7, '在職同仁人數', (select count(*) from active)::text, null
union all
select 8, '缺 Slack User ID（收不到 Slack 通知）',
       (select count(*) from active where nullif(trim(slack_user_id), '') is null)::text,
       (select string_agg(full_name, '、' order by full_name) from active where nullif(trim(slack_user_id), '') is null)
union all
select 9, '缺審核流程（送不出假單）',
       (select count(*) from active where default_flow_id is null)::text,
       (select string_agg(full_name, '、' order by full_name) from active where default_flow_id is null)
union all
select 10, '缺直屬主管（團隊統計、考核看不到他）',
       (select count(*) from active where manager_id is null)::text,
       (select string_agg(full_name, '、' order by full_name) from active where manager_id is null)
union all
select 11, '缺入職日期（特休算不出來）',
       (select count(*) from active where hire_date is null)::text,
       (select string_agg(full_name, '、' order by full_name) from active where hire_date is null)
union all
select 12, '缺部門',
       (select count(*) from active where nullif(trim(department), '') is null)::text,
       (select string_agg(full_name, '、' order by full_name) from active where nullif(trim(department), '') is null)
union all
select 13, '名稱看起來像測試帳號的在職帳號（含 test／測試）',
       (select count(*) from active where full_name ilike '%test%' or full_name like '%測試%' or email ilike '%test%')::text,
       (select string_agg(full_name, '、' order by full_name) from active where full_name ilike '%test%' or full_name like '%測試%' or email ilike '%test%')
union all
select 14, '核准通知對象（假單核准後會收到通知的人）',
       (select count(*) from public.notification_targets where is_active)::text,
       (select string_agg(u.full_name, '、' order by u.full_name) from public.notification_targets n join public.users u on u.id = n.user_id where n.is_active)
union all
select 15, '2027 年國定假日（應為 17 天）',
       (select count(*) from public.holidays where date between '2027-01-01' and '2027-12-31' and is_holiday)::text, null
union all
select 16, '已開啟 App 通知的裝置', (select count(*) from public.push_subscriptions)::text, null
order by 1;
