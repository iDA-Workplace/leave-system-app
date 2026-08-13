# Slack 整合（Edge Functions）

四支 function：

| 目錄 | 做什麼 | 誰觸發 |
|---|---|---|
| `send-slack-notification` | 假單送出／核准／拒絕的即時通知 | 前端在動作完成後呼叫 |
| `daily-leave-digest` | 每天上午 9:00 發「今日請假名單」到公開頻道 | 排程（pg_cron） |
| `daily-leave-job` | 待審假單逾期 7 天自動退回；未逾期的每天提醒該簽核的主管 | 排程（pg_cron） |
| `slack-interactions` | 在 Slack 裡送假單、在 Slack 裡核准／駁回 | Slack（事件與互動） |

## `slack-interactions` 的資安模型

這支跟其他三支方向相反：其他三支是「我們主動打給 Slack」，這支是
**「Slack 反過來打進我們的資料庫」**，而且那條路徑沒有任何登入狀態，用的是
service role key（繞過所有 RLS）。所以每個請求都做三件事：

1. **驗證簽章**（HMAC-SHA256，`SLACK_SIGNING_SECRET`）確認真的來自 Slack，
   並拒收 5 分鐘前的請求防重放。沒有這一步，任何知道網址的人都能偽造請求
   核准假單。比對簽章時長度相同也要逐字比完不提早跳出，避免用回應時間反推。
2. **把 Slack user id 對應回系統帳號**（`users.slack_user_id`），對不到、或
   帳號已停用，一律拒絕。
3. **動作發生的當下重新檢查權限與狀態**，完全不信任按鈕上帶的資訊 —— 那顆
   按鈕可能是三天前發出的，假單早就在網頁上被處理掉了，或流程已經走到別關。
   重複點、或別人已處理過，會換成說明文字而不是重複寫入。

這支**不拆 `_shared` 共用檔，整支是自給自足的單一檔案**（其他三支是
`index.ts` + `standalone.ts` 兩份）。原因是這支程式碼量大，維護兩份副本
遲早會改到不一致，而這支牽涉權限判斷，不一致的後果比其他支嚴重。同一個
`index.ts` 同時適用網頁編輯器貼上與 CLI 部署。

## `daily-leave-job` 是既有的功能，這次是修好它，不是新寫的

這支 function 在這次改動之前就存在，跟「每日請假名單」公告完全是兩回事，
只是名字相近容易搞混。它原本會查 `approval_delegates`（代理審核人）這張表，
但那張表已經在 `20260810_remove_approval_delegates.sql` 被整個刪掉 —— 使用者
當時明確要求「代理審核設定這個功能連資料庫也一起刪」。所以這支 function
只要被觸發就會直接查詢失敗，等於一直是壞的，也解釋了「Slack 通知從來沒有
真正運作過」這件事。

修法很單純：拿掉查 `approval_delegates` 的那一段，簽核人一律用
`approval_flow_steps` 上原本設定的人。其餘的 7 天逾期天數、退回訊息、提醒
文字，全部照舊，**沒有跟著調整任何規則** —— 那些是要改的話再另外決定的事。

部署方式：Supabase 後台點進**既有的** `daily-leave-job` → 用
`daily-leave-job/standalone.ts` 的內容整個蓋掉 → Deploy。**不要新建一支**，
沿用原名才能保留可能已經存在的排程設定。

⚠️ **有一件事我沒辦法幫你確認**：這支 function 會寫入 `leave_requests` 的
`returned_at`、`returned_reason`、`last_reminded_at` 三個欄位。這幾個欄位
不在任何一份 migration 檔案裡，代表它們是在專案更早期、開始用 migration
追蹤變更之前就直接建在資料庫裡的（前端 `MyLeaves.jsx` 已經有處理
`status === 'returned'` 的「重新送出」按鈕，所以這個欄位多半本來就存在）。
但我沒有資料庫存取權限，沒辦法百分之百確認。**部署後第一次手動觸發時**，
如果回應是 `Internal error`，去 Logs 分頁看實際錯誤訊息貼給我，多半就是
這幾個欄位不存在，需要另外補一支 migration。

---

## 一、建立 Slack App

