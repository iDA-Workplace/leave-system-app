// Slack 互動：在 Slack 裡送假單、在 Slack 裡審核假單。
//
// ⚠️ 這支跟另外三支 function 的結構不一樣：它「不」拆 _shared 共用檔，整支
// 是自給自足的單一檔案。原因是這支程式碼量大，如果比照其他支維護
// index.ts + standalone.ts 兩份副本，兩份遲早會改到不一致 —— 而這支牽涉
// 權限判斷，不一致的後果比其他支嚴重。單一檔案同時適用網頁編輯器貼上與
// CLI 部署，沒有副本要同步。
//
// ── 這支處理的三種請求 ─────────────────────────────────────────────
// 1. Events API（application/json）
//    - url_verification：Slack 設定 Request URL 時的握手
//    - message.im：同事私訊 bot 打「請假」→ 回一則帶按鈕的訊息
//      （Slack 規定：打字「不會」給 trigger_id，沒有 trigger_id 就不能彈出
//       表單視窗，所以一定要先回一顆按鈕讓使用者點）
// 2. Interactivity（application/x-www-form-urlencoded，payload=<json>）
//    - block_actions：點「填寫假單」「核准」「駁回」按鈕
//    - view_submission：送出假單表單、送出駁回理由
//
// ── 資安 ───────────────────────────────────────────────────────────
// 這條路徑是「Slack 反過來打進我們的資料庫」，沒有任何登入狀態，用的是
// service role key（繞過所有 RLS）。所以每一個請求都必須：
//   a. 驗證簽章確認真的來自 Slack（不然任何人都能偽造請求核准假單）
//   b. 把 Slack user id 對應回系統帳號，對不到就拒絕
//   c. 動作發生的當下「重新」檢查權限與狀態，不信任按鈕上帶的任何資訊
//      （按鈕可能是三天前發的，那張假單早就在網頁上被處理掉了）

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SLACK_API = 'https://slack.com/api'
const HOURS_PER_DAY = 8

function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`缺少環境變數 ${name}`)
  return v
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

// ===== Slack API =====

async function callSlack(method: string, payload: unknown) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}`,
    },
    body: JSON.stringify(payload),
  })
  // Slack 失敗時照樣回 HTTP 200，錯誤在 body.ok / body.error
  const body = await res.json()
  if (!body.ok) console.error(`Slack ${method} 失敗：${body.error}`)
  return body
}

/** 用 response_url 覆蓋原本那則訊息（把按鈕換掉，避免重複點）。 */
async function replaceMessage(responseUrl: string, text: string, blocks: unknown[]) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, blocks }),
  })
}

const section = (md: string) => ({ type: 'section', text: { type: 'mrkdwn', text: md } })
const contextLine = (md: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: md }] })

// ===== 簽章驗證 =====

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get('x-slack-request-timestamp')
  const sig = req.headers.get('x-slack-signature')
  if (!ts || !sig) return false

  // 重放攻擊防護：超過 5 分鐘的請求一律不收
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(requireEnv('SLACK_SIGNING_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${ts}:${rawBody}`))
  const expected = 'v0=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')

  // 長度不同直接失敗；長度相同時逐字比較但不提早跳出，避免用回應時間反推簽章
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

// ===== 請假時數（與網頁版 lib/leaveEntitlements.js 同一套算法）=====

function calcHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return 0
  let total = endMin - startMin
  const overlapStart = Math.max(startMin, 12 * 60)
  const overlapEnd = Math.min(endMin, 13 * 60)
  if (overlapEnd > overlapStart) total -= (overlapEnd - overlapStart)
  return Math.max(0, total / 60)
}

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

function leaveRequestHours(r: { hours: number | null; start_date: string; end_date: string }): number {
  if (r.hours != null) return Number(r.hours)
  return countWorkdays(r.start_date, r.end_date) * HOURS_PER_DAY
}

/**
 * 額度檢查，規則與網頁版完全一致：
 * 已使用時數把「審核中」也算進去（否則連送多張各自都卡在額度內的假單就能
 * 超額）；沒有設額度的假別視為無上限；財務的個人設定優先於公司預設。
 * 回傳錯誤訊息字串代表擋下，回傳 null 代表放行。
 */
