// Slack 互動：在 Slack 裡送假單、在 Slack 裡審核假單。
//
// ⚠️ 這支跟另外三支 function 的結構不一樣：它「不」拆 _shared 共用檔，整支
// 是自給自足的單一檔案。原因是這支程式碼量大，如果比照其他支維護
// index.ts + standalone.ts 兩份副本，兩份遲早會改到不一致 —— 而這支牽涉
// 權限判斷，不一致的後果比其他支嚴重。單一檔案同時適用網頁編輯器貼上與
// CLI 部署，沒有副本要同步。
//
// ⚠️ 同理，下面的中英文字典是 _shared/i18n.ts 的複本，不是 import。改動
// 訊息文字時兩邊都要跟著改 —— 這是刻意接受的重複，換來的是這支跟其他三支
// 一樣可以整支貼進 Supabase 網頁編輯器，不必依賴多檔案匯入。
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
// ── 語言 ───────────────────────────────────────────────────────────
// 每則訊息都照「收件人自己」users.language 的設定發，不是看誰觸發動作 ——
// 核准假單的主管可能是中文介面，但假單是發給可能設定英文的申請人。對不到
// 系統帳號的人（resolveUser 找不到）一律用中文，因為那種情況根本不知道
// 對方是誰，無從得知語言偏好。公開頻道公告（今日臨時請假）沒有單一收件人，
// 語言固定，見 SLACK_CHANNEL_LANGUAGE（未設定＝中文，行為與改版前一致）。
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

// ===== 中英文字典（_shared/i18n.ts 的複本，見檔頭說明）=====

type Lang = 'zh' | 'en'

function normalizeLang(v: string | null | undefined): Lang {
  return v === 'en' ? 'en' : 'zh'
}