1. 到 <https://api.slack.com/apps> → **Create New App** → From scratch，選你們的 workspace。
2. 左側 **OAuth & Permissions** → Scopes → **Bot Token Scopes** 加入：
   - `chat:write` — 發訊息
   - `im:write` — 開啟並私訊個人
3. 頁面上方 **Install to Workspace**，安裝後複製 **Bot User OAuth Token**（`xoxb-` 開頭）。
4. 在 Slack 裡建立（或選定）要發請假公告的頻道，然後**把這個 App 邀請進去**：
   在該頻道輸入 `/invite @你的App名稱`。**沒邀請的話發文會失敗**（`not_in_channel`）。
5. 取得該頻道的 Channel ID：在 Slack 點頻道名稱 → 最下面會顯示 `C` 開頭的 ID。

### 公開頻道 vs 私人頻道

兩種都可以，程式碼與權限都不用改 —— 設定的是 Channel ID，對 API 來說沒差別，
`chat:write` 的涵蓋範圍是「App 有加入的所有對話」，私人頻道也算。

選之前先考慮：

- **私人頻道看不到的人就是看不到。** 公開頻道任何人都能自己搜尋加入，私人頻道
  必須有人手動邀請。新人到職若沒人記得拉進去，他就收不到請假公告 —— 而這正是
  要拿來取代 Outlook calendar 的東西。若公告對象是全公司，建議用公開頻道，
  人員異動時才不需要有人維護名單。
- **私人頻道的錯誤訊息比較難懂。** App 若被移出私人頻道，Slack 回的是
  `channel_not_found`（不是 `not_in_channel`），因為那個頻道對 App 來說等於
  不存在。看到這個錯誤先確認 App 還在不在頻道裡，不要只檢查 ID 有沒有填錯。
- **私訊不受影響。** 假單送出／核准／拒絕是直接私訊給個人，跟頻道設定無關。

## 一之二、開啟 Slack 互動功能（只有要用 `slack-interactions` 才需要）

沿用同一個 Slack App，加設定即可。**順序很重要**：Request URL 要填的是
`slack-interactions` 部署後的網址，所以**先部署那支 function（見「三」）再回來做這段**。

網址長這樣（`<ref>` 是專案 Reference ID）：
`https://<ref>.supabase.co/functions/v1/slack-interactions`

1. **加權限**：OAuth & Permissions → Bot Token Scopes 加上 **`im:history`**
   （讓 bot 看得到同事私訊裡打的字）。原本的 `chat:write`、`im:write` 保留。
   **加完必須重新安裝 App 到 workspace**，權限才會生效 —— 這步最容易漏。
2. **Interactivity & Shortcuts** → 開啟 → Request URL 填上面那個網址。
   （按鈕、表單送出都走這裡）
3. **Event Subscriptions** → 開啟 → Request URL 填**同一個**網址。
   Slack 會立刻發一個驗證請求，function 已經處理好 `url_verification`，
   正常會馬上顯示 Verified。→ 展開 **Subscribe to bot events** 加入
   **`message.im`** → 存檔。
4. **拿 Signing Secret**：Basic Information → App Credentials → Signing Secret，
   存成 Supabase 的 secret（見下一節）。

### 為什麼是「打字→按鈕→表單」，不是「打字直接跳表單」

Slack 規定：**要彈出表單視窗必須有 `trigger_id`，而 `trigger_id` 只有在使用者
「點擊」時才會產生，打字傳訊息不會產生**。所以流程一定是：打「請假」→ bot
回一則帶「填寫假單」按鈕的訊息 → 點按鈕（產生 trigger_id）→ 表單彈出。

## 二、設定環境變數

Supabase 後台 → **Edge Functions → Secrets**（或用 CLI）：

| 名稱 | 值 | 誰要用 |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` | 全部 |
| `SLACK_LEAVE_CHANNEL` | 頻道 ID `C...` | 每日公告、當天臨時請假公告 |
| `SLACK_SIGNING_SECRET` | Basic Information → Signing Secret | 只有 `slack-interactions` |

用 CLI 的話：

```bash
supabase secrets set SLACK_BOT_TOKEN=xoxb-你的-token
supabase secrets set SLACK_LEAVE_CHANNEL=C01234ABCDE
supabase secrets set SLACK_SIGNING_SECRET=你的-signing-secret
```

`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自動注入，不用自己設。

