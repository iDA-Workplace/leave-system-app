// ⚠️ 這個檔案是「自動產生」的，不要直接編輯。
//
// 由 supabase/functions/build-standalone.mjs 從 daily-leave-job/index.ts 與
// _shared/*.ts 攤平而成，給 Supabase 後台的網頁版編輯器貼上用
// （網頁編輯器不支援多檔案匯入）。
//
// 要改邏輯請改 index.ts，然後跑：
//   node supabase/functions/build-standalone.mjs


import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ───── 內聯自 ../_shared/leave.ts ─────
// 請假相關的共用工具：台北時區換算、假單文字描述。
// 兩支 function（事件通知、每日彙整）都要用，所以放這裡，
// 免得「幾點算今天」這種事在兩邊各寫一次然後慢慢長歪。

// 用 esm.sh 而不是 jsr:，因為前者在所有版本的 Supabase Edge Runtime 上都能跑；
// jsr: 只有比較新的 runtime 支援，而這個專案的 runtime 版本無從確認。

/**
 * 台灣沒有日光節約時間，全年固定 UTC+8，所以直接用固定位移就夠，
 * 不需要拉完整的時區資料庫進來。
 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 每日彙整發送的時間（台北時間，24 小時制）。 */
const DIGEST_HOUR = 9

/** 現在時刻，但各欄位（getUTCHours 等）讀出來會是台北的牆上時間。 */
function taipeiNow(): Date {
  return new Date(Date.now() + TAIPEI_OFFSET_MS)
}

/** 台北的今天，格式 YYYY-MM-DD。 */
function taipeiToday(): string {
  return taipeiNow().toISOString().slice(0, 10)
}

/**
 * 用 service role 連資料庫。
 *
 * Edge function 沒有使用者的登入狀態，所以只能用 service role key，
 * 這把鑰匙會繞過所有 RLS。這裡可以接受，是因為這兩支 function 全部都是
 * 「唯讀 + 往 Slack 送訊息」，不會依照外部傳進來的身分去寫入任何資料。
 */
function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

const LEAVE_SELECT = `
  id, created_at, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name),
  leave_type:leave_types(name)
`

interface LeaveRow {
  id: string
  created_at?: string
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
  hours: number | null
  reason: string | null
  status: string
  flow_id: string | null
  current_step: number | null
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null } | null
  proxy?: { full_name: string } | null
  leave_type?: { name: string } | null
}

// ===== 假單的文字呈現 =====
//
// 單張假單的通知一律用條列式（申請人／假別／休假日期／休假時間／時數／
// 職務代理人／事由），每日名單則用精簡單行 —— 名單一次列很多人，展開成
// 條列式會長到不能看。

