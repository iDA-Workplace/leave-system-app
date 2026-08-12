# Slack 通知（Edge Functions）

兩支 function：

| 目錄 | 做什麼 | 誰觸發 |
|---|---|---|
| `send-slack-notification` | 假單送出／核准／拒絕的即時通知 | 前端在動作完成後呼叫 |
| `daily-leave-digest` | 每天上午 9:00 發「今日請假名單」到公開頻道 | 排程（pg_cron） |

**目前只做「往外送通知」，沒有做「在 Slack 上直接審核」。** 互動功能會讓 Slack
反過來寫進資料庫，那條路徑沒有登入狀態、繞過 RLS，必須自行驗簽章與權限，
風險和工作量都完全不同，等前面兩件穩定後再獨立評估。

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

## 二、設定環境變數

Supabase 後台 → **Edge Functions → Secrets**（或用 CLI）：

```bash
supabase secrets set SLACK_BOT_TOKEN=xoxb-你的-token
supabase secrets set SLACK_LEAVE_CHANNEL=C01234ABCDE
```

`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自動注入，不用自己設。

## 三、部署

有兩種部署方式，**只需要選一種**：

### 方式 A：在 Supabase 網頁後台部署（不需要裝任何東西，推薦一般情況使用）

每支 function 都準備了一份 **`standalone.ts`**（跟 `index.ts` 內容相同，
只是把共用程式碼合併進單一檔案，因為網頁編輯器不支援多檔案匯入）：

1. Supabase 後台左側選單 → **Edge Functions**
2. 點 **Deploy a new function** → **Via Editor**（不要選 CLI / Terminal 那個選項）
3. 函式名稱填 `send-slack-notification`（**必須完全一樣**，前端呼叫時用這個名字找它）
4. 把 `supabase/functions/send-slack-notification/standalone.ts` 的**全部內容**複製貼進編輯器，蓋掉預設的範例程式碼
5. 按 **Deploy**
6. 重複第 2～5 步，這次函式名稱填 `daily-leave-digest`，貼
   `supabase/functions/daily-leave-digest/standalone.ts` 的內容

部署完成後，Edge Functions 列表應該會看到這兩支，狀態顯示為運作中。

⚠️ `standalone.ts` 只給網頁編輯器用。程式邏輯跟 `index.ts` 完全一樣，只是重複
了一份共用程式碼；以後若要改動通知邏輯，`index.ts` 和 `standalone.ts` 要一起改。

### 方式 B：用 Supabase CLI 部署（需要終端機）

```bash
supabase functions deploy send-slack-notification
supabase functions deploy daily-leave-digest
```

CLI 會自動處理 `_shared/` 資料夾的共用程式碼，不需要 `standalone.ts`。

## 四、把每日公告排進 9 點

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
      'Authorization', 'Bearer <你的 service_role key>'
    )
  );
  $$
);
```

只想上班日發就維持 `1-5`；要含週末改成 `*`。

## 五、員工要填 Slack ID

通知是私訊，所以每個人的 `users.slack_user_id` 要填。
管理後台 → 員工帳號管理 → 編輯員工 → **Slack User ID**（`U` 開頭）。

取得方式：Slack 點該成員頭像 → 檢視完整個人檔案 → 右上「⋮」→ **複製成員 ID**。

**沒填的人不會收到通知，也不會報錯**（function 會回 `skipped`）——這是刻意的，
免得一個人沒填就讓整批通知失敗。

## 六、測試

```bash
# 每日公告（今天沒人請假時會安靜跳過，回傳 posted:false）
curl -X POST 'https://<ref>.supabase.co/functions/v1/daily-leave-digest' \
  -H 'Authorization: Bearer <service_role key>'

# 假單通知
curl -X POST 'https://<ref>.supabase.co/functions/v1/send-slack-notification' \
  -H 'Authorization: Bearer <service_role key>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"new_request","request_id":"<某張假單的 id>"}'
```

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
