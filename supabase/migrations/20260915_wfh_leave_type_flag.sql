-- 「在家工作（WFH）」獨立成一種假別型態
--
--
-- 背景
--
-- 原本的「補休」改成「WFH」，而且**用途也跟著變了** —— 它不再是請假，
-- 而是「人有在工作，只是不在辦公室」。這個差別會影響每日請假公告：
-- 如果 WFH 的人被混在「今天請假名單」裡，同事會以為他今天不在、找不到人，
-- 但實際上他在。
--
-- 所以需要一個方式讓程式認出「這個假別是 WFH」。跟 is_annual 一樣用旗標，
-- 不要比對名稱 —— 名稱是管理後台隨時可以改的，靠名字判斷一改名就會靜默失效
-- （這個坑在 20260911_annual_leave_flag_and_pending 已經踩過一次）。
--
--
-- 這支只加旗標，行為改動在程式碼那邊
--
-- 加了旗標之後：
--   · 每日 9:00 的 Slack 公告會把 WFH 的人另外列一段「在家工作」，
--     跟請假的人分開，同事看得出來誰是真的不在、誰只是不在辦公室
--   · 請假申請表單在選 WFH 時不會要求指定職務代理人（人在工作，不需要代理）
--
-- 不變的部分（依需求確認過）：
--   · WFH **仍然要走簽核流程**，主管要核准
--   · WFH 仍然出現在假期明細裡，當作在家工作的紀錄
--
--
-- 回填
--
-- 依需求把原本的「補休」標成 WFH。如果貴公司的這個假別已經改過名、
-- 或名稱不是「補休」，回填會抓不到，請手動執行最後面附的指令。

alter table public.leave_types
  add column if not exists is_wfh boolean not null default false;

comment on column public.leave_types.is_wfh is
  '這個假別是不是「在家工作」。WFH 的人有在工作、只是不在辦公室，所以每日請假公告會把他們跟請假的人分開列。用旗標而不是比對名稱，是為了讓假別可以自由改名而不會弄壞公告分組。';

update public.leave_types
   set is_wfh = true
 where name = '補休'
   and is_wfh = false;

-- ---------------------------------------------------------------------------
-- 確認標對了：
--
--   select id, name, is_annual, is_wfh from public.leave_types order by name;
--
-- 如果該標的那一列 is_wfh 還是 false（例如假別已經改過名），手動補上：
--
--   update public.leave_types set is_wfh = true where id = '<該假別的 id>';
--
-- 一個假別不應該同時是 is_annual 和 is_wfh —— 特休是請假、WFH 不是請假，
-- 兩者互斥。檢查有沒有標錯：
--
--   select id, name from public.leave_types where is_annual and is_wfh;
--   （應該查不到任何一列）
-- ---------------------------------------------------------------------------