const T = {
  zh: {
    unknown_person: '（未知人員）',
    leave_fallback_type: '請假',
    all_day: '整日',
    full_day_marker: '　整天',
    days_unit: '{n} 天',
    hours_unit: '{n} 小時',
    multiday_range: '{range} 連假中',

    detail_requester: '*申請人:* {name}',
    detail_type: '*假別:* {type}',
    detail_date: '*休假日期:* {date}',
    detail_time: '*休假時間:* {time}',
    detail_hours: '*時數:* {duration}',
    detail_proxy: '*職務代理人:* {name}',
    detail_reason: '*事由:* {reason}',
    detail_reject_reason: '*駁回原因:* {reason}',

    new_request_text: '{name} 送出了一張待您審核的假單',
    new_request_heading: ':memo: *有一張假單待您審核*\n{detail}',
    btn_approve: '核准',
    btn_reject: '駁回',

    today_leave_text: '{name} 今天請假',
    today_leave_heading: ':bell: *今日臨時請假*\n{line}',
    today_leave_note: '此假單於今日上午的請假公告發出後才核准，故補發通知。',

    no_account_text: '找不到您的系統帳號',
    no_account_heading: ':warning: 找不到對應的系統帳號，請聯繫管理員在「員工帳號管理」補上您的 Slack User ID。',
    ask_leave_prompt_text: '要請假嗎？點下面的按鈕填寫假單。',
    ask_leave_prompt_heading: ':memo: 要請假嗎？點下面的按鈕填寫假單。',
    btn_fill_leave_form: '填寫假單',

    modal_leave_title: '請假申請',
    modal_submit: '送出',
    modal_cancel: '取消',
    field_leave_type: '假別',
    field_leave_type_placeholder: '請選擇',
    field_start_date: '開始日期',
    field_end_date: '結束日期',
    field_start_time: '開始時間',
    field_end_time: '結束時間',
    field_multiday_hint: '跨日請假時會忽略時間，整天計算',
    field_proxy: '職務代理人',
    field_proxy_placeholder: '（可不填）',
    field_reason: '事由',
    modal_attachment_hint: '附件請到請假系統網頁補上（Slack 表單不支援上傳檔案）。',

    err_end_before_start: '結束日期不能早於開始日期',
    err_end_time_before_start: '結束時間必須晚於開始時間',
    err_no_flow: '您尚未被指定審核流程，請聯繫管理員設定。',
    err_submit_failed: '送出失敗：{msg}',
    quota_exceeded: '{type}額度不足：本次申請 {requested} 小時，但只剩 {remaining} 小時（年度額度 {quota} 小時，已使用或審核中 {used} 小時）。',

    leave_submitted_text: '假單已送出',
    leave_submitted_heading: ':white_check_mark: *假單已送出*\n{detail}',
    leave_submitted_no_flow: '此流程不需簽核，已自動核准。',
    leave_submitted_pending: '已通知簽核人，審核結果會在這裡通知您。',

    modal_reject_title: '駁回假單',
    modal_reject_submit: '送出駁回',
    field_reject_reason: '駁回原因',
    err_reject_reason_required: '請填寫駁回原因',

    approved_replace_text: '已核准',
    approved_replace_heading: ':white_check_mark: *已核准*\n{detail}',
    approved_stamp_final: '您已於 {stamp} 核准，流程已完成',
    approved_stamp_next: '您已於 {stamp} 核准，已轉交下一關',
    rejected_replace_text: '已駁回',
    rejected_replace_heading: ':x: *已駁回*\n{detail}',
    approved_dm_text: '您的假單已核准',
    approved_dm_heading: ':white_check_mark: *假單已核准*\n{detail}',
    rejected_dm_text: '您的假單已被駁回',
    rejected_dm_heading: ':x: *假單未通過*\n{detail}',

    proxy_text: '您被指定為 {name} 的職務代理人',
    proxy_heading: ':handshake: *您被指定為職務代理人*\n{detail}',
    proxy_note: '這張假單已核准，該時段請協助代理其職務。',

    guard_not_found: '找不到這張假單，可能已被刪除。',
    guard_already_handled: '這張假單{status}，已由其他方式處理完畢，不需要再動作。',
    guard_no_flow: '這張假單沒有設定審核流程，請到系統處理。',
    guard_not_your_turn: '目前輪到第 {n} 關的簽核人處理，不是您。',
    status_approved: '已核准',
    status_rejected: '已駁回',
    status_withdrawn: '已由申請人收回',
    status_returned: '已逾期退回',

    balance_text: '{name} 的假期額度',
    balance_heading: ':bar_chart: *您的假期額度*（{year} 年度）\n{lines}',
    balance_no_limit: '• *{type}*　無年度上限',
    balance_line: '• *{type}*　可用 {n} 小時{days}',
    balance_days_suffix: '（{days} 天）',
    balance_days_hours_suffix: '（{days} 天 {hours} 小時）',
    balance_footer: '可用額度已扣除還在等簽核的假單。',
  },
  en: {
    unknown_person: '(unknown)',
    leave_fallback_type: 'Leave',
    all_day: 'All day',
    full_day_marker: '　All day',
    days_unit: '{n} days',
    hours_unit: '{n} hrs',
    multiday_range: '{range}',

    detail_requester: '*Employee:* {name}',
    detail_type: '*Leave type:* {type}',
    detail_date: '*Dates:* {date}',
    detail_time: '*Time:* {time}',
    detail_hours: '*Duration:* {duration}',
    detail_proxy: '*Proxy:* {name}',
    detail_reason: '*Reason:* {reason}',
    detail_reject_reason: '*Reason for rejection:* {reason}',

    new_request_text: '{name} submitted a leave request for your review',
    new_request_heading: ':memo: *A leave request needs your review*\n{detail}',
    btn_approve: 'Approve',
    btn_reject: 'Reject',

    today_leave_text: '{name} is on leave today',
    today_leave_heading: ':bell: *Same-day leave*\n{line}',
    today_leave_note: 'Approved after this morning’s leave announcement, so this is a follow-up notice.',

    no_account_text: 'We could not find your account',
    no_account_heading: ':warning: We could not match you to an account. Ask an administrator to add your Slack User ID under “Employee Accounts”.',
    ask_leave_prompt_text: 'Want to request leave? Click the button below to fill out the form.',
    ask_leave_prompt_heading: ':memo: Want to request leave? Click the button below to fill out the form.',
    btn_fill_leave_form: 'Fill out leave request',

    modal_leave_title: 'Leave Request',
    modal_submit: 'Submit',
    modal_cancel: 'Cancel',
    field_leave_type: 'Leave type',
    field_leave_type_placeholder: 'Select',
    field_start_date: 'Start date',
    field_end_date: 'End date',
    field_start_time: 'Start time',
    field_end_time: 'End time',
    field_multiday_hint: 'Time is ignored for multi-day leave — it is counted as full days',
    field_proxy: 'Proxy',
    field_proxy_placeholder: '(optional)',
    field_reason: 'Reason',
    modal_attachment_hint: 'Attach files from the leave system website — the Slack form does not support uploads.',

    err_end_before_start: 'End date cannot be earlier than start date',
    err_end_time_before_start: 'End time must be later than start time',
    err_no_flow: 'No approval flow has been assigned to you. Please contact an administrator.',
    err_submit_failed: 'Submission failed: {msg}',
    quota_exceeded: 'Not enough {type} left: this request is {requested} hours, but only {remaining} hours remain (annual quota {quota} hours; {used} hours already used or pending).',

    leave_submitted_text: 'Leave request submitted',
    leave_submitted_heading: ':white_check_mark: *Leave request submitted*\n{detail}',
    leave_submitted_no_flow: 'No approval is required for this flow — it was approved automatically.',
    leave_submitted_pending: 'The approver has been notified. You’ll be notified here with the result.',

    modal_reject_title: 'Reject Leave Request',
    modal_reject_submit: 'Submit rejection',
    field_reject_reason: 'Reason for rejection',
    err_reject_reason_required: 'Please enter a reason for rejection',

    approved_replace_text: 'Approved',
    approved_replace_heading: ':white_check_mark: *Approved*\n{detail}',
    approved_stamp_final: 'You approved this at {stamp} — the review is complete',
    approved_stamp_next: 'You approved this at {stamp} — passed to the next approver',
    rejected_replace_text: 'Rejected',
    rejected_replace_heading: ':x: *Rejected*\n{detail}',
    approved_dm_text: 'Your leave request was approved',
    approved_dm_heading: ':white_check_mark: *Leave request approved*\n{detail}',
    rejected_dm_text: 'Your leave request was rejected',
    rejected_dm_heading: ':x: *Leave request rejected*\n{detail}',

    proxy_text: 'You have been assigned as {name}’s proxy',
    proxy_heading: ':handshake: *You’ve been assigned as a proxy*\n{detail}',
    proxy_note: 'This leave request has been approved — please cover their responsibilities during that time.',

    guard_not_found: 'This leave request could not be found — it may have been deleted.',
    guard_already_handled: 'This leave request is {status} and has already been handled elsewhere — no action needed.',
    guard_no_flow: 'This leave request has no approval flow set. Please handle it in the system.',
    guard_not_your_turn: 'It is currently step {n}’s approver’s turn, not yours.',
    status_approved: 'approved',
    status_rejected: 'rejected',
    status_withdrawn: 'withdrawn by the requester',
    status_returned: 'returned as overdue',

    balance_text: '{name}’s leave balance',
    balance_heading: ':bar_chart: *Your leave balance* ({year})\n{lines}',
    balance_no_limit: '• *{type}*　no annual limit',
    balance_line: '• *{type}*　{n} hours available{days}',
    balance_days_suffix: ' ({days} days)',
    balance_days_hours_suffix: ' ({days} days {hours} hrs)',
    balance_footer: 'Available quota already excludes leave that is still pending approval.',
  },
} as const