/** 跨日請假的工作天數（不含週六日）。與網頁版 lib/leaveEntitlements.js 同一套算法。 */
function countWorkdays(startDate: string, endDate: string): number {
  let count = 0
  const current = new Date(startDate)
  const end = new Date(endDate)
  while (current <= end) {
    const day = current.getUTCDay()
    if (day !== 0 && day !== 6) count++
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return count
}

/** 上班時間中午的分界，用來判定上午／下午。 */
const NOON = '13:00'
/** 滿 8 小時就算請整天，未滿都算半天（使用者定義）。 */
const FULL_DAY_HOURS = 8

function isMultiDay(l: LeaveRow): boolean {
  return !!l.end_date && l.end_date > l.start_date
}

/** 全天＝多日連假，或單日請滿 8 小時。 */
function isFullDay(l: LeaveRow): boolean {
  return isMultiDay(l) || (l.hours ?? FULL_DAY_HOURS) >= FULL_DAY_HOURS
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const hhmm = (t: string) => t.slice(0, 5)

/** 「8/17」或「8/17 ~ 8/19」 */
function dateLabel(l: LeaveRow): string {
  return isMultiDay(l) ? `${shortDate(l.start_date)} ~ ${shortDate(l.end_date)}` : shortDate(l.start_date)
}

/** 「08:30-17:30」；多日假沒有時間意義，寫「整日」。 */
function timeLabel(l: LeaveRow): string {
  if (isMultiDay(l)) return '整日'
  if (l.start_time && l.end_time) return `${hhmm(l.start_time)}-${hhmm(l.end_time)}`
  return '整日'
}

/** 連續一天以上一律用天數表示，單日才用小時。 */
function durationLabel(l: LeaveRow): string {
  if (isMultiDay(l)) return `${countWorkdays(l.start_date, l.end_date)} 天`
  return `${l.hours ?? FULL_DAY_HOURS} 小時`
}

/**
 * 單張假單的條列式明細。`extra` 用來補該情境專屬的欄位
 * （例如駁回通知要多一行駁回原因）。
 */
function leaveDetailLines(l: LeaveRow, extra: string[] = []): string {
  const lines = [
    `*申請人:* ${l.requester?.full_name ?? '—'}`,
    `*假別:* ${l.leave_type?.name ?? '請假'}`,
    `*休假日期:* ${dateLabel(l)}`,
    `*休假時間:* ${timeLabel(l)}`,
    `*時數:* ${durationLabel(l)}`,
  ]
  // 沒填代理人就整行不顯示，不要留一行「無」佔版面
  if (l.proxy?.full_name) lines.push(`*職務代理人:* ${l.proxy.full_name}`)
  if (l.reason) lines.push(`*事由:* ${l.reason}`)
  return [...lines, ...extra].join('\n')
}

/**
 * 每日名單用的精簡單行（不含部門）。
 *
 * `markFullDay`：請整天時補上「整天」兩個字。單獨一則的通知（例如今日臨時
 * 請假）要開啟 —— 未滿 8 小時的會顯示時間範圍，整天的如果什麼都不寫，看起來
 * 像資訊漏掉了。每日名單那邊已經有「■ 全天」的分組標題，就不用再重複。
 */
function digestLine(l: LeaveRow, { markFullDay = false } = {}): string {
  const name = l.requester?.full_name ?? '（未知人員）'
  const type = l.leave_type?.name ?? '請假'
  if (isMultiDay(l)) return `• ${name}　${type}（${dateLabel(l)} 連假中）`
  if (isFullDay(l)) return `• ${name}　${type}${markFullDay ? '　整天' : ''}`
  return `• ${name}　${type}　${timeLabel(l)}`
}

/**
 * 把今天請假的人分成全天／上午／下午三組。
 *
 * 橫跨午休但沒有滿 8 小時的假（例如 10:00-15:00）會「同時」出現在上午與
 * 下午兩組 —— 那兩個時段都找不到人，只列一次會讓人誤以為另一個時段找得到。
 */
function groupBySlot(leaves: LeaveRow[]) {
  const fullDay: LeaveRow[] = [], morning: LeaveRow[] = [], afternoon: LeaveRow[] = []
  for (const l of leaves) {
    if (isFullDay(l)) { fullDay.push(l); continue }
    if ((l.start_time ?? '') < NOON) morning.push(l)
    if ((l.end_time ?? '') > NOON) afternoon.push(l)
  }
  const byName = (a: LeaveRow, b: LeaveRow) =>
    (a.requester?.full_name ?? '').localeCompare(b.requester?.full_name ?? '')
  // 時段組依開始時間排序，讀起來就是一條時間軸
  const byTime = (a: LeaveRow, b: LeaveRow) =>
    (a.start_time ?? '').localeCompare(b.start_time ?? '') || byName(a, b)
  return {
    fullDay: fullDay.sort(byName),
    morning: morning.sort(byTime),
    afternoon: afternoon.sort(byTime),
  }
}

/** 查出某張假單「目前這一關」該簽核的人的 Slack ID。 */
async function currentApproverSlackIds(db: SupabaseClient, leave: LeaveRow): Promise<string[]> {
  if (!leave.flow_id || !leave.current_step) return []
  const { data, error } = await db
    .from('approval_flow_steps')
    .select('approver:users!approval_flow_steps_approver_id_fkey(slack_user_id)')
    .eq('flow_id', leave.flow_id)
    .eq('step_order', leave.current_step)
  if (error) throw new Error(`讀取簽核關卡失敗：${error.message}`)
  return (data ?? []).map((r: { approver?: { slack_user_id?: string } }) => r.approver?.slack_user_id).filter(Boolean) as string[]
}

/** 管理後台「核准通知對象」裡設定、且仍啟用的人。 */
async function notificationTargetSlackIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('notification_targets')
    .select('user:users(slack_user_id)')
    .eq('is_active', true)
  if (error) throw new Error(`讀取通知對象失敗：${error.message}`)
  return (data ?? []).map((r: { user?: { slack_user_id?: string } }) => r.user?.slack_user_id).filter(Boolean) as string[]
}

// ───── 內聯自 ../_shared/slack.ts ─────
// Slack Web API 的薄封裝。
//
// 這裡只做「往外送訊息」，沒有任何接收 Slack 進來的請求的程式碼 —— 目前不做
// 「直接在 Slack 上按核准」那類互動功能。互動功能會讓 Slack 反過來打進我們的
// 資料庫，那條路徑沒有登入狀態、繞過 RLS，必須自己驗簽章＋自己檢查權限，
// 風險與工作量都完全不同，所以刻意分開。

const SLACK_API = 'https://slack.com/api'

function requireEnv(name: string): string {
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
function postToChannel(channel: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel, text, blocks, unfurl_links: false })
}

/**
 * 私訊某人。channel 直接傳 Slack user ID（U 開頭）即可，Slack 會自動開 DM。
 * 需要 bot token 具備 chat:write 與 im:write 權限。
 */
