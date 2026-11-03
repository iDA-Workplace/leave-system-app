-- ============================================================================
-- 只能在「測試」專案執行：建立請假需要的假別與簽核流程，讓測試帳號可以請假
-- ============================================================================
--
-- 要在 03_seed_test_data.sql 之後執行。
--
-- 防呆：只要登入帳號裡有任何一個不是 @example.com 的（也就是可能有真的
-- 同仁），就停止、什麼都不做。
--
-- 建立的內容：
--   假別（只有在測試專案還沒有任何假別時才建立；已經用 02 複製過正式的
--   假別就沿用那些，不重複建立）：
--     特休、事假、病假、在家工作（WFH）
--   簽核流程：
--     「測試流程（主管簽核）」第 1 關 = 測試管理員 → 測試人資與 14 位測試同仁用這個
--     「測試流程（人資簽核）」第 1 關 = 測試人資   → 測試管理員用這個
--   （不讓測試管理員簽自己的假單，比較接近真實情況）
--
-- 跟 03 一樣：只寫資料表「真的有」的欄位，其餘用預設值。正式專案的
-- 假別／流程資料表如果有其他必填欄位，執行時會出現紅字錯誤，把錯誤訊息
-- 給 Claude 即可。

-- 依資料表實際有的欄位插入一列，回傳 id（暫存函式，這次執行結束就消失）
create or replace function pg_temp.ins(p_table text, p_row jsonb)
returns uuid
language plpgsql
as $$
declare
  v_cols text;
  v_vals text;
  v_id uuid;
begin
  select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position),
         string_agg(format('%L', p_row->>c.column_name), ', ' order by c.ordinal_position)
    into v_cols, v_vals
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_table
     and p_row ? c.column_name and p_row->>c.column_name is not null;
  execute format('insert into public.%I (%s) values (%s) returning id', p_table, v_cols, v_vals) into v_id;
  return v_id;
end;
$$;

do $$
declare
  v_admin uuid;
  v_hr uuid;
  v_flow_mgr uuid;
  v_flow_hr uuid;
begin
  if exists (select 1 from auth.users where email not like '%@example.com') then
    raise exception '這個專案有不是 @example.com 的帳號，看起來不是測試專案，已停止。';
  end if;

  select id into v_admin from public.users where full_name = '測試管理員';
  select id into v_hr from public.users where full_name = '測試人資';
  if v_admin is null or v_hr is null then
    raise exception '找不到「測試管理員」或「測試人資」，請先執行 03_seed_test_data.sql。';
  end if;

  -- 1) 假別（測試專案裡還沒有任何假別時才建）
  if not exists (select 1 from public.leave_types) then
    perform pg_temp.ins('leave_types', jsonb_build_object(
      'name', '特休', 'name_en', 'Annual leave', 'is_active', true, 'is_annual', true, 'is_wfh', false));
    perform pg_temp.ins('leave_types', jsonb_build_object(
      'name', '事假', 'name_en', 'Personal leave', 'is_active', true, 'is_annual', false, 'is_wfh', false,
      'annual_quota_hours', 112));
    perform pg_temp.ins('leave_types', jsonb_build_object(
      'name', '病假', 'name_en', 'Sick leave', 'is_active', true, 'is_annual', false, 'is_wfh', false,
      'annual_quota_hours', 240));
    perform pg_temp.ins('leave_types', jsonb_build_object(
      'name', '在家工作', 'name_en', 'Work from home', 'is_active', true, 'is_annual', false, 'is_wfh', true));
    raise notice '已建立 4 種測試假別。';
  else
    raise notice '測試專案已經有假別，沿用現有的，不另外建立。';
  end if;

  -- 2) 簽核流程
  v_flow_mgr := pg_temp.ins('approval_flows', jsonb_build_object(
    'name', '測試流程（主管簽核）', 'is_active', true, 'is_default', true));
  perform pg_temp.ins('approval_flow_steps', jsonb_build_object(
    'flow_id', v_flow_mgr, 'step_order', 1, 'approver_id', v_admin));

  v_flow_hr := pg_temp.ins('approval_flows', jsonb_build_object(
    'name', '測試流程（人資簽核）', 'is_active', true, 'is_default', false));
  perform pg_temp.ins('approval_flow_steps', jsonb_build_object(
    'flow_id', v_flow_hr, 'step_order', 1, 'approver_id', v_hr));

  -- 3) 每個測試帳號的預設簽核流程
  update public.users set default_flow_id = v_flow_mgr where id <> v_admin;
  update public.users set default_flow_id = v_flow_hr where id = v_admin;

  raise notice '完成：2 個簽核流程，測試帳號都已設定預設流程。測試管理員的假單由測試人資簽核，其他人的由測試管理員簽核。';
end $$;