type MsgKey = keyof typeof T['zh']

function t(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  let text: string = T[lang]?.[key] ?? T.zh[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** 公開頻道公告固定用哪個語言：沒設定環境變數就維持全部中文。 */
function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
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

// ===== 背景工作 =====

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined

/**
 * 把工作丟到「回應送出之後」才跑。
 *
 * Slack 規定表單送出（view_submission）與按鈕點擊（block_actions）都必須在
 * 3 秒內收到回應，否則使用者畫面會跳出「連線時遇到一些問題」—— 即使我們的
 * 工作其實已經成功。發通知要打好幾次 Slack API，很容易就超過 3 秒，所以
 * 凡是「使用者不需要等結果」的事（發通知、更新原訊息）一律丟到背景，
 * 只有「決定表單要不要關掉／顯示錯誤」的事才同步做完。
 */
function background(p: Promise<unknown>) {
  const task = p.catch(e => console.error('背景工作失敗：', e))
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task)
}

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
 * 回傳錯誤訊息字串代表擋下，回傳 null 代表放行。`lang` 是送單人自己的語言。
 */
async function checkQuota(
  db: SupabaseClient, userId: string,
  leaveType: { id: string; name: string; name_en: string | null; annual_quota_hours: number | null },
  requestedHours: number,
  lang: Lang,
): Promise<string | null> {
  // 三個查詢一次發出去，不要一個等一個 —— 這段在「送出表單」的同步路徑上，
  // 必須在 Slack 的 3 秒限制內跑完。特休的年度天數即使用不到也一起抓，
  // 多一個查詢的成本遠低於多一輪來回等待。
  const year = new Date().getFullYear()
  const [overrideRes, summaryRes, rowsRes] = await Promise.all([
    db.from('user_leave_entitlements').select('quota_hours')
      .eq('user_id', userId).eq('leave_type_id', leaveType.id).eq('mode', 'manual').maybeSingle(),
    db.from('annual_leave_summary').select('entitled_days').eq('user_id', userId).maybeSingle(),
    db.from('leave_requests').select('hours, start_date, end_date')
      .eq('requester_id', userId).eq('leave_type_id', leaveType.id)
      .in('status', ['approved', 'pending'])
      .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`),
  ])

  const override = overrideRes.data
  let quota: number | null = override?.quota_hours != null ? Number(override.quota_hours) : null
  if (quota == null) {
    if (leaveType.name.includes('特休')) {
      const days = summaryRes.data?.entitled_days
      quota = days != null ? Number(days) * HOURS_PER_DAY : null
    } else {
      quota = leaveType.annual_quota_hours ?? null
    }
  }
  if (quota == null) return null

  const used = (rowsRes.data ?? []).reduce((s, r) => s + leaveRequestHours(r), 0)
  const remaining = quota - used
  if (requestedHours <= remaining) return null

  const f = (h: number) => (Number.isInteger(h) ? h : h.toFixed(1))
  const typeName = lang === 'en' && leaveType.name_en ? leaveType.name_en : leaveType.name
  return t(lang, 'quota_exceeded', {
    type: typeName, requested: f(requestedHours), remaining: f(Math.max(0, remaining)),
    quota: f(quota), used: f(used),
  })
}

// ===== 共用查詢 =====

/** Slack 帳號 → 系統帳號。對不到就是不認識的人，一律拒絕。 */
async function resolveUser(db: SupabaseClient, slackUserId: string) {
  const { data } = await db
    .from('users')
    .select('id, full_name, slack_user_id, default_flow_id, is_active, language')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (!data || data.is_active === false) return null
  return data
}

const LEAVE_SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id, language),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name, slack_user_id, language),
  leave_type:leave_types(name, name_en)
`

interface LeaveRow {
  id: string; start_date: string; end_date: string
  start_time: string | null; end_time: string | null
  hours: number | null; reason: string | null; status: string
  flow_id: string | null; current_step: number | null
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null; language?: string | null } | null
  proxy?: { full_name: string; slack_user_id?: string | null; language?: string | null } | null
  leave_type?: { name: string; name_en?: string | null } | null
}

// ===== 假單的文字呈現（與 _shared/leave.ts 同一套規則）=====

/** 滿 8 小時就算請整天，未滿都算半天（使用者定義）。 */
const FULL_DAY_HOURS = 8

function isMultiDay(l: LeaveRow): boolean {
  return !!l.end_date && l.end_date > l.start_date
}

function isFullDay(l: LeaveRow): boolean {
  return isMultiDay(l) || (l.hours ?? FULL_DAY_HOURS) >= FULL_DAY_HOURS
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const hhmm = (time: string) => time.slice(0, 5)

/** 假別名稱：跟網頁版的 leaveTypeName() 同一套規則 —— 英文模式沒填 name_en 就沿用中文名。 */
function leaveTypeName(l: LeaveRow, lang: Lang): string {
  if (!l.leave_type) return t(lang, 'leave_fallback_type')
  if (lang === 'en' && l.leave_type.name_en) return l.leave_type.name_en
  return l.leave_type.name || t(lang, 'leave_fallback_type')
}

/** 「8/17」或「8/17 ~ 8/19」 */
function dateLabel(l: LeaveRow): string {
  return isMultiDay(l) ? `${shortDate(l.start_date)} ~ ${shortDate(l.end_date)}` : shortDate(l.start_date)
}

/** 「08:30-17:30」；多日假沒有時間意義，寫「整日」。 */
function timeLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'all_day')
  if (l.start_time && l.end_time) return `${hhmm(l.start_time)}-${hhmm(l.end_time)}`
  return t(lang, 'all_day')
}

/** 連續一天以上一律用天數表示，單日才用小時。 */
function durationLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'days_unit', { n: countWorkdays(l.start_date, l.end_date) })
  return t(lang, 'hours_unit', { n: l.hours ?? FULL_DAY_HOURS })
}