function dmUser(slackUserId: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

/**
 * 一次送多人。單一個人送失敗（例如某人的 slack_user_id 填錯、或已離開
 * workspace）不應該讓整批通知失敗，所以用 allSettled 收集錯誤後回報，
 * 而不是讓第一個錯誤就中斷。
 */
async function dmMany(slackUserIds: string[], text: string, blocks?: unknown[]) {
  const targets = [...new Set(slackUserIds.filter(Boolean))]
  const results = await Promise.allSettled(targets.map(id => dmUser(id, text, blocks)))
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${targets[i]}: ${r.reason?.message ?? r.reason}` : null))
    .filter(Boolean)
  return { sent: targets.length - failures.length, failures }
}

function section(markdown: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } }
}

function contextLine(markdown: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] }
}

// 待審假單的每日處理：逾期自動退回 ＋ 提醒還沒簽的主管。
//
// 這支在這個專案之前就存在，跟「每日請假名單」公告完全是兩回事（只是名字
// 相近容易搞混）。原本會查 approval_delegates（代理審核人），但那張表已在
// 20260810_remove_approval_delegates.sql 被整個刪掉，所以一觸發就查詢失敗，
// 等於長期是壞的。這裡是修好並改寫成與其他 function 共用同一套工具的版本。
//
// 商業規則沿用原本的，沒有另外調整：
//   - 待審超過 7 天 → 自動退回，並私訊申請人
//   - 未逾期 → 私訊目前這一關的簽核人提醒（現在附上核准／駁回按鈕）



/** 待審幾天後自動退回。 */
const EXPIRE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

function waitedDays(leave: LeaveRow): number {
  if (!leave.created_at) return 0
  return Math.floor((Date.now() - new Date(leave.created_at).getTime()) / DAY_MS)
}

Deno.serve(async () => {
  try {
    const db = adminClient()
    const cutoff = new Date(Date.now() - EXPIRE_DAYS * DAY_MS).toISOString()

    const { data, error } = await db
      .from('leave_requests').select(LEAVE_SELECT).eq('status', 'pending')
    if (error) throw new Error(`讀取待審假單失敗：${error.message}`)

    const pending = (data ?? []) as unknown as LeaveRow[]
    if (pending.length === 0) {
      return json({ message: 'No pending requests' })
    }

    const toReturn = pending.filter(r => r.created_at && r.created_at <= cutoff)
    const toRemind = pending.filter(r => !r.created_at || r.created_at > cutoff)

    // ── 逾期退回 ──
    for (const leave of toReturn) {
      await db.from('leave_requests').update({
        status: 'returned',
        returned_at: new Date().toISOString(),
        returned_reason: '逾期未審核，系統自動退回',
      }).eq('id', leave.id)

      if (leave.requester?.slack_user_id) {
        await dmMany([leave.requester.slack_user_id], '您的請假申請已逾期退回', [
          section(`:warning: *您的請假申請已逾期退回*\n${leaveDetailLines(leave)}`),
          contextLine(`此假單因 ${EXPIRE_DAYS} 天內未獲審核，已自動退回。請重新送出申請。`),
        ])
      }
    }

    // ── 提醒簽核人 ──
    //
    // 一張假單一則訊息，不是把全部擠成一則清單。因為按下核准／駁回時，
    // 處理端是用 response_url「改寫原本那則訊息」把按鈕換成結果 —— 如果
    // 一則訊息裝了好幾張假單，處理其中一張就會把其他張的按鈕一起蓋掉。
    const remindedIds: string[] = []
    for (const leave of toRemind) {
      if (!leave.flow_id || !leave.current_step) continue

      const { data: steps } = await db
        .from('approval_flow_steps')
        .select('approver:users!approval_flow_steps_approver_id_fkey(slack_user_id)')
        .eq('flow_id', leave.flow_id).eq('step_order', leave.current_step)

      const slackIds = (steps ?? [])
        .map((s: { approver?: { slack_user_id?: string } }) => s.approver?.slack_user_id)
        .filter(Boolean) as string[]
      if (slackIds.length === 0) continue

      const waited = waitedDays(leave)
      await dmMany(slackIds, `${leave.requester?.full_name ?? ''} 的假單待您審核`, [
        section(`:bell: *待審假單提醒*\n${leaveDetailLines(leave)}`),
        contextLine(waited === 0 ? '今天送出，尚未處理' : `已等待 ${waited} 天`),
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: '核准', emoji: true },
              action_id: 'approve_leave', value: leave.id },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: '駁回', emoji: true },
              action_id: 'reject_leave', value: leave.id },
          ],
        },
      ])
      remindedIds.push(leave.id)
    }

    if (remindedIds.length > 0) {
      await db.from('leave_requests')
        .update({ last_reminded_at: new Date().toISOString() })
        .in('id', remindedIds)
    }

    return json({ returned: toReturn.length, reminded: remindedIds.length })
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}
