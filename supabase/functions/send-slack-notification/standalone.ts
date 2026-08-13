// ⚠️ 這是給 Supabase 後台「網頁版 Edge Function 編輯器」用的單檔版本。
//
// 內容跟 index.ts 完全一樣，只是把 _shared/slack.ts 與 _shared/leave.ts
// 合併進同一個檔案 —— 網頁編輯器不支援多檔案匯入。
//
// 如果你是用 `supabase functions deploy` 這個指令部署，
// 請用 index.ts，不要用這份（這份只是它的「攤平版」）。
//
// 兩份要保持同步：改了商業邏輯，記得 index.ts 和這份都要改。

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ===== Slack 封裝 =====

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

function postToChannel(channel: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel, text, blocks, unfurl_links: false })
}

function dmUser(slackUserId: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

async function dmMany(slackUserIds: string[], text: string, blocks?: unknown[]) {
  const targets = [...new Set(slackUserIds.filter(Boolean))]
  const results = await Promise.allSettled(targets.map(id => dmUser(id, text, blocks)))
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${targets[i]}: ${(r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason}` : null))
    .filter(Boolean)
  return { sent: targets.length - failures.length, failures }
}

function section(markdown: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } }
}

function contextLine(markdown: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] }
}

// ===== 請假共用工具 =====

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
const DIGEST_HOUR = 9

function taipeiNow(): Date {
  return new Date(Date.now() + TAIPEI_OFFSET_MS)
}

function taipeiToday(): string {
  return taipeiNow().toISOString().slice(0, 10)
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

const LEAVE_SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name),
  leave_type:leave_types(name)
`

interface LeaveRow {
  id: string
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

function periodLabel(leave: LeaveRow): string {
  const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  if (leave.end_date && leave.end_date > leave.start_date) {
    return `${short(leave.start_date)} ～ ${short(leave.end_date)}`
  }
  if (leave.start_time && leave.end_time) {
    const hm = (t: string) => t.slice(0, 5)
    return `${short(leave.start_date)} ${hm(leave.start_time)}～${hm(leave.end_time)}`
  }
  return short(leave.start_date)
}

function durationLabel(leave: LeaveRow): string {
  if (leave.end_date && leave.end_date > leave.start_date) return '整日'
  return leave.hours ? `${leave.hours} 小時` : '整日'
}

function leaveSummary(leave: LeaveRow): string {
  const name = leave.requester?.full_name ?? '（未知人員）'
  const dept = leave.requester?.department ? `（${leave.requester.department}）` : ''
  const type = leave.leave_type?.name ?? '請假'
  return `*${name}*${dept}　${type}　${periodLabel(leave)}　${durationLabel(leave)}`
}

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

async function notificationTargetSlackIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('notification_targets')
    .select('user:users(slack_user_id)')
    .eq('is_active', true)
  if (error) throw new Error(`讀取通知對象失敗：${error.message}`)
  return (data ?? []).map((r: { user?: { slack_user_id?: string } }) => r.user?.slack_user_id).filter(Boolean) as string[]
}

// ===== 事件通知本體 =====
//
//   new_request  有人送出（或重送）假單 → 私訊目前這一關的簽核人
//   approved     假單最後一關核准      → 私訊申請人＋通知對象；
//                                        若假期涵蓋今天則另外公告到頻道
//   rejected     假單被拒絕            → 私訊申請人

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { type, request_id } = await req.json()
    const db = adminClient()

    if (!request_id) return json({ error: '缺少 request_id' }, 400)

    const { data, error } = await db
      .from('leave_requests').select(LEAVE_SELECT).eq('id', request_id).single()
    if (error) return json({ error: `讀取假單失敗：${error.message}` }, 500)
    const leave = data as unknown as LeaveRow

    switch (type) {
      case 'new_request': return json(await notifyApprovers(db, leave))
      case 'approved':    return json(await notifyApproved(db, leave))
      case 'rejected':    return json(await notifyRejected(leave))
      default:            return json({ error: `未知的通知類型：${type}` }, 400)
    }
  } catch (e) {
    // 通知失敗不應該讓使用者的操作看起來像失敗（假單其實已經送出了），
    // 所以錯誤訊息照實回傳讓前端可以記錄，但不丟 500 以外的副作用。
    return json({ error: (e as Error).message }, 500)
  }
})

async function notifyApprovers(db: SupabaseClient, leave: LeaveRow) {
  const slackIds = await currentApproverSlackIds(db, leave)
  if (slackIds.length === 0) return { skipped: '這一關的簽核人沒有設定 Slack ID' }

  const text = `${leave.requester?.full_name ?? ''} 送出了一張待您審核的假單`
  return await dmMany(slackIds, text, [
    section(`:memo: *有一張假單待您審核*\n${leaveSummary(leave)}`),
    ...(leave.reason ? [section(`*事由*\n${leave.reason}`)] : []),
    ...(leave.proxy?.full_name ? [contextLine(`職務代理人：${leave.proxy.full_name}`)] : []),
    // 按鈕由 slack-interactions 那支處理（Slack 會把所有互動事件送到 App
    // 設定的同一個 Interactivity Request URL），所以這裡只負責把按鈕畫出來。
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '核准', emoji: true },
          action_id: 'approve_leave', value: leave.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: '駁回', emoji: true },
          action_id: 'reject_leave', value: leave.id },
      ],
    },
    contextLine(`也可以到請假系統的「首頁 → 待審核假單」處理。`),
  ])
}

async function notifyApproved(db: SupabaseClient, leave: LeaveRow) {
  const results: Record<string, unknown> = {}

  // 1) 通知申請人本人 ＋ 管理後台設定的「核准通知對象」
  const recipients = [
    ...(leave.requester?.slack_user_id ? [leave.requester.slack_user_id] : []),
    ...(await notificationTargetSlackIds(db)),
  ]
  results.dm = await dmMany(recipients, '您的假單已核准', [
    section(`:white_check_mark: *假單已核准*\n${leaveSummary(leave)}`),
  ])

  // 2) 當天臨時請假的補發公告。
  //
  //    每天 09:00 的彙整只看得到「當下已核准」的假單，所以下午才核准、
  //    而且假期就涵蓋今天的那種臨時假，早上那則公告一定漏掉 —— 這裡補一則。
  //    只在過了彙整時間之後才補發，否則 09:00 前核准的假會被公告兩次。
  const today = taipeiToday()
  const coversToday = leave.start_date <= today && leave.end_date >= today
  const afterDigest = taipeiNow().getUTCHours() >= DIGEST_HOUR

  if (coversToday && afterDigest) {
    const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
    if (!channel) {
      results.channel = '未設定 SLACK_LEAVE_CHANNEL，略過頻道公告'
    } else {
      await postToChannel(channel, `${leave.requester?.full_name ?? ''} 今天請假`, [
        section(`:bell: *今日臨時請假*\n${leaveSummary(leave)}`),
        contextLine('此假單於今日上午的請假公告發出後才核准，故補發通知。'),
      ])
      results.channel = 'posted'
    }
  } else {
    results.channel = coversToday ? '尚未到彙整時間，將由每日公告一併發出' : '假期不含今天，不需公告'
  }

  return results
}

async function notifyRejected(leave: LeaveRow) {
  if (!leave.requester?.slack_user_id) return { skipped: '申請人沒有設定 Slack ID' }
  return await dmMany([leave.requester.slack_user_id], '您的假單已被拒絕', [
    section(`:x: *假單未通過*\n${leaveSummary(leave)}`),
    contextLine('詳細原因請到請假系統的「假單管理」查看。'),
  ])
}
