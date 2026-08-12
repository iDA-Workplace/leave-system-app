// ⚠️ 這是給 Supabase 後台「網頁版 Edge Function 編輯器」用的單檔版本。
//
// 內容跟 index.ts 完全一樣，只是把 _shared/leave.ts 與 _shared/slack.ts
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
  const body = await res.json()
  if (!body.ok) throw new Error(`Slack ${method} 失敗：${body.error}`)
  return body
}

function postToChannel(channel: string, text: string, blocks?: unknown[]) {
  return callSlack('chat.postMessage', { channel, text, blocks, unfurl_links: false })
}

function section(markdown: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } }
}

function contextLine(markdown: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] }
}

// ===== 請假共用工具 =====

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

function taipeiToday(): string {
  return new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
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

// ===== 每日彙整本體 =====
//
// 每天上午 9 點（台北時間）把「今天有誰請假」發到頻道，用來取代 Outlook
// calendar 公告。沒有人請假的日子安靜跳過，不發任何訊息。
//
// 排程方式見 supabase/functions/README.md（用 pg_cron + pg_net 定時打這支）。
// 這支 function 不看系統時間決定「要不要發」—— 被呼叫就發，時間點交給排程
// 決定，這樣手動觸發補發也才有用。

Deno.serve(async () => {
  try {
    const db = adminClient()
    const today = taipeiToday()

    // 涵蓋今天的所有已核准假單：開始日在今天或更早，結束日在今天或更晚。
    // （表單強制要填 end_date，單日假的 end_date 會等於 start_date，
    //   所以這個範圍條件對單日與多日都成立。）
    const { data, error } = await db
      .from('leave_requests')
      .select(LEAVE_SELECT)
      .eq('status', 'approved')
      .lte('start_date', today)
      .gte('end_date', today)
    if (error) throw new Error(`讀取假單失敗：${error.message}`)

    const leaves = (data ?? []) as LeaveRow[]
    if (leaves.length === 0) {
      return new Response(JSON.stringify({ date: today, count: 0, posted: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 同一個人可能同時有多張假單涵蓋今天，公告要回答的是「今天誰不在」，
    // 所以照姓名排序讓同一個人的假單相鄰，讀起來才不會東一條西一條。
    leaves.sort((a, b) =>
      (a.requester?.department ?? '').localeCompare(b.requester?.department ?? '') ||
      (a.requester?.full_name ?? '').localeCompare(b.requester?.full_name ?? ''),
    )

    const d = new Date(today)
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()]
    const heading = `:palm_tree: *${d.getUTCMonth() + 1}/${d.getUTCDate()}（${weekday}）今日請假名單*`

    await postToChannel(
      requireEnv('SLACK_LEAVE_CHANNEL'),
      `今日請假名單（共 ${leaves.length} 筆）`,
      [
        section(heading),
        section(leaves.map(l => `• ${leaveSummary(l)}`).join('\n')),
        contextLine('由請假系統自動發送。完整行事曆請見系統首頁。'),
      ],
    )

    return new Response(JSON.stringify({ date: today, count: leaves.length, posted: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
