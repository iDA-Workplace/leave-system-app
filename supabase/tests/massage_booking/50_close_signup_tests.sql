-- 20261024_massage_close_signup.sql 的測試（接在 10_tests.sql 之後跑，沿用它的小工具）
\set ON_ERROR_STOP 1
set client_min_messages = warning;
truncate t.results;
reset role;

select t.mk('e5000000-0000-0000-0000-000000000001', t.td() + 80);
set role authenticated;
select t.as_user(t.e(398)); select public.massage_sign_up('e5000000-0000-0000-0000-000000000001');

select t.ok('提前截止：一般同仁不能用',
  public.massage_close_signup('e5000000-0000-0000-0000-000000000001')->>'code' = 'not_allowed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000002');   -- HR
select t.ok('提前截止：管理者可以用', (public.massage_close_signup('e5000000-0000-0000-0000-000000000001')->>'ok')::bool);
reset role;
select t.ok('提前截止：截止時間變成現在',
  (select signup_deadline <= now() from public.massage_sessions where id = 'e5000000-0000-0000-0000-000000000001'));
select t.ok('提前截止：記一筆異動紀錄（含原本的截止時間）',
  exists (select 1 from public.massage_events
           where session_id = 'e5000000-0000-0000-0000-000000000001' and event = 'signup_closed_early'
             and details ? 'previous_deadline' and actor_id = 'aaaaaaaa-0000-0000-0000-000000000002'));

set role authenticated;
select t.as_user(t.e(397));
select t.ok('提前截止：之後就不能報名',
  public.massage_sign_up('e5000000-0000-0000-0000-000000000001')->>'code' = 'signup_closed');
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok('提前截止：已經截止的不能再按',
  public.massage_close_signup('e5000000-0000-0000-0000-000000000001')->>'code' = 'signup_closed');
select t.ok('提前截止：截止後可以抽籤',
  (public.massage_run_draw('e5000000-0000-0000-0000-000000000001')->>'ok')::bool);
select t.ok('提前截止：抽過籤的不能用',
  public.massage_close_signup('e5000000-0000-0000-0000-000000000001')->>'code' = 'already_drawn');
reset role;

select name, pass, detail from t.results order by n;
select format('%s / %s 通過', count(*) filter (where pass), count(*)) from t.results;
