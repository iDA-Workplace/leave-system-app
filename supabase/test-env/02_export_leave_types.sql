-- ============================================================================
-- 在「正式」專案的 SQL Editor 執行：把「假別設定」複製成一句 insert
-- ============================================================================
--
-- ✅ 只有 SELECT，不會改動正式資料庫。
-- ✅ 只複製 leave_types（特休、事假、病假……這些公司層級的設定），
--    不含任何同仁的資料。測試環境要能「請假」，才測得到「請假時提醒釋出
--    按摩名額」，所以需要假別。
--
-- 用法：Run → 點結果那一格、複製全部內容 → 到「測試」專案的 SQL Editor
-- 貼上執行（要在 01 的結構建好之後）。

select format(
  'insert into public.leave_types overriding system value select * from jsonb_populate_recordset(null::public.leave_types, %L::jsonb) on conflict do nothing;',
  coalesce(jsonb_agg(to_jsonb(lt)), '[]'::jsonb)
) as "複製這一格的全部內容"
from public.leave_types lt;