/** 單張假單的條列式明細。`extra` 補該情境專屬的欄位（例如駁回原因）。 */
function leaveDetailLines(l: LeaveRow, lang: Lang, extra: string[] = []): string {
  const lines = [
    t(lang, 'detail_requester', { name: l.requester?.full_name ?? '—' }),
    t(lang, 'detail_type', { type: leaveTypeName(l, lang) }),
    t(lang, 'detail_date', { date: dateLabel(l) }),
    t(lang, 'detail_time', { time: timeLabel(l, lang) }),
    t(lang, 'detail_hours', { duration: durationLabel(l, lang) }),
  ]
  // 沒填代理人就整行不顯示，不要留一行「無」佔版面
  if (l.proxy?.full_name) lines.push(t(lang, 'detail_proxy', { name: l.proxy.full_name }))
  if (l.reason) lines.push(t(lang, 'detail_reason', { reason: l.reason }))
  return [...lines, ...extra].join('\n')
}

/** 頻道公告用的精簡單行（不含部門）。 */
function digestLine(l: LeaveRow, lang: Lang, { markFullDay = false } = {}): string {
  const name = l.requester?.full_name ?? t(lang, 'unknown_person')
  const type = leaveTypeName(l, lang)
  if (isMultiDay(l)) return `• ${name}　${type}（${t(lang, 'multiday_range', { range: dateLabel(l) })}）`
  // 整天卻什麼都不寫，看起來像資訊漏掉（未滿 8 小時的會顯示時間範圍）
  if (isFullDay(l)) return `• ${name}　${type}${markFullDay ? t(lang, 'full_day_marker') : ''}`
  return `• ${name}　${type}　${timeLabel(l, lang)}`
}

