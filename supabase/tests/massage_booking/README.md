# 按摩預約 — 資料庫測試

驗證 `migrations/20261019_massage_booking.sql` 的所有規則（報名、請假衝突、
兩組抽籤、公平性、遞補、鎖定、權限、出席），共 75 項。

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

公平性那一項會抽 400 次籤，檢查 12 選 9 時每個人的中籤次數都在期望值
300 ± 4 個標準差內 —— 這一項本質上是機率檢查，理論上極少數情況會誤報。
