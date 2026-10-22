# 測試環境（Demo 用）

還沒合併到 main 的功能（目前是按摩預約＋Slack），在這裡先試。

**跟正式環境完全分開**：另一個 Supabase 專案（資料庫）、另一個 Slack App
（另一個 bot）、Vercel 的「分支預覽網址」。在這裡報名、抽籤、取消都不會
碰到正式資料，也不會發訊息給真的同仁。

全部做一次大約 30 分鐘，之後每次推新的程式碼，預覽網址會自動更新。

> 🔒 **金鑰不要貼給我（Claude）**，也不要貼在任何對話或文件裡。
> 這份說明裡要你複製的金鑰，都是「從 A 網頁複製、貼到 B 網頁」，
> 不經過任何人。唯一可以公開的是 Project URL 和 anon / publishable key
> （本來就會出現在網頁原始碼裡）。`service_role` / `sb_secret_` 開頭的
> **絕對不能**放進 Vercel 的 `VITE_` 開頭變數。

---

## 一、開一個測試用的 Supabase 專案

1. <https://supabase.com/dashboard> → **New project**
   - 名稱：例如 `leave-system-test`
   - Region：跟正式專案一樣
   - Database password：自己設、自己保存（之後的步驟用不到）
   - 方案：Free 就夠
2. 等它建立完成（1～2 分鐘）。

## 二、把資料庫「結構」複製過去（不含任何資料）

正式資料庫裡最早的幾張表（帳號、假單……）是在開始用 migration 檔案之前
就建好的，所以沒辦法只靠 `migrations/` 重建，要從正式專案「照抄結構」。

1. **正式專案** → SQL Editor → 新分頁 → 貼上 [`01_export_schema.sql`](01_export_schema.sql)
   全部內容 → **Run**。
   - 這支只有讀取，不會改到正式資料庫。輸出的是建表指令，**不含任何一筆資料**。
2. 結果只有一格。點那一格 → 複製全部內容。
3. **測試專案** → SQL Editor → 新分頁 → 貼上 → **Run**。
4. 同樣的方式跑 [`02_export_leave_types.sql`](02_export_leave_types.sql)：正式專案 Run →
   複製那一格 → 測試專案 Run。這是「假別設定」（特休、事假……），不含任何同仁資料。

⚠️ 第 3 步如果出現錯誤，把**錯誤訊息**（紅字那段）貼給我就好。

## 三、建立按摩預約的資料表

測試專案 → SQL Editor，依序執行：

1. [`../migrations/20261019_massage_booking.sql`](../migrations/20261019_massage_booking.sql)
2. [`../migrations/20261020_massage_slack.sql`](../migrations/20261020_massage_slack.sql)
3. [`../migrations/20261021_massage_add_to_slot.sql`](../migrations/20261021_massage_add_to_slot.sql)（空時段「編輯」加人）
4. [`../migrations/20261022_massage_hide_sessions.sql`](../migrations/20261022_massage_hide_sessions.sql)（管理頁隱藏抽過籤的期數）
5. [`../migrations/20261023_massage_realtime.sql`](../migrations/20261023_massage_realtime.sql)（首頁按摩欄位即時更新）
6. [`../migrations/20261024_massage_close_signup.sql`](../migrations/20261024_massage_close_signup.sql)（編輯視窗的「提前截止」）

## 四、放入假帳號與示範資料

1. 打開 [`03_seed_test_data.sql`](03_seed_test_data.sql)，先改最上面兩行：
   - `v_password`：所有測試帳號共用的密碼
   - `v_my_slack`：你自己的 Slack 成員 ID（U 開頭；Slack 點自己頭像 → 個人檔案
     → ⋮ → 複製成員 ID）。填了，「測試管理員」的 Slack 通知就會私訊給你。
2. 測試專案 → SQL Editor → 貼上 → **Run**。

會建立 16 個假帳號（`admin@example.com` 測試管理員、`hr@example.com` 測試人資、
`staff01`～`staff14@example.com` 測試同仁）和兩期按摩：

| 期數 | 狀態 | 可以試什麼 |
|---|---|---|
| 第一期 | 開放報名中，已有 6 人報名 | 報名、取消、在 Slack 打「按摩」 |
| 第二期 | 報名已截止，13 人報名（名額 9） | 投影畫面公開抽籤 → 候補、遞補、讓出 |

### 四之二、讓測試帳號可以請假（要測「請假撞到按摩」才需要）

測試專案 → SQL Editor → 執行 [`05_seed_leave_setup.sql`](05_seed_leave_setup.sql)。會建立：

- 假別：特休、事假、病假、在家工作（測試專案已經有假別的話就沿用，不重複建）
- 簽核流程：測試同仁與測試人資的假單由「測試管理員」簽；測試管理員的假單由「測試人資」簽
- 每個測試帳號的預設簽核流程

想從頭再來：執行 [`04_reset_massage.sql`](04_reset_massage.sql)（只清按摩資料，帳號保留；
它會先檢查專案裡沒有 `@example.com` 以外的帳號才動手）。

## 五、測試用的 Slack App（另一個 bot）

**不要用正式的 Slack App**：一個 App 只能指向一個網址，改了正式的就換成
測試資料庫在回應大家了。

