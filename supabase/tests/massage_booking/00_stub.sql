-- Supabase 環境的最小替身：角色、auth.uid()、以及 migration 會讀到的既有資料表
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.users (
  id uuid primary key,
  full_name text,
  role text default 'employee',
  is_active boolean default true,
  is_admin boolean not null default false,
  is_finance boolean not null default false,
  slack_user_id text,
  language text
);
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  name text, name_en text, is_wfh boolean default false
);
create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.users(id),
  leave_type_id uuid references public.leave_types(id),
  start_date date, end_date date,
  start_time time, end_time time,
  status text
);
grant select on public.users, public.leave_types, public.leave_requests to authenticated;
grant all on public.users, public.leave_types, public.leave_requests to service_role;

-- 測試結果
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
create function t.ok(p_name text, p_cond boolean, p_detail text default null) returns void
language sql security definer as $$
  insert into t.results (name, pass, detail) values (p_name, coalesce(p_cond, false), p_detail)
$$;
grant usage on schema t to anon, authenticated, service_role;
grant execute on function t.ok(text, boolean, text) to anon, authenticated, service_role;

-- 以某人身分執行（搭配 set role）
create function t.as_user(p uuid) returns void language sql as $$
  select set_config('test.uid', coalesce(p::text, ''), false)
$$;
grant execute on function t.as_user(uuid) to anon, authenticated, service_role;
