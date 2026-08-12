// Slack Web API 的薄封裝。
//
// 這裡只做「往外送訊息」，沒有任何接收 Slack 進來的請求的程式碼 —— 目前不做
// 「直接在 Slack 上按核准」那類互動功能。互動功能會讓 Slack 反過來打進我們的
// 資料庫，那條路徑沒有登入狀態、繞過 RLS，必須自己驗簽章＋自己檢查權限，
// 風險與工作量都完全不同，所以刻意分開。

const SLACK_API = 'https://slack.com/api'

export function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`缺少環境變數 ${name}`)
  return v
}

async function callSlack(method: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}`,
    },
    body: JSON.stringify(payload),
  })

  // Slack 就算失敗也照樣回 HTTP 200，真正的結果在 body.ok / body.error，
  // 所以絕對不能只看 res.ok 就當成功 —— 那會讓所有錯誤都被吃掉。
  const body = await res.json()
  if (!body.ok) throw new Error(`Slack ${method} 失敗：${body.error}`)
  return body
}

/** 發到頻道。channel 傳頻道 ID（C 開頭）。 */
export function postToChannel(channel: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel, text, blocks, unfurl_links: false })
}

/**
 * 私訊某人。channel 直接傳 Slack user ID（U 開頭）即可，Slack 會自動開 DM。
 * 需要 bot token 具備 chat:write 與 im:write 權限。
 */
export function dmUser(slackUserId: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

/**
 * 一次送多人。單一個人送失敗（例如某人的 slack_user_id 填錯、或已離開
 * workspace）不應該讓整批通知失敗，所以用 allSettled 收集錯誤後回報，
 * 而不是讓第一個錯誤就中斷。
 */
export async function dmMany(slackUserIds: string[], text: string, blocks?: unknown[]) {
  const targets = [...new Set(slackUserIds.filter(Boolean))]
  const results = await Promise.allSettled(targets.map(id => dmUser(id, text, blocks)))
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${targets[i]}: ${r.reason?.message ?? r.reason}` : null))
    .filter(Boolean)
  return { sent: targets.length - failures.length, failures }
}

export function section(markdown: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } }
}

export function contextLine(markdown: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] }
}