async function checkQuota(
  db: SupabaseClient, userId: string,
  leaveType: { id: string; name: string; annual_quota_hours: number | null },
  requestedHours: number,
): Promise<string | null> {
  const { data: override } = await db
    .from('user_leave_entitlements')
    .select('quota_hours')
    .eq('user_id', userId).eq('leave_type_id', leaveType.id).eq('mode', 'manual')
    .maybeSingle()

  let quota: number | null = override?.quota_hours != null ? Number(override.quota_hours) : null
  if (quota == null) {
    if (leaveType.name.includes('特休')) {
      const { data: summary } = await db
        .from('annual_leave_summary').select('entitled_days').eq('user_id', userId).maybeSingle()
      quota = summary?.entitled_days != null ? Number(summary.entitled_days) * HOURS_PER_DAY : null
    } else {
      quota = leaveType.annual_quota_hours ?? null
    }
  }
  if (quota == null) return null

  const year = new Date().getFullYear()
  const { data: rows } = await db
    .from('leave_requests')
    .select('hours, start_date, end_date')
    .eq('requester_id', userId).eq('leave_type_id', leaveType.id)
    .in('status', ['approved', 'pending'])
    .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`)

  const used = (rows ?? []).reduce((s, r) => s + leaveRequestHours(r), 0)
  const remaining = quota - used
  if (requestedHours <= remaining) return null

  const f = (h: number) => (Number.isInteger(h) ? h : h.toFixed(1))
  return `${leaveType.name}額度不足：本次申請 ${f(requestedHours)} 小時，但只剩 ${f(Math.max(0, remaining))} 小時`
    + `（年度額度 ${f(quota)} 小時，已使用或審核中 ${f(used)} 小時）。`
}

// ===== 共用查詢 =====

/** Slack 帳號 → 系統帳號。對不到就是不認識的人，一律拒絕。 */
async function resolveUser(db: SupabaseClient, slackUserId: string) {
  const { data } = await db
    .from('users')
    .select('id, full_name, slack_user_id, default_flow_id, is_active')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (!data || data.is_active === false) return null
  return data
}

const LEAVE_SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name),
  leave_type:leave_types(name)
`

interface LeaveRow {
  id: string; start_date: string; end_date: string
  start_time: string | null; end_time: string | null
  hours: number | null; reason: string | null; status: string
  flow_id: string | null; current_step: number | null
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null } | null
  proxy?: { full_name: string } | null
  leave_type?: { name: string } | null
}

function periodLabel(l: LeaveRow): string {
  const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  if (l.end_date && l.end_date > l.start_date) return `${short(l.start_date)} ～ ${short(l.end_date)}`
  if (l.start_time && l.end_time) return `${short(l.start_date)} ${l.start_time.slice(0, 5)}～${l.end_time.slice(0, 5)}`
  return short(l.start_date)
}

function durationLabel(l: LeaveRow): string {
  if (l.end_date && l.end_date > l.start_date) return '整日'
  return l.hours ? `${l.hours} 小時` : '整日'
}

function leaveSummary(l: LeaveRow): string {
  const dept = l.requester?.department ? `（${l.requester.department}）` : ''
  return `*${l.requester?.full_name ?? ''}*${dept}　${l.leave_type?.name ?? '請假'}　${periodLabel(l)}　${durationLabel(l)}`
}

