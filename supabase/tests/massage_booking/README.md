# 按摩預約 — 資料庫測試

驗證 `migrations/20261019_massage_booking.sql` 的所有規則（報名、部分請假、
排時段避開請假、一起抽籤＋讓出詢問、公平性、遞補、現場沒到、鎖定、權限、
出席、管理者直接指定遞補、負責人、異動紀錄），共 141 項。

**不要在 Supabase 上跑。** 這是給本機 Postgres 16 用的：`00_stub.sql` 會建立
Supabase 的替身（`auth.uid()`、`anon` / `authenticated` / `service_role` 角色、
最小版的 `users` / `leave_types` / `leave_requests`）。

```bash
createdb mt
psql -d mt -f supabase/tests/massage_booking/00_stub.sql
psql -d mt -f supabase/migrations/20261019_massage_booking.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/10_tests.sql

# Slack 通知用的「發過了沒」紀錄（20261020_massage_slack.sql），15 項
psql -d mt -f supabase/migrations/20261020_massage_slack.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/20_slack_tests.sql

# 管理者把人加進空時段（20261021_massage_add_to_slot.sql），24 項；接在 10_tests.sql 之後
psql -d mt -f supabase/migrations/20261021_massage_add_to_slot.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/30_add_to_slot_tests.sql

# 隱藏期數（20261022_massage_hide_sessions.sql），9 項；接在 10_tests.sql 之後
psql -d mt -f supabase/migrations/20261022_massage_hide_sessions.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/40_hide_tests.sql

# 提前截止報名（20261024_massage_close_signup.sql），8 項；接在 10_tests.sql 之後
psql -d mt -f supabase/migrations/20261024_massage_close_signup.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/50_close_signup_tests.sql

# 釋出等待期、取消釋出、候補時限、空位先搶先贏（20261026_massage_release_hold.sql），55 項；接在 10_tests.sql 之後
# （照編號順序，先補跑 20261023、20261025）
psql -d mt -f supabase/migrations/20261023_massage_realtime.sql
psql -d mt -f supabase/migrations/20261025_massage_announcements.sql
psql -d mt -f supabase/migrations/20261026_massage_release_hold.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/60_release_hold_tests.sql
```

每支測試最後的兩個查詢都會列出每一項的結果與「N / N 通過」。
（20_slack_tests.sql、30_add_to_slot_tests.sql、40_hide_tests.sql、50_close_signup_tests.sql、60_release_hold_tests.sql 都要接在 10_tests.sql 之後跑，沿用它的資料與小工具。）

公平性那一項會抽 400 次籤，檢查 17 選 9 時每個人的中籤次數都在期望值
211.8 ± 4 個標準差內，而且上期按過與沒按過的人平均一樣 —— 這一項本質上
是機率檢查，理論上極少數情況會誤報。

「現場沒到」那一組會建一期「3 分鐘前剛開始」的按摩，所以剛好在台灣時間
午夜前後執行時可能失敗，換個時間重跑即可。
