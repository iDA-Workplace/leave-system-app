-- ============================================================================
-- 一次性：把「已刪除（停用）」但還能登入的同仁封鎖登入
-- ============================================================================
--
-- 為什麼要跑：舊版 manage-users 停用帳號時只改 users.is_active，登入帳號本身沒有
-- 封鎖，所以以前刪除的同仁用舊密碼還登得進來。新版 manage-users 停用時會一併封鎖，
-- 但「以前就停用的人」不會自動補上，要跑這支補一次。
--
-- ✅ 不會刪除任何資料：只在登入帳號上加「封鎖到 100 年後」，請假／考核紀錄都不動。
-- ✅ 之後在「員工帳號管理」按「恢復帳號」，新版 manage-users 會自動解除封鎖。
-- ✅ 跑兩次也沒關係（已封鎖的人只是再設一次）。
--
-- 用法：在「正式」專案的 SQL Editor
--   1. 先只執行【步驟 1】，確認名單就是已刪除的那幾位
--   2. 再執行【步驟 2】
--   3. 再執行一次【步驟 1】，「封鎖到」那一欄應該都有日期了

-- 【步驟 1】預覽：哪些人已停用、目前有沒有被封鎖
select u.full_name   as 姓名,
       a.email       as 信箱,
       a.banned_until as 封鎖到
  from public.users u
  join auth.users a on a.id = u.id
 where u.is_active = false
 order by u.full_name;

-- 【步驟 2】封鎖登入
-- update auth.users a
--    set banned_until = now() + interval '100 years'
--   from public.users u
--  where u.id = a.id
--    and u.is_active = false;