function dm(slackUserId: string, text: string, blocks: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

/** 這一關的簽核人（系統 id、Slack id、各自的語言偏好）。 */
async function approversForStep(db: SupabaseClient, flowId: string, stepOrder: number) {
  const { data } = await db
    .from('approval_flow_steps')
    .select('approver_id, approver:users!approval_flow_steps_approver_id_fkey(slack_user_id, language)')
    .eq('flow_id', flowId).eq('step_order', stepOrder)
  return (data ?? []) as { approver_id: string; approver?: { slack_user_id?: string; language?: string } }[]
}

/** 待審核通知（含核准／駁回按鈕）—— 送給某一關的所有簽核人，各自用自己的語言。 */
async function notifyApprovers(db: SupabaseClient, leave: LeaveRow) {
  if (!leave.flow_id || !leave.current_step) return
  const steps = await approversForStep(db, leave.flow_id, leave.current_step)

  const buildBlocks = (lang: Lang) => [
    section(t(lang, 'new_request_heading', { detail: leaveDetailLines(leave, lang) })),
    ...(leave.reason ? [section(`*${t(lang, 'field_reason')}*\n${leave.reason}`)] : []),
    ...(leave.proxy?.full_name ? [contextLine(`${t(lang, 'field_proxy')}：${leave.proxy.full_name}`)] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_approve'), emoji: true },
          action_id: 'approve_leave', value: leave.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: t(lang, 'btn_reject'), emoji: true },
          action_id: 'reject_leave', value: leave.id },
      ],
    },
  ]

  for (const s of steps) {
    if (!s.approver?.slack_user_id) continue
    const lang = normalizeLang(s.approver.language)
    await dm(s.approver.slack_user_id, t(lang, 'new_request_text', { name: leave.requester?.full_name ?? '' }), buildBlocks(lang))
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

async function buildLeaveModal(db: SupabaseClient, requester: { id: string }, lang: Lang) {
  const [typesRes, colleaguesRes] = await Promise.all([
    db.from('leave_types').select('id, name, name_en').eq('is_active', true).order('name'),
    // Slack 的下拉選單上限 100 個選項，超過就得改成需要另一個端點的動態搜尋。
    // 以這個系統的規模不會碰到，但真的超過時寧可截斷也不要整個表單開不起來。
    db.from('users').select('id, full_name').eq('is_active', true).neq('id', requester.id)
      .order('full_name').limit(100),
  ])

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const typeLabel = (row: { name: string; name_en: string | null }) =>
    lang === 'en' && row.name_en ? row.name_en : row.name

  return {
    type: 'modal',
    callback_id: 'submit_leave',
    title: { type: 'plain_text', text: t(lang, 'modal_leave_title'), emoji: true },
    submit: { type: 'plain_text', text: t(lang, 'modal_submit'), emoji: true },
    close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
    blocks: [
      {
        type: 'input', block_id: 'leave_type',
        label: { type: 'plain_text', text: t(lang, 'field_leave_type'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_leave_type_placeholder'), emoji: true },
          options: (typesRes.data ?? []).map(row => opt(typeLabel(row), row.id)),
        },
      },
      {
        type: 'input', block_id: 'start_date',
        label: { type: 'plain_text', text: t(lang, 'field_start_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'end_date',
        label: { type: 'plain_text', text: t(lang, 'field_end_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'start_time',
        label: { type: 'plain_text', text: t(lang, 'field_start_time'), emoji: true },
        hint: { type: 'plain_text', text: t(lang, 'field_multiday_hint'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt('09:00', '09:00'),
          options: TIME_OPTIONS.map(time => opt(time, time)),
        },
      },
      {
        type: 'input', block_id: 'end_time',
        label: { type: 'plain_text', text: t(lang, 'field_end_time'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt('18:00', '18:00'),
          options: TIME_OPTIONS.map(time => opt(time, time)),
        },
      },
      {
        type: 'input', block_id: 'proxy', optional: true,
        label: { type: 'plain_text', text: t(lang, 'field_proxy'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_proxy_placeholder'), emoji: true },
          options: (colleaguesRes.data ?? []).map(u => opt(u.full_name, u.id)),
        },
      },
      {
        type: 'input', block_id: 'reason',
        label: { type: 'plain_text', text: t(lang, 'field_reason'), emoji: true },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true },
      },
      contextLine(t(lang, 'modal_attachment_hint')),
    ],
  }
}

// ===== 進入點 =====

Deno.serve(async (req) => {
  const rawBody = await req.text()

  // 先驗簽章再做任何事。少了這一步，任何知道網址的人都能偽造請求核准假單。
  //
  // verifySignature 內部會呼叫 requireEnv('SLACK_SIGNING_SECRET')，如果這個
  // secret 忘了設定會直接 throw；包一層 try/catch 讓這種設定缺漏回一個看得懂
  // 的錯誤，而不是讓整個函式崩潰、回一個難以判斷原因的 HTTP 錯誤（Slack 的
  // Event Subscriptions 驗證網址那一步就是靠這個回應判斷 function 是否正常，
  // 崩潰的話畫面只會顯示「回應了 HTTP error」，看不出真正原因）。
  let signatureOk = false
  try {
    signatureOk = await verifySignature(req, rawBody)
  } catch (e) {
    console.error('簽章驗證失敗（多半是 SLACK_SIGNING_SECRET 沒有設定）：', e)
    return new Response('signature verification misconfigured, check function secrets', { status: 500 })
  }
  if (!signatureOk) {
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

function handleEvent(db: SupabaseClient, body: Record<string, any>) {
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } })
  }

  const event = body.event
  // bot_id 用來擋掉「bot 自己發的訊息」，否則我們回的訊息會再觸發自己
  if (event?.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype) {
    const text: string = event.text ?? ''
    const lower = text.toLowerCase()

    // 回訊息一律走背景：Slack 沒在 3 秒內收到 200 就會「重送同一個事件」，
    // 而我們在等 Slack API 回應，很容易超過 —— 結果就是 bot 回了兩次。
    //
    // 這裡還不知道對方是誰（要等 resolveUser 才知道），所以用哪個語言回覆
    // 只能先看對方打字用的是中文關鍵字還是英文關鍵字來猜；已知身分之後的
    // replyWithBalance 內部會再改用 me.language 為準。
    if (text.includes('假期查詢') || text.includes('假期') || text.includes('額度')) {
      background(replyWithBalance(db, event, 'zh'))
    } else if (lower.includes('balance') || lower.includes('quota')) {
      background(replyWithBalance(db, event, 'en'))
    } else if (text.includes('請假')) {
      background(promptLeaveForm(event, 'zh'))
    } else if (lower.includes('leave')) {
      background(promptLeaveForm(event, 'en'))
    }
  }
  return new Response('ok')
}

/**
 * 打字不會給 trigger_id，沒有 trigger_id 就不能直接彈出表單，所以只能先回
 * 一顆按鈕 —— 點按鈕才會產生 trigger_id。這裡的語言只是「先猜的」，猜錯了
 * 頂多這一則提示文字語言不對，後面真正開表單時（block_actions 已經知道
 * 是誰）一律照 me.language 為準。
 */
function promptLeaveForm(event: Record<string, any>, lang: Lang) {
  return callSlack('chat.postMessage', {
    channel: event.channel,
    text: t(lang, 'ask_leave_prompt_text'),
    blocks: [
      section(t(lang, 'ask_leave_prompt_heading')),
      {
        type: 'actions',
        elements: [{
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: t(lang, 'btn_fill_leave_form'), emoji: true },
          action_id: 'open_leave_form', value: 'open',
        }],
      },
    ],
  })
}

// ---- 假期查詢 ----

/**
 * 回傳這位員工各假別的可用額度。
 *
 * 額度的判定規則跟送出假單時的檢查完全一致（財務個人設定 > 公司預設；
 * 已使用時數含審核中；沒設額度視為無上限），兩邊算出來的數字才不會打架。
 * `fallbackLang`：對不到系統帳號時（不知道對方是誰）用的語言，來自使用者
 * 打字關鍵字的猜測；一旦找到帳號就改用 me.language，不再用猜的。
 */
async function replyWithBalance(db: SupabaseClient, event: Record<string, any>, fallbackLang: Lang) {
  const me = await resolveUser(db, event.user)
  if (!me) {
    await callSlack('chat.postMessage', {
      channel: event.channel,
      text: t(fallbackLang, 'no_account_text'),
      blocks: [section(t(fallbackLang, 'no_account_heading'))],
    })
    return
  }
  const lang = normalizeLang(me.language)

  const year = new Date().getFullYear()
  const [typesRes, overridesRes, summaryRes, usedRes] = await Promise.all([
    db.from('leave_types').select('id, name, name_en, annual_quota_hours').eq('is_active', true).order('name'),
    db.from('user_leave_entitlements').select('leave_type_id, quota_hours')
      .eq('user_id', me.id).eq('mode', 'manual'),
    db.from('annual_leave_summary').select('entitled_days').eq('user_id', me.id).maybeSingle(),
    db.from('leave_requests').select('leave_type_id, hours, start_date, end_date')
      .eq('requester_id', me.id).in('status', ['approved', 'pending'])
      .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`),
  ])

  const overrides = new Map<string, number>()
  for (const r of overridesRes.data ?? []) {
    if (r.quota_hours != null) overrides.set(r.leave_type_id, Number(r.quota_hours))
  }

  const usedByType = new Map<string, number>()
  for (const r of usedRes.data ?? []) {
    usedByType.set(r.leave_type_id, (usedByType.get(r.leave_type_id) ?? 0) + leaveRequestHours(r))
  }

  const f = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1))

  /**
   * 把時數換算成「N 天 M 小時」放在括號裡。
   *
   * 小時才是系統實際記錄、也是擋額度時用的單位，所以永遠放主位；天數只是
   * 給人快速抓概念用的。不滿一天就回 null 讓呼叫端整個略過括號 —— 5 小時
   * 寫成「0.6 天」或「0 天 5 小時」都只會更難讀。
   */
  const asDays = (h: number) => {
    const days = Math.floor(h / HOURS_PER_DAY)
    const rest = h - days * HOURS_PER_DAY
    if (days === 0) return null
    return rest === 0
      ? t(lang, 'balance_days_suffix', { days })
      : t(lang, 'balance_days_hours_suffix', { days, hours: f(rest) })
  }

  const lines: string[] = []
  for (const row of typesRes.data ?? []) {
    const typeName = lang === 'en' && row.name_en ? row.name_en : row.name
    let quota = overrides.get(row.id) ?? null
    if (quota == null) {
      quota = row.name.includes('特休')
        ? (summaryRes.data?.entitled_days != null ? Number(summaryRes.data.entitled_days) * HOURS_PER_DAY : null)
        : (row.annual_quota_hours ?? null)
    }

    if (quota == null) {
      // 沒有設額度＝不受年度上限限制，這種寫「無上限」比寫 0 或空白清楚
      lines.push(t(lang, 'balance_no_limit', { type: typeName }))
      continue
    }
    const remaining = Math.max(0, quota - (usedByType.get(row.id) ?? 0))
    // 特休大家習慣用「天」在講，所以額外換算一份；其他假別只寫時數
    const days = row.name.includes('特休') ? asDays(remaining) : null
    lines.push(t(lang, 'balance_line', { type: typeName, n: f(remaining), days: days ?? '' }))
  }

  await callSlack('chat.postMessage', {
    channel: event.channel,
    text: t(lang, 'balance_text', { name: me.full_name }),
    blocks: [
      section(t(lang, 'balance_heading', { year, lines: lines.join('\n') })),
      contextLine(t(lang, 'balance_footer')),
    ],
  })
}

// ---- Interactivity ----

async function handleInteraction(db: SupabaseClient, p: Record<string, any>) {
  if (p.type === 'block_actions') {
    const action = p.actions?.[0]
    const slackUserId = p.user?.id
    const me = await resolveUser(db, slackUserId)
    if (!me) {
      await dm(slackUserId, t('zh', 'no_account_text'), [section(t('zh', 'no_account_heading'))])
      return new Response('')
    }
    const lang = normalizeLang(me.language)

    if (action.action_id === 'open_leave_form') {
      await callSlack('views.open', { trigger_id: p.trigger_id, view: await buildLeaveModal(db, me, lang) })
      return new Response('')
    }
    if (action.action_id === 'approve_leave') {
      return await handleApprove(db, me, lang, action.value, p.response_url)
    }
    if (action.action_id === 'reject_leave') {
      // 駁回一定要填理由（與網頁版一致），所以再開一個視窗收理由。
      // response_url 只有現在這個 payload 有，view_submission 收不到，
      // 所以先塞進 private_metadata 帶過去。語言不用一併塞——view_submission
      // 送出時會重新 resolveUser 拿到同一個人的 me.language，沒有必要在
      // 兩個地方各存一份、之後改動時忘記同步。
      await callSlack('views.open', {
        trigger_id: p.trigger_id,
        view: {
          type: 'modal', callback_id: 'submit_reject',
          private_metadata: JSON.stringify({ request_id: action.value, response_url: p.response_url }),
          title: { type: 'plain_text', text: t(lang, 'modal_reject_title'), emoji: true },
          submit: { type: 'plain_text', text: t(lang, 'modal_reject_submit'), emoji: true },
          close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
          blocks: [{
            type: 'input', block_id: 'comment',
            label: { type: 'plain_text', text: t(lang, 'field_reject_reason'), emoji: true },
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
      return json({ response_action: 'errors', errors: { reason: t('zh', 'no_account_heading') } })
    }
    const lang = normalizeLang(me.language)
    if (p.view.callback_id === 'submit_leave') return await handleLeaveSubmit(db, me, lang, p)
    if (p.view.callback_id === 'submit_reject') return await handleRejectSubmit(db, me, lang, p)
  }

  return new Response('')
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

// ---- 送出假單 ----

async function handleLeaveSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
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
    return json({ response_action: 'errors', errors: { end_date: t(lang, 'err_end_before_start') } })
  }

  const isMultiDay = endDate > startDate
  const hours = isMultiDay ? null : calcHours(startTime, endTime)
  if (!isMultiDay && (hours ?? 0) <= 0) {
    return json({ response_action: 'errors', errors: { end_time: t(lang, 'err_end_time_before_start') } })
  }
  if (!me.default_flow_id) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_no_flow') } })
  }

  const { data: leaveType } = await db
    .from('leave_types').select('id, name, name_en, annual_quota_hours').eq('id', leaveTypeId).single()

  const requestedHours = isMultiDay ? countWorkdays(startDate, endDate) * HOURS_PER_DAY : (hours ?? 0)
  const quotaError = leaveType ? await checkQuota(db, me.id, leaveType, requestedHours, lang) : null
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
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_submit_failed', { msg: error.message }) } })
  }

  // 假單已經寫進資料庫，剩下的通知使用者不需要等 —— 全部丟到背景，
  // 讓 Slack 立刻收到「關閉表單」的回應，避免 3 秒逾時跳出「連線時遇到
  // 一些問題」（工作其實有做完，只是回應太慢）。
  background((async () => {
    const { data: leave } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', created.id).single()
    const row = leave as unknown as LeaveRow

    const steps = await approversForStep(db, me.default_flow_id, 1)
    if (steps.length === 0) {
      // 沒有設定任何簽核關卡＝不需審核（目前只有老闆是這種設定），與網頁版一致。
      // 這條路徑一樣要走完「核准後」該做的事 —— 之前這裡直接改狀態就結束，
      // 導致這種員工當天臨時請假時頻道上沒有任何人知道。
      await db.from('leave_requests').update({ status: 'approved' }).eq('id', created.id)
      await notifyProxy(db, row)
      await notifyChannelIfToday(db, row)
    } else {
      await notifyApprovers(db, row)
    }

    if (me.slack_user_id) {
      await dm(me.slack_user_id, t(lang, 'leave_submitted_text'), [
        section(t(lang, 'leave_submitted_heading', { detail: leaveDetailLines(row, lang) })),
        contextLine(steps.length === 0 ? t(lang, 'leave_submitted_no_flow') : t(lang, 'leave_submitted_pending')),
      ])
    }
  })())

  return json({ response_action: 'clear' })
}

// ---- 核准 ----

function handleApprove(db: SupabaseClient, me: any, lang: Lang, requestId: string, responseUrl: string) {
  // 按鈕點擊同樣有 3 秒回應限制，所以整段做完再回應會逾時。改成立刻回應、
  // 實際處理走背景 —— 使用者看到的結果是原訊息被改寫（透過 response_url），
  // 那個動作本來就是非同步的，不需要卡在這次 HTTP 回應裡。
  background((async () => {
    const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', requestId).single()
    const leave = data as unknown as LeaveRow

    const guard = await guardApproval(db, me, leave, lang)
    if (guard) {
      await replaceMessage(responseUrl, guard, [section(`:information_source: ${guard}`)])
      return
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
    // 這則「已於 X 核准」是寫給按下核准的那個人（me）看的，所以用 me.language。
    const stamp = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`

    // 按鈕換成結果文字，避免重複點或看不出自己按過了
    await replaceMessage(responseUrl, t(lang, 'approved_replace_text'), [
      section(t(lang, 'approved_replace_heading', { detail: leaveDetailLines(leave, lang) })),
      contextLine(isFinal ? t(lang, 'approved_stamp_final', { stamp }) : t(lang, 'approved_stamp_next', { stamp })),
    ])

    if (isFinal) {
      if (leave.requester?.slack_user_id) {
        const requesterLang = normalizeLang(leave.requester.language)
        await dm(leave.requester.slack_user_id, t(requesterLang, 'approved_dm_text'),
          [section(t(requesterLang, 'approved_dm_heading', { detail: leaveDetailLines(leave, requesterLang) }))])
      }
      await notifyProxy(db, leave)
      await notifyChannelIfToday(db, leave)
    } else {
      await notifyApprovers(db, { ...leave, current_step: (leave.current_step ?? 1) + 1 })
    }
  })())

  return new Response('')
}

// ---- 駁回 ----

async function handleRejectSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  const meta = JSON.parse(p.view.private_metadata || '{}')
  const comment = (p.view.state.values.comment?.v?.value ?? '').trim()
  if (!comment) return json({ response_action: 'errors', errors: { comment: t(lang, 'err_reject_reason_required') } })

  const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', meta.request_id).single()
  const leave = data as unknown as LeaveRow

  const guard = await guardApproval(db, me, leave, lang)
  if (guard) return json({ response_action: 'errors', errors: { comment: guard } })

  await db.from('leave_approvals').insert({
    request_id: leave.id, approver_id: me.id, step_order: leave.current_step,
    action: 'rejected', comment,
  })
  await db.from('leave_requests').update({ status: 'rejected' }).eq('id', leave.id)

  // 狀態已經寫進資料庫，通知丟背景讓表單立刻關閉（同樣避免 3 秒逾時）。
  // 把關與寫入刻意留在同步段：那兩件事的結果決定表單要關掉還是顯示錯誤。
  background((async () => {
    if (meta.response_url) {
      const detail = leaveDetailLines(leave, lang, [t(lang, 'detail_reject_reason', { reason: comment })])
      await replaceMessage(meta.response_url, t(lang, 'rejected_replace_text'), [
        section(t(lang, 'rejected_replace_heading', { detail })),
      ])
    }
    if (leave.requester?.slack_user_id) {
      const requesterLang = normalizeLang(leave.requester.language)
      const requesterDetail = leaveDetailLines(leave, requesterLang, [t(requesterLang, 'detail_reject_reason', { reason: comment })])
      await dm(leave.requester.slack_user_id, t(requesterLang, 'rejected_dm_text'), [
        section(t(requesterLang, 'rejected_dm_heading', { detail: requesterDetail })),
      ])
    }
  })())

  return json({ response_action: 'clear' })
}

/**
 * 核准／駁回前的把關。回傳字串代表擋下並說明原因，回傳 null 代表可以動作。
 * 訊息用 `lang`（動作發起人 me 的語言）—— 這是唯一會直接顯示給他看的文字。
 *
 * 一律用資料庫「當下」的狀態判斷，不信任按鈕上帶的任何東西 —— 那顆按鈕可能
 * 是三天前發出的，這張假單早就在網頁上被處理掉了，或流程已經走到別關。
 */
async function guardApproval(db: SupabaseClient, me: any, leave: LeaveRow | null, lang: Lang): Promise<string | null> {
  if (!leave) return t(lang, 'guard_not_found')
  if (leave.status !== 'pending') {
    const statusKey = ({ approved: 'status_approved', rejected: 'status_rejected', withdrawn: 'status_withdrawn', returned: 'status_returned' } as const)[leave.status]
    const label = statusKey ? t(lang, statusKey) : leave.status
    return t(lang, 'guard_already_handled', { status: label })
  }
  if (!leave.flow_id || !leave.current_step) return t(lang, 'guard_no_flow')

  const steps = await approversForStep(db, leave.flow_id, leave.current_step)
  if (!steps.some(s => s.approver_id === me.id)) {
    return t(lang, 'guard_not_your_turn', { n: leave.current_step })
  }
  return null
}

/**
 * 核准後通知職務代理人。
 *
 * 刻意等到核准後才發 —— 假單還沒過就先通知，萬一被駁回，代理人已經以為
 * 要代班了。代理人的 Slack ID 沒填就安靜略過（跟其他通知一致）。
 */
async function notifyProxy(db: SupabaseClient, leave: LeaveRow) {
  const { data } = await db
    .from('leave_requests')
    .select('proxy:users!leave_requests_proxy_user_id_fkey(slack_user_id, language)')
    .eq('id', leave.id).maybeSingle()

  const proxy = (data as { proxy?: { slack_user_id?: string; language?: string } } | null)?.proxy
  if (!proxy?.slack_user_id) return
  const lang = normalizeLang(proxy.language)
  await dm(proxy.slack_user_id, t(lang, 'proxy_text', { name: leave.requester?.full_name ?? '' }), [
    section(t(lang, 'proxy_heading', { detail: leaveDetailLines(leave, lang) })),
    contextLine(t(lang, 'proxy_note')),
  ])
}

/** 當天臨時請假：核准當下若假期已涵蓋今天且過了每日公告時間，補一則頻道公告。 */
async function notifyChannelIfToday(db: SupabaseClient, leave: LeaveRow) {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const today = now.toISOString().slice(0, 10)
  const coversToday = leave.start_date <= today && leave.end_date >= today
  if (!coversToday || now.getUTCHours() < 9) return

  const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
  if (!channel) return
  const lang = channelLang()
  await callSlack('chat.postMessage', {
    channel,
    text: t(lang, 'today_leave_text', { name: leave.requester?.full_name ?? '' }),
    blocks: [
      section(t(lang, 'today_leave_heading', { line: digestLine(leave, lang, { markFullDay: true }) })),
      contextLine(t(lang, 'today_leave_note')),
    ],
  })
}
