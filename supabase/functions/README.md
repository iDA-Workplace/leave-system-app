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
4. 在 Slack 裡建立（或選定）要發請假公告的公開頻道，然後**把這個 App 邀請進去**：
   在該頻道輸入 `/invite @你的App名稱`。**沒邀請的話發文會失敗**（`not_in_channel`）。
5. 取得該頻道的 Channel ID：在 Slack 點頻道名稱 → 最下面會顯示 `C` 開頭的 ID。

## 二、設定環境變數

Supabase 後台 → **Edge Functions → Secrets**（或用 CLI）：

```bash
supabase secrets set SLACK_BOT_TOKEN=xoxb-你的-token
supabase secrets set SLACK_LEAVE_CHANNEL=C01234ABCDE
```

`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自動注入，不用自己設。

## 三、部署

```bash
supabase functions deploy send-slack-notification
supabase functions deploy daily-leave-digest
```

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