## 三、部署

有兩種部署方式，**只需要選一種**：

### 方式 A：在 Supabase 網頁後台部署（不需要裝任何東西，推薦一般情況使用）

每支 function 都準備了一份 **`standalone.ts`**（跟 `index.ts` 內容相同，
只是把共用程式碼合併進單一檔案，因為網頁編輯器不支援多檔案匯入）：

**新建的兩支**（`send-slack-notification`、`daily-leave-job` 若已存在，
見下方「更新既有 function」，不要用這裡的步驟新建重複的）：

1. Supabase 後台左側選單 → **Edge Functions**
2. 點 **Deploy a new function** → **Via Editor**（不要選 CLI / Terminal 那個選項，
   也不要選任何範例模板）
3. **先把函式名稱欄位改成正確名字**，這一步最容易漏：`send-slack-notification`
   或 `daily-leave-digest`（**必須跟這兩個字串完全一樣**，前端是照名字去呼叫的，
   名字錯了會整個找不到函式）
4. 把對應資料夾的 `standalone.ts` **全部內容**複製貼進編輯器，蓋掉預設的範例程式碼
5. 按 **Deploy**

**更新既有的 function**（`send-slack-notification`、`daily-leave-job` 這兩支
在此次改動之前就已經存在）：

1. Edge Functions 列表點進該支 function
2. 上方分頁選 **Code**
3. 把裡面的內容全部刪掉，貼上對應資料夾的 `standalone.ts` 內容
4. 按 **Deploy**（這樣會在原本的名字／URL 上更新，不會產生新的一支）

**`slack-interactions`（新建）**：這支貼的是 `slack-interactions/index.ts`
（它沒有 `standalone.ts`，本來就是單一檔案）。函式名稱填 `slack-interactions`。

⚠️ **這支的 Verify JWT 要關掉**：Settings → **Verify JWT with legacy secret**
關成 OFF。因為呼叫它的是 Slack，Slack 不會帶 Supabase 的金鑰。安全性改由
函式內的簽章驗證負責（見最上面的資安模型），不是沒有保護。

部署完成後，Edge Functions 列表應該會看到 `send-slack-notification`、
`daily-leave-digest`、`daily-leave-job`、`slack-interactions` 這四支。

⚠️ 網頁編輯器新建 function 時，**名稱欄位要先改掉再按 Deploy**。它會帶一個
隨機的預設名字（`clever-responder`、`dynamic-service` 之類），忘了改的話
網址就會定死成那個名字，之後從 Name 欄位改也改不動（Supabase 自己在該欄位
下方寫了「Your slug and endpoint URL will remain the same」）。

⚠️ `standalone.ts` 只給網頁編輯器用。程式邏輯跟 `index.ts` 完全一樣，只是重複
了一份共用程式碼；以後若要改動通知邏輯，`index.ts` 和 `standalone.ts` 要一起改。

### 方式 B：用 Supabase CLI 部署（需要終端機）

```bash
supabase functions deploy send-slack-notification
supabase functions deploy daily-leave-digest
```

CLI 會自動處理 `_shared/` 資料夾的共用程式碼，不需要 `standalone.ts`。

## 四、把每日公告排進 9 點

### 新制金鑰專案要注意：兩個 header 都要帶

Supabase 現在有新舊兩種金鑰制度。**Project Settings → API Keys** 如果分頁是
**「Publishable and secret API keys」**（而不是「Legacy anon, service_role
API keys」），代表這個專案是**新制**，這裡要用新制的做法：

- 拿 **Secret key**（`sb_secret_...` 開頭，在 Publishable and secret API keys
  頁面的「Secret keys」區塊，點眼睛圖示顯示）
- 呼叫時 **`apikey` 與 `Authorization` 兩個 header 都要帶**，值都是這把
  Secret key（只帶 `Authorization` 會被閘道擋下，回
  `{"message":"Invalid credentials","code":"INVALID_CREDENTIALS"}`——這個錯誤
  在函式本身的程式碼跑起來之前就發生，Logs 分頁完全不會留下任何呼叫紀錄，
  是排查這個問題的關鍵線索）