function dm(slackUserId: string, text: string, blocks: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

/** 這一關的簽核人（系統 id 與 Slack id）。 */
async function approversForStep(db: SupabaseClient, flowId: string, stepOrder: number) {
  const { data } = await db
    .from('approval_flow_steps')
    .select('approver_id, approver:users!approval_flow_steps_approver_id_fkey(slack_user_id)')
    .eq('flow_id', flowId).eq('step_order', stepOrder)
  return (data ?? []) as { approver_id: string; approver?: { slack_user_id?: string } }[]
}

/** 待審核通知（含核准／駁回按鈕）—— 送給某一關的所有簽核人。 */
async function notifyApprovers(db: SupabaseClient, leave: LeaveRow) {
  if (!leave.flow_id || !leave.current_step) return
  const steps = await approversForStep(db, leave.flow_id, leave.current_step)
  const blocks = [
    section(`:memo: *有一張假單待您審核*\n${leaveSummary(leave)}`),
    ...(leave.reason ? [section(`*事由*\n${leave.reason}`)] : []),
    ...(leave.proxy?.full_name ? [contextLine(`職務代理人：${leave.proxy.full_name}`)] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '核准', emoji: true },
          action_id: 'approve_leave', value: leave.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: '駁回', emoji: true },
          action_id: 'reject_leave', value: leave.id },
      ],
    },
  ]
  for (const s of steps) {
    if (s.approver?.slack_user_id) {
      await dm(s.approver.slack_user_id, `${leave.requester?.full_name ?? ''} 送出了一張待您審核的假單`, blocks)
    }
  }
}

// ===== 假單表單 =====

const TIME_OPTIONS: string[] = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 30) break
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}

const opt = (text: string, value: string) => ({ text: { type: 'plain_text', text, emoji: true }, value })

async function buildLeaveModal(db: SupabaseClient, requester: { id: string }) {
  const [typesRes, colleaguesRes] = await Promise.all([
    db.from('leave_types').select('id, name').eq('is_active', true).order('name'),
    // Slack 的下拉選單上限 100 個選項，超過就得改成需要另一個端點的動態搜尋。
    // 以這個系統的規模不會碰到，但真的超過時寧可截斷也不要整個表單開不起來。
    db.from('users').select('id, full_name').eq('is_active', true).neq('id', requester.id)
      .order('full_name').limit(100),
  ])

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

  return {
    type: 'modal',
    callback_id: 'submit_leave',
    title: { type: 'plain_text', text: '請假申請', emoji: true },
    submit: { type: 'plain_text', text: '送出', emoji: true },
    close: { type: 'plain_text', text: '取消', emoji: true },
    blocks: [
      {
        type: 'input', block_id: 'leave_type',
        label: { type: 'plain_text', text: '假別', emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: '請選擇', emoji: true },
          options: (typesRes.data ?? []).map(t => opt(t.name, t.id)),
        },
      },
      {
        type: 'input', block_id: 'start_date',
        label: { type: 'plain_text', text: '開始日期', emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'end_date',
        label: { type: 'plain_text', text: '結束日期', emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'start_time',
        label: { type: 'plain_text', text: '開始時間', emoji: true },
        hint: { type: 'plain_text', text: '跨日請假時會忽略時間，整天計算', emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt('09:00', '09:00'),
          options: TIME_OPTIONS.map(t => opt(t, t)),
        },
      },
      {
        type: 'input', block_id: 'end_time',
        label: { type: 'plain_text', text: '結束時間', emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt('18:00', '18:00'),
          options: TIME_OPTIONS.map(t => opt(t, t)),
        },
      },
      {
        type: 'input', block_id: 'proxy', optional: true,
        label: { type: 'plain_text', text: '職務代理人', emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: '（可不填）', emoji: true },
          options: (colleaguesRes.data ?? []).map(u => opt(u.full_name, u.id)),
        },
      },
      {
        type: 'input', block_id: 'reason',
        label: { type: 'plain_text', text: '事由', emoji: true },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true },
      },
      contextLine('附件請到請假系統網頁補上（Slack 表單不支援上傳檔案）。'),
    ],
  }
}

// ===== 進入點 =====

Deno.serve(async (req) => {
  const rawBody = await req.text()

  // 先驗簽章再做任何事。少了這一步，任何知道網址的人都能偽造請求核准假單。
  if (!await verifySignature(req, rawBody)) {
    return new Response('invalid signature', { status: 401 })
  }

  const db = adminClient()
  const contentType = req.headers.get('content-type') ?? ''

  try {
    if (contentType.includes('application/json')) {
      return await handleEvent(db, JSON.parse(rawBody))
    }
    const params = new URLSearchParams(rawBody)
    const payload = JSON.parse(params.get('payload') ?? '{}')
    return await handleInteraction(db, payload)
  } catch (e) {
    console.error(e)
    return new Response('ok') // 回錯誤碼會讓 Slack 一直重送，錯誤記在 log 就好
  }
})