1. <https://api.slack.com/apps> → **Create New App** → **From an app manifest** →
   選你們的 workspace → 格式選 YAML → 貼上：

   ```yaml
   display_information:
     name: iDA 測試
   features:
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: iDA 測試
       always_online: true
   oauth_config:
     scopes:
       bot:
         - chat:write
         - im:write
         - im:history
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

2. **Install to Workspace** → 複製 **Bot User OAuth Token**（`xoxb-` 開頭）。
3. **Basic Information** → App Credentials → 複製 **Signing Secret**。
4. 在 Slack 建一個測試頻道（建議私人頻道，例如 `#按摩測試`），在頻道裡輸入
   `/invite @iDA 測試`，再點頻道名稱 → 最下面複製頻道 ID（`C` 開頭）。
5. **測試專案** → Edge Functions → **Secrets**，新增：

   | 名稱 | 值 |
   |---|---|
   | `SLACK_BOT_TOKEN` | 第 2 步的 `xoxb-...` |
   | `SLACK_SIGNING_SECRET` | 第 3 步 |
   | `SLACK_LEAVE_CHANNEL` | 第 4 步的測試頻道 ID |

## 六、部署 Edge Functions 到測試專案

測試專案 → Edge Functions → **Deploy a new function** → **Via Editor**，
每一支都要**先把名稱改對**再貼程式碼、再按 Deploy：

| 名稱 | 貼哪個檔案 | Verify JWT |
|---|---|---|
| `slack-interactions` | `functions/slack-interactions/index.ts` | **關掉** |
| `massage-notify` | `functions/massage-notify/index.ts` | 維持開啟 |
| `send-slack-notification` | `functions/send-slack-notification/standalone.ts` | 維持開啟 |

（`send-slack-notification` 是請假通知；要在測試環境試「請假 → 提醒釋出按摩名額」才需要。）

部署完回到 Slack App 設定：

1. **Interactivity & Shortcuts** → 開啟 → Request URL：
   `https://<測試專案ref>.supabase.co/functions/v1/slack-interactions` → Save
2. **Event Subscriptions** → 開啟 → 同一個網址 → 應該馬上顯示 **Verified** →
   Subscribe to bot events 加 **`message.im`** → Save
3. 如果頁面上方提示要重新安裝（reinstall），照著按一次。

## 七、排程（每分鐘叫一次 massage-notify）

測試專案 → SQL Editor。key 用**測試專案**的 secret key（Project Settings → API Keys）：

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'massage-notify',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<測試專案ref>.supabase.co/functions/v1/massage-notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'apikey',        '<測試專案的 secret key>',
      'Authorization', 'Bearer <同一把 key>'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

## 八、讓 Vercel 的分支預覽網址連到測試資料庫

每次把程式碼推到分支，Vercel 都會自動做一個「預覽網址」，main 的正式網站不受影響。
預設它連的是正式資料庫（正式資料庫沒有按摩的資料表，所以現在打開按摩頁會出錯），
要改成連測試專案：

1. 測試專案 → Project Settings → **API**（或 API Keys）→ 複製 **Project URL** 和
   **anon / publishable key**。這兩個是公開的，放在前端沒問題。
2. Vercel → 這個專案 → Settings → **Environment Variables** → Add：
   - `VITE_SUPABASE_URL` = 測試專案的 Project URL
   - `VITE_SUPABASE_ANON_KEY` = 測試專案的 anon / publishable key
   - Environments **只勾 Preview**，下面的 Branch 填
     `claude/enterprise-leave-management-design-kxvv2i`
     （只有這個分支的預覽會連測試資料庫；Production 完全不受影響）
3. Vercel → **Deployments** → 找到這個分支最新的那一筆 → ⋯ → **Redeploy**
   （環境變數只對「之後」的部署生效）。
4. 打開那筆部署的網址，用 `admin@example.com` 和你設定的密碼登入。

預覽網址預設要登入 Vercel 才看得到（Deployment Protection）。只有你自己看沒問題；
要給同事試用，需要在 Vercel 分享連結或調整保護設定。

## 九、可以試什麼

**網頁（預覽網址）**
- 員工福利 → 按摩預約：報名、取消、看名單、規則
- 管理：開新的一期（開放報名公告會發到測試頻道）
- 第二期 → 投影畫面抽籤 → 抽籤結果公告到測試頻道
- 現場面板：釋出、沒到、指定遞補、改時段、標出席；「紀錄」分頁、匯出 Excel

**Slack（私訊「iDA 測試」這個 bot）**
- 打「按摩」→ 卡片 → 報名／取消／看名單
- 測試頻道的開放報名公告 → 按「報名」
- 用網頁登入某個測試同仁、在第二期抽籤後取消他的時段 → 候補第一位收到「輪到你了」
  （候補要是「測試管理員」才收得到，因為只有這個帳號有你的 Slack ID）

小技巧：想用 Slack 測「被邀請遞補」「被詢問讓出」，可以把你的 Slack ID 暫時
換到某個測試同仁身上（同一個 Slack ID 一次只放在一個帳號），在測試專案的 SQL Editor：

```sql
update public.users set slack_user_id = null where slack_user_id = '<你的 Slack ID>';
update public.users set slack_user_id = '<你的 Slack ID>' where full_name = '測試同仁10';
```

（網頁「管理後台 → 員工帳號」的編輯在測試環境不能用：它靠的是正式專案裡一支叫
`manage-users` 的 function，那支不在程式碼庫裡。需要的話可以從正式專案該 function
的 Code 分頁複製過來部署，否則用上面的 SQL 就好。）
