-- 正式資料庫的替身：資料表＋「2026-11 匯出時」的權限規則，一字不差照抄。
-- 給 migrations/20261110_security_lockdown.sql 的測試用。**不要在 Supabase 上跑。**
-- 角色是整個 Postgres 共用的，跑過別的測試（例如按摩預約）就已經存在
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.approval_flows (
  id uuid primary key default gen_random_uuid(), name text, is_default boolean default false, is_active boolean default true
);
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, full_name text, role text default 'employee', slack_user_id text,
  is_active boolean default true, created_at timestamptz default now(),
  default_flow_id uuid references public.approval_flows(id), hire_date date,
  manager_id uuid references public.users(id), is_admin boolean default false,
  department text, job_title text, english_name text, is_finance boolean default false,
  language text default 'zh'
);
create table public.approval_flow_steps (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid references public.approval_flows(id), step_order integer,
  approver_id uuid references public.users(id) on delete restrict
);
create table public.leave_types (id uuid primary key default gen_random_uuid(), name text, is_annual boolean default false);
create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.users(id) on delete cascade,
  leave_type_id uuid references public.leave_types(id),
  flow_id uuid references public.approval_flows(id),
  start_date date, end_date date, start_time time, end_time time, hours numeric,
  proxy_user_id uuid references public.users(id) on delete set null,
  reason text, attachment_url text, attachment_name text,
  status text default 'pending', current_step integer default 1,
  created_at timestamptz default now(),
  registered_by uuid references public.users(id),
  ack_deadline timestamptz, acknowledged_at timestamptz, auto_acknowledged boolean not null default false,
  disputed_at timestamptz, dispute_reason text, approver_message_refs jsonb
);
create table public.leave_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.leave_requests(id) on delete cascade,
  approver_id uuid references public.users(id) on delete restrict,
  original_approver_id uuid references public.users(id) on delete restrict,
  step_order integer, action text, comment text, created_at timestamptz default now()
);
create table public.notification_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade, is_active boolean default true
);

-- Supabase 預設：public 的資料表對 anon / authenticated 全開，靠 RLS 擋
grant all on all tables in schema public to anon, authenticated, service_role;

alter table public.users enable row level security;
alter table public.approval_flows enable row level security;
alter table public.approval_flow_steps enable row level security;
alter table public.leave_types enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_approvals enable row level security;
alter table public.notification_targets enable row level security;