如果是**舊制**專案（分頁停在「Legacy anon, service_role API keys」），沿用
`service_role key`，`apikey` 就不是必要的，但兩個都帶也不會錯。

Supabase SQL Editor 執行一次（`pg_cron` 的時間是 **UTC**，台北 09:00 = UTC 01:00）：

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daily-leave-digest',
  '0 1 * * 1-5',                       -- UTC 01:00 = 台北 09:00，週一到週五
  $$
  select net.http_post(
    url     := 'https://<你的專案ref>.supabase.co/functions/v1/daily-leave-digest',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'apikey',        '<你的 secret key（新制）或 service_role key（舊制）>',
      'Authorization', 'Bearer <同一把 key>'
    )
  );
  $$
);
```

只想上班日發就維持 `1-5`；要含週末改成 `*`。

`daily-leave-job`（逾期假單自動退回＋提醒主管）如果也要排程，同樣的寫法，
`cron.schedule` 的第一個參數換成 `'daily-leave-job'`，`url` 換成
`.../functions/v1/daily-leave-job`，時間可以自訂（例如同樣訂在每天早上）。

## 五、員工要填 Slack ID

通知是私訊，所以每個人的 `users.slack_user_id` 要填。
管理後台 → 員工帳號管理 → 編輯員工 → **Slack User ID**（`U` 開頭）。

取得方式：Slack 點該成員頭像 → 檢視完整個人檔案 → 右上「⋮」→ **複製成員 ID**。

**沒填的人不會收到通知，也不會報錯**（function 會回 `skipped`）——這是刻意的，
免得一個人沒填就讓整批通知失敗。

## 六、測試

**沒有終端機也能測**：Supabase 後台 → 該支 function → **Overview** →
右上角 **Test** → **Add Headers** 加 `apikey` 與 `Authorization: Bearer <key>`
（新舊制金鑰的差異見上方「四」）→ **Send Request**。

用終端機的話：

```bash
# 每日公告（今天沒人請假時會安靜跳過，回傳 posted:false）
curl -X POST 'https://<ref>.supabase.co/functions/v1/daily-leave-digest' \
  -H 'apikey: <secret key 或 service_role key>' \
  -H 'Authorization: Bearer <同一把 key>'

# 假單通知
curl -X POST 'https://<ref>.supabase.co/functions/v1/send-slack-notification' \
  -H 'apikey: <secret key 或 service_role key>' \
  -H 'Authorization: Bearer <同一把 key>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"new_request","request_id":"<某張假單的 id>"}'
```

### 部署後一定要重新確認 Code 分頁的內容

網頁編輯器「Deploy a new function」有時會先帶出一份範例模板（`Hello
${name}!` 那種），如果貼上我們的程式碼時沒有先把範例整個刪乾淨、或部署
沒有真的存到，測試會回傳範例的訊息（例如 `{"message":"Hello Functions!"}`）
而不是報錯 —— 很容易誤以為「有回應就是成功」。**部署後第一次測試，除了看
有沒有噴錯，也要確認回傳的欄位長得像我們的程式碼會回的格式**
（`daily-leave-digest` 是 `{date, count, posted}`），不是範例的 `{message}`。

---

## 當天臨時請假怎麼處理

早上 9 點的公告只看得到「當下已核准」的假單，所以下午才核准的臨時假一定會漏。

`send-slack-notification` 在 `approved` 事件裡補了這件事：假期涵蓋今天、
**而且現在已經過了 9 點**，就額外發一則「今日臨時請假」到頻道。9 點前核准的
不補發，因為那筆本來就會被當天的例行公告帶到——這樣才不會同一個人被公告兩次。

## 時區

台灣全年 UTC+8、沒有日光節約時間，所以程式裡用固定位移換算（`_shared/leave.ts`
的 `TAIPEI_OFFSET_MS`），沒有拉整套時區資料庫進來。
Edge function 本身跑在 UTC，pg_cron 也是 UTC，設定排程時要自己換算。
