-- 20261022_massage_hide_sessions.sql 的測試（接在 10_tests.sql 之後跑，沿用它的小工具）
\set ON_ERROR_STOP 1
set client_min_messages = warning;
truncate t.results;
reset role;

select t.mk('d5000000-0000-0000-0000-000000000001', t.td() + 70);
set role authenticated;
select t.as_user(t.e(399)); select public.massage_sign_up('d5000000-0000-0000-0000-000000000001');
reset role;
select t.close('d5000000-0000-0000-0000-000000000001');
set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select public.massage_run_draw('d5000000-0000-0000-0000-000000000001');

select t.as_user(t.e(399));
select t.ok('隱藏：一般同仁不能用', public.massage_set_hidden('d5000000-0000-0000-0000-000000000001', true)->>'code' = 'not_allowed');

select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');   -- HR
select t.ok('隱藏：抽過籤的期數可以隱藏', (public.massage_set_hidden('d5000000-0000-0000-0000-000000000001', true)->>'ok')::bool);
reset role;
select t.ok('隱藏：記下時間與誰隱藏的',
  (select hidden_at is not null and hidden_by = 'aaaaaaaa-0000-0000-0000-000000000002'
     from public.massage_sessions where id = 'd5000000-0000-0000-0000-000000000001'));
select t.ok('隱藏：記一筆 hidden 異動紀錄',
  exists (select 1 from public.massage_events where session_id = 'd5000000-0000-0000-0000-000000000001' and event = 'hidden'));
select t.ok('隱藏：報名資料完全沒動',
  (select count(*) from public.massage_signups where session_id = 'd5000000-0000-0000-0000-000000000001' and slot_no = 1) = 1);
do $$ begin
  delete from public.massage_sessions where id = 'd5000000-0000-0000-0000-000000000001';
  perform t.ok('隱藏：抽過籤的期數還是不能刪除', false);
exception when raise_exception then perform t.ok('隱藏：抽過籤的期數還是不能刪除', true);
end $$;

set role authenticated;
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('隱藏：重複隱藏不會出錯', (public.massage_set_hidden('d5000000-0000-0000-0000-000000000001', true)->>'unchanged')::bool);
select t.ok('隱藏：可以取消隱藏', (public.massage_set_hidden('d5000000-0000-0000-0000-000000000001', false)->>'ok')::bool);
reset role;
select t.ok('隱藏：取消後欄位清空、記一筆 unhidden',
  (select hidden_at is null and hidden_by is null from public.massage_sessions where id = 'd5000000-0000-0000-0000-000000000001')
  and exists (select 1 from public.massage_events where session_id = 'd5000000-0000-0000-0000-000000000001' and event = 'unhidden'));

select name, pass, detail from t.results order by n;
select format('%s / %s 通過', count(*) filter (where pass), count(*)) from t.results;
