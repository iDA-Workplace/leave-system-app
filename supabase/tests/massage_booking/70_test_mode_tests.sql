-- 按摩通知測試模式（20261111_massage_test_mode.sql）。接在 00_stub.sql＋20261019 之後跑：
--   psql -d mt -f supabase/migrations/20261111_massage_test_mode.sql
--   psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/70_test_mode_tests.sql
-- 實際「訊息發去哪裡」在 massage-notify 裡，這裡只測開關本身。

truncate t.results;
insert into public.users (id, full_name, is_admin, is_finance, is_active) values
  ('70000000-0000-0000-0000-000000000001', '管理員', true, false, true),
  ('70000000-0000-0000-0000-000000000002', 'HR', false, true, true),
  ('70000000-0000-0000-0000-000000000003', '員工', false, false, true)
on conflict (id) do nothing;

select t.ok('T1 跑完 migration 就是測試模式（上線前預設開著）',
  (select test_mode from public.massage_settings) = true);

set role authenticated;
select t.as_user('70000000-0000-0000-0000-000000000003');
select t.ok('T2 一般員工不能改', (public.massage_set_test_mode(false, null))->>'code' = 'not_allowed');

select t.as_user('70000000-0000-0000-0000-000000000001');
select t.ok('T3 頻道 ID 格式錯 → bad_channel', (public.massage_set_test_mode(true, '#general'))->>'code' = 'bad_channel');
select t.ok('T4 管理員設定測試頻道（小寫會轉大寫）', (public.massage_set_test_mode(true, ' c0abc1234 '))->>'ok' = 'true');
reset role;
select t.ok('T5 存成大寫、去掉空白', (select test_channel from public.massage_settings) = 'C0ABC1234'
  and (select test_mode from public.massage_settings));

set role authenticated;
select t.as_user('70000000-0000-0000-0000-000000000002');
select t.ok('T6 HR 可以關掉、清空頻道', (public.massage_set_test_mode(false, '  '))->>'ok' = 'true');
reset role;
select t.ok('T7 關掉、頻道清空', not (select test_mode from public.massage_settings)
  and (select test_channel from public.massage_settings) is null);

select t.ok('T8 有留異動紀錄', exists (select 1 from public.massage_events where event = 'test_mode_changed'
  and details->>'test_mode' = 'false'));

-- 再跑一次 migration：已經關掉的不會被打開
\i supabase/migrations/20261111_massage_test_mode.sql
select t.ok('T9 重跑 migration 不會把已關掉的開關又打開', not (select test_mode from public.massage_settings));

set role anon;
select t.as_user(null);
select t.ok('T10 沒登入不能呼叫', not has_function_privilege('anon', 'public.massage_set_test_mode(boolean, text)', 'execute'));
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name from t.results order by n;
do $$ begin
  if exists (select 1 from t.results where not pass) then raise exception '有測試沒過'; end if;
end $$;
