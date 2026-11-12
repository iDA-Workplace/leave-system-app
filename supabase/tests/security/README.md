# 資料庫權限 — 測試

驗證 `migrations/20261110_security_lockdown.sql`：網站真的會做的操作（送假單、撤回、
一關／多關簽核、駁回、老闆不需審核、HR 代登與修改、同仁確認／異議、管理員改員工資料、
HR 改到職日、切換語言、Slack／排程等後台程式）都照常可以；偷改（把自己改成管理員、
自己核准假單、跳關、偽造審核紀錄、沒登入讀員工名單……）都被擋下來。共 49 項。

**不要在 Supabase 上跑。** 這是給本機 Postgres 16 用的：`00_stub.sql` 建立 Supabase 的替身，
資料表與權限規則照抄 2026-11 從正式資料庫匯出的內容。`10_tests.sql` 會先確認修正前的洞
真的存在，再套用 migration 跑測試。

```bash
createdb sect
psql -d sect -v ON_ERROR_STOP=1 -f supabase/tests/security/00_stub.sql
psql -d sect -v ON_ERROR_STOP=1 -f supabase/tests/security/10_tests.sql   # 要在 repo 根目錄執行（裡面用 \i 載入 migration）
psql -d sect -v ON_ERROR_STOP=1 -f supabase/tests/security/20_hr_admin_tests.sql   # 接著跑：20261112 HR 擁有管理員功能（共 71 項）
# 或者（另開一個資料庫，00 → 10 → 30）：20261117 假單資料權限＋附件不公開（共 73 項）
psql -d sect -v ON_ERROR_STOP=1 -f supabase/tests/security/30_privacy_tests.sql
```

最後會列出每一項 PASS／FAIL；有任何 FAIL 會以錯誤結束。
