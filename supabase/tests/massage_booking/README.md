# 按摩預約 — 資料庫測試

驗證 `migrations/20261019_massage_booking.sql` 的所有規則（報名、部分請假、
排時段避開請假、一起抽籤＋讓出詢問、公平性、遞補、現場沒到、鎖定、權限、
出席），共 99 項。

**不要在 Supabase 上跑。** 這是給本機 Postgres 16 用的：`00_stub.sql` 會建立
Supabase 的替身（`auth.uid()`、`anon` / `authenticated` / `service_role` 角色、
最小版的 `users` / `leave_types` / `leave_requests`）。

```bash
createdb mt
psql -d mt -f supabase/tests/massage_booking/00_stub.sql
psql -d mt -f supabase/migrations/20261019_massage_booking.sql
psql -d mt -v ON_ERROR_STOP=1 -f supabase/tests/massage_booking/10_tests.sql
```

最後兩個查詢會列出每一項的結果與「N / N 通過」。

公平性那一項會抽 400 次籤，檢查 17 選 9 時每個人的中籤次數都在期望值
211.8 ± 4 個標準差內，而且上期按過與沒按過的人平均一樣 —— 這一項本質上
是機率檢查，理論上極少數情況會誤報。

「現場沒到」那一組會建一期「3 分鐘前剛開始」的按摩，所以剛好在台灣時間
午夜前後執行時可能失敗，換個時間重跑即可。
