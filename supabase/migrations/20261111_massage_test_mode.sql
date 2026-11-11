-- ============================================================================
-- 2026-11-11 按摩通知「測試模式」（使用者決定：選項 B）
-- ============================================================================
--
-- 為什麼：上線前在正式站測試按摩功能時，「尚有名額」的討論串 tag 到了全公司同仁
-- （正式資料庫裡就是真實同仁和他們的 Slack ID）。測試模式開著的時候，按摩的
-- Slack 訊息不會打擾到任何同仁：
--   · 頻道公告 → 只發到「測試頻道」（沒填測試頻道 → 改私訊負責人）
--   · 給同仁的私訊 → 改私訊負責人，並註明原本要給誰
--   · 「尚有名額」討論串 → 不 tag 人，只列出原本會 tag 的名字
-- 實際的轉發寫在 supabase/functions/massage-notify/index.ts（讀這裡的設定）。
-- 開關在網頁「管理後台 → 員工福利設定」。
--
-- 預設：**開著**（這份 migration 執行的當下就進入測試模式）——正式上線那天再到
-- 員工福利設定關掉。可以重複執行（不會把已經關掉的開關又打開：只在新增欄位時設預設值）。

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'massage_settings' and column_name = 'test_mode') then
    alter table public.massage_settings add column test_mode boolean not null default true;
    -- 之後新增的列（實際上只有一列）預設關閉；這一列在加欄位時已經是 true
    alter table public.massage_settings alter column test_mode set default false;
  end if;
end $$;

alter table public.massage_settings add column if not exists test_channel text;

comment on column public.massage_settings.test_mode is
  '按摩通知測試模式：開著時 Slack 訊息只發到 test_channel（或負責人），不私訊、不 tag 任何同仁。';
comment on column public.massage_settings.test_channel is
  '測試模式用的 Slack 頻道 ID（C 或 G 開頭）。空白 = 頻道公告改私訊負責人。';

create or replace function public.massage_set_test_mode(p_on boolean, p_channel text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ch text := nullif(upper(trim(coalesce(p_channel, ''))), '');
begin
  if not public.is_massage_manager() then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;
  if ch is not null and ch !~ '^[CG][A-Z0-9]{6,}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_channel');
  end if;
  perform public.massage_log(null, null, null, auth.uid(), 'test_mode_changed', null,
    jsonb_build_object('test_mode', coalesce(p_on, false), 'test_channel', ch));
  update public.massage_settings
     set test_mode = coalesce(p_on, false), test_channel = ch,
         updated_by = auth.uid(), updated_at = now()
   where id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.massage_set_test_mode(boolean, text) from public, anon;
grant execute on function public.massage_set_test_mode(boolean, text) to authenticated;
