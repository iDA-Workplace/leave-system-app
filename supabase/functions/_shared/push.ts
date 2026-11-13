// App 推播（呼叫 send-push 那支 function）。
//
// 使用者 2026-11 決定：假單、按摩、考核的私訊「Slack 照發、推播也發」，
// 沒有 Slack ID 的同仁只要有開 App 通知也收得到。推播的文字直接從同一則 Slack
// 訊息轉過來（slackToPush），兩邊講的內容一定一致，不用每種通知各寫一份。
//
// 推播失敗絕對不能影響 Slack 與原本的流程：這裡的錯誤一律只記 log、不往外丟。

export interface PushOptions {
  /** 點通知後打開哪一頁（網站內的路徑） */
  url: string
  /** 同一個 tag 的通知，新的會蓋掉舊的 */
  tag?: string
  /**
   * 這則是不是「待辦」（例如待你簽核）。待辦已經算在圖示數字的「待處理」裡，
   * 不再另外算一則「未讀」，免得同一件事在數字上算兩次。
   */
  todo?: boolean
}

export interface PushText { title: string; body: string }

/** 發推播給這些人（系統帳號 id）。沒開通知的人 send-push 會直接略過。 */
export async function pushToUsers(userIds: (string | null | undefined)[], text: PushText, opts: PushOptions): Promise<string> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))]
  if (ids.length === 0) return 'no recipients'
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return 'push skipped: missing env'
  try {
    const res = await fetch(`${url}/functions/v1/send-push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', user_ids: ids, ...text, ...opts }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.text()
    if (!res.ok) console.error(`推播失敗 ${res.status}: ${body.slice(0, 300)}`)
    return `push ${res.status}`
  } catch (e) {
    console.error('推播失敗', e)
    return `push failed: ${(e as Error).message}`
  }
}

/**
 * Slack 訊息 → 推播文字。
 *   標題：Slack 的 text（通知預覽那一句，例如「王小明 送出了一張待您審核的假單」）
 *   內文：訊息裡各段文字去掉 Slack 格式（粗體、:emoji:、連結語法）。第一行如果只是
 *         粗體標題（例如「:memo: *有一張假單待您審核*」）就略過，跟標題重複。
 */
export function slackToPush(text: string, blocks?: unknown[]): PushText {
  const parts: string[] = []
  for (const b of (blocks ?? []) as { type?: string; text?: { text?: string }; elements?: { text?: string }[] }[]) {
    if (b?.type === 'section' && b.text?.text) parts.push(b.text.text)
    else if (b?.type === 'context') for (const e of b.elements ?? []) if (e?.text) parts.push(e.text)
  }
  const lines = parts.join('\n').split('\n')
  if (lines.length > 1 && /^\s*(:[a-z0-9_+-]+:\s*|\p{Extended_Pictographic}\s*)?\*[^*]+\*\s*$/u.test(lines[0])) lines.shift()
  const body = lines.map(plain).filter(Boolean).join('\n')
  return { title: plain(text), body: body.length > 600 ? body.slice(0, 599) + '…' : body }
}

function plain(s: string): string {
  return s
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')     // <網址|文字> → 文字
    .replace(/<[@#!][^>]*>/g, '')              // <@U123> 之類的提及
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:/g, '')             // :memo: 之類的 Slack 表情代碼
    .replace(/[*~`]/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