-- ===== 以下照抄正式資料庫的權限規則 =====
create policy admins_can_delete_approval_flow_steps on public.approval_flow_steps for delete to authenticated using (exists (select 1 from users u where u.id = auth.uid() and u.is_admin));
create policy admins_can_insert_approval_flow_steps on public.approval_flow_steps for insert to authenticated with check (exists (select 1 from users u where u.id = auth.uid() and u.is_admin));
create policy admins_can_update_approval_flow_steps on public.approval_flow_steps for update to authenticated using (exists (select 1 from users u where u.id = auth.uid() and u.is_admin)) with check (exists (select 1 from users u where u.id = auth.uid() and u.is_admin));
create policy flow_steps_admin on public.approval_flow_steps for all using (exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin'));
create policy flow_steps_select on public.approval_flow_steps for select using (auth.uid() is not null);
create policy flows_select on public.approval_flows for select using (auth.uid() is not null);

create policy approvals_insert on public.leave_approvals for insert with check (auth.uid() = approver_id);
create policy approvals_select on public.leave_approvals for select using ((auth.uid() = approver_id) or (exists (select 1 from leave_requests lr where lr.id = leave_approvals.request_id and lr.requester_id = auth.uid())) or (exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin')));

create policy approvers_can_update_leave_requests on public.leave_requests for update to authenticated
  using ((auth.uid() = requester_id) or (exists (select 1 from approval_flow_steps afs where afs.flow_id = leave_requests.flow_id and afs.step_order = leave_requests.current_step and afs.approver_id = auth.uid())) or (exists (select 1 from users u where u.id = auth.uid() and u.is_admin)))
  with check (true);
create policy finance_can_delete_leave_requests on public.leave_requests for delete to authenticated
  using ((exists (select 1 from users u where u.id = auth.uid() and u.is_finance)) and ((registered_by is null) or (registered_by = auth.uid())));
create policy finance_can_register_leave_for_others on public.leave_requests for insert to authenticated
  with check ((registered_by = auth.uid()) and (exists (select 1 from users u where u.id = auth.uid() and u.is_finance)));
create policy finance_can_update_leave_requests on public.leave_requests for update to authenticated
  using ((exists (select 1 from users u where u.id = auth.uid() and u.is_finance)) and ((registered_by is null) or (registered_by = auth.uid())))
  with check ((exists (select 1 from users u where u.id = auth.uid() and u.is_finance)) and ((registered_by is null) or (registered_by = auth.uid())));
create policy requester_can_acknowledge_registered_leave on public.leave_requests for update to authenticated
  using ((requester_id = auth.uid()) and (registered_by is not null)) with check ((requester_id = auth.uid()) and (registered_by is not null));
create policy requests_insert on public.leave_requests for insert with check (auth.uid() = requester_id);
create policy requests_select on public.leave_requests for select using (auth.uid() is not null);
create policy requests_update_own on public.leave_requests for update
  using ((auth.uid() = requester_id) or (exists (select 1 from users u where u.id = auth.uid() and u.role = any (array['admin', 'supervisor']))));

create policy leave_types_select on public.leave_types for select using (auth.uid() is not null);

create policy notif_targets_admin on public.notification_targets for all using (exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin'));
create policy notif_targets_select on public.notification_targets for select using (auth.uid() is not null);

create policy admins_can_update_users on public.users for update to authenticated using (exists (select 1 from users u where u.id = auth.uid() and u.is_admin)) with check (exists (select 1 from users u where u.id = auth.uid() and u.is_admin));
create policy finance_can_update_users on public.users for update to authenticated using (exists (select 1 from users u where u.id = auth.uid() and u.is_finance)) with check (exists (select 1 from users u where u.id = auth.uid() and u.is_finance));
create policy users_admin_delete on public.users for delete using (exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin'));
create policy users_insert on public.users for insert with check (true);
create policy users_select on public.users for select using (true);
create policy users_update_admin on public.users for update using (exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin'));
create policy users_update_self on public.users for update using (auth.uid() = id);

-- 正式資料庫的函式／檢視表（照抄；檢視表只留測試用得到的欄位）
create function public.handle_new_user() returns trigger language plpgsql security definer as $$
declare default_flow uuid;
begin
  select id into default_flow from public.approval_flows where is_default = true limit 1;
  insert into public.users (id, email, full_name, role, default_flow_id)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email),
          coalesce(new.raw_user_meta_data->>'role', 'employee'), default_flow);
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.set_my_language(p_language text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_language not in ('zh', 'en') then raise exception 'unsupported language: %', p_language; end if;
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.users set language = p_language where id = auth.uid();
end $$;
grant execute on function public.set_my_language(text) to anon, authenticated;

create view public.annual_leave_summary as select u.id as user_id, u.full_name, u.hire_date from public.users u where u.is_active = true;
grant select on public.annual_leave_summary to anon, authenticated, service_role;

-- ===== 測試工具 =====
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
create function t.ok(p_name text, p_cond boolean, p_detail text default null) returns void
language sql security definer as $$
  insert into t.results (name, pass, detail) values (p_name, coalesce(p_cond, false), p_detail)
$$;
-- 用目前的角色執行一段 SQL，回傳「影響幾筆」或錯誤代碼
create function t.run(p_sql text) returns text language plpgsql as $$
declare n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'rows=' || n;
exception when others then
  return 'err:' || sqlstate;
end $$;
create function t.as_user(p uuid) returns void language sql as $$
  select set_config('test.uid', coalesce(p::text, ''), false)
$$;
grant usage on schema t to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;