// ---- Events API ----

async function handleEvent(db: SupabaseClient, body: Record<string, any>) {
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } })
  }

  const event = body.event
  // bot_id 用來擋掉「bot 自己發的訊息」，否則我們回的訊息會再觸發自己
  if (event?.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype) {
    const text: string = event.text ?? ''
    if (text.includes('請假') || text.toLowerCase().includes('leave')) {
      // 打字不會給 trigger_id，沒有 trigger_id 就不能直接彈出表單，
      // 所以只能先回一顆按鈕 —— 點按鈕才會產生 trigger_id。
      await callSlack('chat.postMessage', {
        channel: event.channel,
        text: '要請假嗎？點下面的按鈕填寫假單。',
        blocks: [
          section(':memo: 要請假嗎？點下面的按鈕填寫假單。'),
          {
            type: 'actions',
            elements: [{
              type: 'button', style: 'primary',
              text: { type: 'plain_text', text: '填寫假單', emoji: true },
              action_id: 'open_leave_form', value: 'open',
            }],
          },
        ],
      })
    }
  }
  return new Response('ok')
}

// ---- Interactivity ----

async function handleInteraction(db: SupabaseClient, p: Record<string, any>) {
  if (p.type === 'block_actions') {
    const action = p.actions?.[0]
    const slackUserId = p.user?.id
    const me = await resolveUser(db, slackUserId)
    if (!me) {
      await dm(slackUserId, '找不到您的系統帳號',
        [section(':warning: 找不到對應的系統帳號，請聯繫管理員在「員工帳號管理」補上您的 Slack User ID。')])
      return new Response('')
    }

    if (action.action_id === 'open_leave_form') {
      await callSlack('views.open', { trigger_id: p.trigger_id, view: await buildLeaveModal(db, me) })
      return new Response('')
    }
    if (action.action_id === 'approve_leave') {
      return await handleApprove(db, me, action.value, p.response_url)
    }
    if (action.action_id === 'reject_leave') {
      // 駁回一定要填理由（與網頁版一致），所以再開一個視窗收理由。
      // response_url 只有現在這個 payload 有，view_submission 收不到，
      // 所以先塞進 private_metadata 帶過去。
      await callSlack('views.open', {
        trigger_id: p.trigger_id,
        view: {
          type: 'modal', callback_id: 'submit_reject',
          private_metadata: JSON.stringify({ request_id: action.value, response_url: p.response_url }),
          title: { type: 'plain_text', text: '駁回假單', emoji: true },
          submit: { type: 'plain_text', text: '送出駁回', emoji: true },
          close: { type: 'plain_text', text: '取消', emoji: true },
          blocks: [{
            type: 'input', block_id: 'comment',
            label: { type: 'plain_text', text: '駁回原因', emoji: true },
            element: { type: 'plain_text_input', action_id: 'v', multiline: true },
          }],
        },
      })
      return new Response('')
    }
    return new Response('')
  }

  if (p.type === 'view_submission') {
    const me = await resolveUser(db, p.user?.id)
    if (!me) {
      return json({ response_action: 'errors', errors: { reason: '找不到您的系統帳號，請聯繫管理員。' } })
    }
    if (p.view.callback_id === 'submit_leave') return await handleLeaveSubmit(db, me, p)
    if (p.view.callback_id === 'submit_reject') return await handleRejectSubmit(db, me, p)
  }

  return new Response('')
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

// ---- 送出假單 ----

async function handleLeaveSubmit(db: SupabaseClient, me: any, p: Record<string, any>) {
  const v = p.view.state.values
  const pick = (block: string) => v[block]?.v?.selected_option?.value ?? null
  const leaveTypeId = pick('leave_type')
  const startDate = v.start_date?.v?.selected_date
  const endDate = v.end_date?.v?.selected_date
  const startTime = pick('start_time') ?? '09:00'
  const endTime = pick('end_time') ?? '18:00'
  const proxyId = pick('proxy')
  const reason = v.reason?.v?.value ?? ''

  if (endDate < startDate) {
    return json({ response_action: 'errors', errors: { end_date: '結束日期不能早於開始日期' } })
  }

  const isMultiDay = endDate > startDate
  const hours = isMultiDay ? null : calcHours(startTime, endTime)
  if (!isMultiDay && (hours ?? 0) <= 0) {
    return json({ response_action: 'errors', errors: { end_time: '結束時間必須晚於開始時間' } })
  }
  if (!me.default_flow_id) {
    return json({ response_action: 'errors', errors: { reason: '您尚未被指定審核流程，請聯繫管理員設定。' } })
  }

  const { data: leaveType } = await db
    .from('leave_types').select('id, name, annual_quota_hours').eq('id', leaveTypeId).single()

  const requestedHours = isMultiDay ? countWorkdays(startDate, endDate) * HOURS_PER_DAY : (hours ?? 0)
  const quotaError = leaveType ? await checkQuota(db, me.id, leaveType, requestedHours) : null
  if (quotaError) {
    // 顯示在假別欄位下方，使用者一眼看得到是哪個假別的額度問題
    return json({ response_action: 'errors', errors: { leave_type: quotaError } })
  }

  const { data: created, error } = await db.from('leave_requests').insert({
    requester_id: me.id,
    leave_type_id: leaveTypeId,
    flow_id: me.default_flow_id,
    start_date: startDate,
    end_date: endDate,
    start_time: isMultiDay ? '09:00' : startTime,
    end_time: isMultiDay ? '18:00' : endTime,
    hours,
    proxy_user_id: proxyId,
    reason,
    status: 'pending',
    current_step: 1,
  }).select('id').single()

  if (error) {
    return json({ response_action: 'errors', errors: { reason: '送出失敗：' + error.message } })
  }

  const { data: leave } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', created.id).single()
  const row = leave as unknown as LeaveRow

  const steps = await approversForStep(db, me.default_flow_id, 1)
  if (steps.length === 0) {
    // 沒有設定任何簽核關卡＝不需審核，與網頁版行為一致
    await db.from('leave_requests').update({ status: 'approved' }).eq('id', created.id)
  } else {
    await notifyApprovers(db, row)
  }

  if (me.slack_user_id) {
    await dm(me.slack_user_id, '假單已送出', [
      section(`:white_check_mark: *假單已送出*\n${leaveSummary(row)}`),
      contextLine(steps.length === 0 ? '此流程不需簽核，已自動核准。' : '已通知簽核人，審核結果會在這裡通知您。'),
    ])
  }
  return json({ response_action: 'clear' })
}

// ---- 核准 ----

async function handleApprove(db: SupabaseClient, me: any, requestId: string, responseUrl: string) {
  const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', requestId).single()
  const leave = data as unknown as LeaveRow

  const guard = await guardApproval(db, me, leave)
  if (guard) {
    await replaceMessage(responseUrl, guard, [section(`:information_source: ${guard}`)])
    return new Response('')
  }

  await db.from('leave_approvals').insert({
    request_id: leave.id, approver_id: me.id, step_order: leave.current_step, action: 'approved',
  })

  const { data: allSteps } = await db
    .from('approval_flow_steps').select('step_order').eq('flow_id', leave.flow_id)
  const maxStep = Math.max(...(allSteps ?? []).map(s => s.step_order))
  const isFinal = (leave.current_step ?? 1) >= maxStep

  if (isFinal) {
    await db.from('leave_requests').update({ status: 'approved' }).eq('id', leave.id)
  } else {
    await db.from('leave_requests').update({ current_step: (leave.current_step ?? 1) + 1 }).eq('id', leave.id)
  }

  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const stamp = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`

  // 按鈕換成結果文字，避免重複點或看不出自己按過了
  await replaceMessage(responseUrl, '已核准', [
    section(`:white_check_mark: *已核准*\n${leaveSummary(leave)}`),
    contextLine(isFinal ? `您已於 ${stamp} 核准，流程已完成` : `您已於 ${stamp} 核准，已轉交下一關`),
  ])

  if (isFinal) {
    if (leave.requester?.slack_user_id) {
      await dm(leave.requester.slack_user_id, '您的假單已核准',
        [section(`:white_check_mark: *假單已核准*\n${leaveSummary(leave)}`)])
    }
    await notifyChannelIfToday(db, leave)
  } else {
    await notifyApprovers(db, { ...leave, current_step: (leave.current_step ?? 1) + 1 })
  }
  return new Response('')
}

// ---- 駁回 ----

async function handleRejectSubmit(db: SupabaseClient, me: any, p: Record<string, any>) {
  const meta = JSON.parse(p.view.private_metadata || '{}')
  const comment = (p.view.state.values.comment?.v?.value ?? '').trim()
  if (!comment) return json({ response_action: 'errors', errors: { comment: '請填寫駁回原因' } })

  const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', meta.request_id).single()
  const leave = data as unknown as LeaveRow

  const guard = await guardApproval(db, me, leave)
  if (guard) return json({ response_action: 'errors', errors: { comment: guard } })

  await db.from('leave_approvals').insert({
    request_id: leave.id, approver_id: me.id, step_order: leave.current_step,
    action: 'rejected', comment,
  })
  await db.from('leave_requests').update({ status: 'rejected' }).eq('id', leave.id)

  if (meta.response_url) {
    await replaceMessage(meta.response_url, '已駁回', [
      section(`:x: *已駁回*\n${leaveSummary(leave)}`),
      contextLine(`駁回原因：${comment}`),
    ])
  }
  if (leave.requester?.slack_user_id) {
    await dm(leave.requester.slack_user_id, '您的假單已被駁回', [
      section(`:x: *假單未通過*\n${leaveSummary(leave)}`),
      section(`*駁回原因*\n${comment}`),
    ])
  }
  return json({ response_action: 'clear' })
}

/**
 * 核准／駁回前的把關。回傳字串代表擋下並說明原因，回傳 null 代表可以動作。
 *
 * 一律用資料庫「當下」的狀態判斷，不信任按鈕上帶的任何東西 —— 那顆按鈕可能
 * 是三天前發出的，這張假單早就在網頁上被處理掉了，或流程已經走到別關。
 */
async function guardApproval(db: SupabaseClient, me: any, leave: LeaveRow | null): Promise<string | null> {
  if (!leave) return '找不到這張假單，可能已被刪除。'
  if (leave.status !== 'pending') {
    const label = { approved: '已核准', rejected: '已駁回', withdrawn: '已由申請人收回', returned: '已逾期退回' }[leave.status] ?? leave.status
    return `這張假單${label}，已由其他方式處理完畢，不需要再動作。`
  }
  if (!leave.flow_id || !leave.current_step) return '這張假單沒有設定審核流程，請到系統處理。'

  const steps = await approversForStep(db, leave.flow_id, leave.current_step)
  if (!steps.some(s => s.approver_id === me.id)) {
    return `目前輪到第 ${leave.current_step} 關的簽核人處理，不是您。`
  }
  return null
}

/** 當天臨時請假：核准當下若假期已涵蓋今天且過了每日公告時間，補一則頻道公告。 */
async function notifyChannelIfToday(db: SupabaseClient, leave: LeaveRow) {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const today = now.toISOString().slice(0, 10)
  const coversToday = leave.start_date <= today && leave.end_date >= today
  if (!coversToday || now.getUTCHours() < 9) return

  const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
  if (!channel) return
  await callSlack('chat.postMessage', {
    channel,
    text: `${leave.requester?.full_name ?? ''} 今天請假`,
    blocks: [
      section(`:bell: *今日臨時請假*\n${leaveSummary(leave)}`),
      contextLine('此假單於今日上午的請假公告發出後才核准，故補發通知。'),
    ],
  })
}
