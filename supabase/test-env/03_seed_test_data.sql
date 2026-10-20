-- ============================================================================
-- 在「測試」專案的 SQL Editor 執行：建立假帳號與兩期示範用的按摩
-- ============================================================================
--
-- ⚠️ 只能在測試專案執行。這支會「新增」帳號，在正式專案執行會多出一批假同仁。
--    為了防呆，下面第一段會檢查：資料庫裡已經有超過 5 個帳號就停止，什麼都不做。
--
-- 執行前請先改下面兩行（在 declare 區塊裡）：
--   v_password  所有測試帳號共用的登入密碼
--   v_my_slack  你自己的 Slack 成員 ID（U 開頭）。填了之後「測試管理員」這個
--               帳號的 Slack 通知會私訊給你；先留空也可以，之後到網頁後台填。
--
-- 建立的帳號（全部是假的，Email 用的是保留給範例用的 example.com，收不到信）：
--   admin@example.com     測試管理員   管理員，也是按摩負責人
--   hr@example.com        測試人資     HR
--   staff01@example.com … staff14@example.com   測試同仁01～14
--
-- 建立的兩期按摩（日期都是「下一個上班日之後」的平日）：
--   第一期「開放報名中」：已經有 6 位測試同仁報名，你可以自己報名、取消。
--   第二期「報名已截止」：已經有 13 位報名（名額 9），可以直接到投影畫面抽籤。

do $$
declare
  v_password text := 'Test-1234';   -- ← 改成你要的密碼
  v_my_slack text := '';            -- ← 你的 Slack 成員 ID，例如 'U01ABCDEF'；可留空

  v_people jsonb;
  p jsonb;
  v_id uuid;
  v_cols text;
  v_vals text;
  v_set text;
  v_day date;
  v_s1 uuid;
  v_s2 uuid;
  v_admin uuid;
  i int;
begin
  if (select count(*) from public.users) > 5 then
    raise exception '這個資料庫已經有 % 個帳號，看起來不是測試專案，已停止。', (select count(*) from public.users);
  end if;

  v_people := jsonb_build_array(
    jsonb_build_object('email', 'admin@example.com', 'full_name', '測試管理員', 'department', '測試管理部',
                       'job_title', '管理員', 'is_admin', true, 'is_finance', false,
                       'slack_user_id', nullif(v_my_slack, '')),
    jsonb_build_object('email', 'hr@example.com', 'full_name', '測試人資', 'department', '測試管理部',
                       'job_title', 'HR', 'is_admin', false, 'is_finance', true)
  );
  for i in 1..14 loop
    v_people := v_people || jsonb_build_array(jsonb_build_object(
      'email', format('staff%s@example.com', lpad(i::text, 2, '0')),
      'full_name', format('測試同仁%s', lpad(i::text, 2, '0')),
      'department', case when i % 2 = 0 then '測試一部' else '測試二部' end,
      'job_title', '專員', 'is_admin', false, 'is_finance', false));
  end loop;

  for p in select * from jsonb_array_elements(v_people) loop
    v_id := gen_random_uuid();

    -- 1) 登入帳號（Supabase Auth）
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      p->>'email', extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p->>'full_name'),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text, 'email',
            jsonb_build_object('sub', v_id::text, 'email', p->>'email', 'email_verified', true),
            now(), now(), now());

    -- 2) 系統裡的同仁資料。只寫 users 資料表「真的有」的欄位，其餘用預設值；
    --    如果正式專案有「建立登入帳號時自動建一筆 users」的觸發器，這裡改成更新那筆。
    p := p || jsonb_build_object('id', v_id, 'role', 'employee', 'is_active', true, 'language', 'zh');
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position),
           string_agg(format('%L', p->>c.column_name), ', ' order by c.ordinal_position),
           string_agg(format('%I = excluded.%I', c.column_name, c.column_name), ', ' order by c.ordinal_position)
      into v_cols, v_vals, v_set
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'users'
       and p ? c.column_name and p->>c.column_name is not null;
    execute format('insert into public.users (%s) values (%s) on conflict (id) do update set %s', v_cols, v_vals, v_set);

    if p->>'email' = 'admin@example.com' then v_admin := v_id; end if;
  end loop;

  -- 3) 按摩負責人 = 測試管理員
  insert into public.massage_settings (id, owner_id) values (true, v_admin)
  on conflict (id) do update set owner_id = excluded.owner_id, updated_at = now();

  -- 4) 兩期按摩：找「今天（台北）之後第 2 個起」的平日，兩期各占一天
  v_day := (now() at time zone 'Asia/Taipei')::date + 2;
  while extract(isodow from v_day) > 5 loop v_day := v_day + 1; end loop;

  insert into public.massage_sessions (title, session_date, signup_deadline, cancel_deadline, draw_scheduled_at)
  values (format('%s/%s 盲人按摩（測試・開放報名中）', extract(month from v_day), extract(day from v_day)),
          v_day,
          ((v_day - 1)::text || ' 12:00+08')::timestamptz,
          (v_day::text || ' 12:00+08')::timestamptz,
          ((v_day - 1)::text || ' 16:00+08')::timestamptz)
  returning id into v_s1;

  v_day := v_day + 1;
  while extract(isodow from v_day) > 5 loop v_day := v_day + 1; end loop;

  -- 第二期先用「還沒截止」建立，讓報名能寫進去，報完再把截止時間改成剛剛過
  insert into public.massage_sessions (title, session_date, signup_deadline, cancel_deadline, draw_scheduled_at)
  values (format('%s/%s 盲人按摩（測試・可以抽籤）', extract(month from v_day), extract(day from v_day)),
          v_day,
          ((v_day - 1)::text || ' 12:00+08')::timestamptz,
          (v_day::text || ' 12:00+08')::timestamptz,
          null)
  returning id into v_s2;

  -- 5) 報名：走正式的報名函式，異動紀錄才會跟真的一樣
  for p in select to_jsonb(u) from public.users u where u.full_name like '測試同仁%' order by u.full_name limit 6 loop
    perform public.massage_sign_up_as(v_s1, (p->>'id')::uuid);
  end loop;
  for p in select to_jsonb(u) from public.users u where u.full_name like '測試同仁%' order by u.full_name limit 13 loop
    perform public.massage_sign_up_as(v_s2, (p->>'id')::uuid);
  end loop;

  update public.massage_sessions set signup_deadline = now() - interval '1 minute' where id = v_s2;

  raise notice '完成：16 個測試帳號、2 期按摩。登入帳號 admin@example.com，密碼就是你在最上面設定的那個。';
end $$;
