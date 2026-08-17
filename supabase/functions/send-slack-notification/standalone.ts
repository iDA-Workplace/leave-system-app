// ⚠️ 這個檔案是「自動產生」的，不要直接編輯。
//
// 由 supabase/functions/build-standalone.mjs 從 send-slack-notification/index.ts 與
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

// language 一併帶出來：通知要用「收件人自己」的語言，不是觸發動作那個人的。
const LEAVE_SELECT = `
  id, created_at, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id, language),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name, slack_user_id, language),
  leave_type:leave_types(name, name_en)
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
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null; language?: string | null } | null
  proxy?: { full_name: string; slack_user_id?: string | null; language?: string | null } | null
  leave_type?: { name: string; name_en?: string | null } | null
}

/** 收件人：Slack ID 與他自己的語言偏好。language 缺省一律當中文。 */
interface Recipient {
  slackUserId: string
  language: Lang
}

// ===== 假單的文字呈現 =====
//
// 單張假單的通知一律用條列式（申請人／假別／休假日期／休假時間／時數／
// 職務代理人／事由），每日名單則用精簡單行 —— 名單一次列很多人，展開成
// 條列式會長到不能看。
//
// 每個函式都收一個 lang 參數：訊息要用「收件人」的語言組出來，同一則訊息
// 絕對不會中英夾雜。

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

/**
 * 單張假單的條列式明細。`extra` 用來補該情境專屬的欄位
 * （例如駁回通知要多一行駁回原因）。
 */
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

/**
 * 每日名單用的精簡單行（不含部門）。
 *
 * `markFullDay`：請整天時補上「整天」兩個字。單獨一則的通知（例如今日臨時
 * 請假）要開啟 —— 未滿 8 小時的會顯示時間範圍，整天的如果什麼都不寫，看起來
 * 像資訊漏掉了。每日名單那邊已經有「■ 全天」的分組標題，就不用再重複。
 */
function digestLine(l: LeaveRow, lang: Lang, { markFullDay = false } = {}): string {
  const name = l.requester?.full_name ?? t(lang, 'unknown_person')
  const type = leaveTypeName(l, lang)
  if (isMultiDay(l)) return `• ${name}　${type}（${t(lang, 'multiday_range', { range: dateLabel(l) })}）`
  if (isFullDay(l)) return `• ${name}　${type}${markFullDay ? t(lang, 'full_day_marker') : ''}`
  return `• ${name}　${type}　${timeLabel(l, lang)}`
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

/** 查出某張假單「目前這一關」該簽核的人（Slack ID ＋ 各自的語言偏好）。 */
async function currentApprovers(db: SupabaseClient, leave: LeaveRow): Promise<Recipient[]> {
  if (!leave.flow_id || !leave.current_step) return []
  const { data, error } = await db
    .from('approval_flow_steps')
    .select('approver:users!approval_flow_steps_approver_id_fkey(slack_user_id, language)')
    .eq('flow_id', leave.flow_id)
    .eq('step_order', leave.current_step)
  if (error) throw new Error(`讀取簽核關卡失敗：${error.message}`)
  return toRecipients(
    (data ?? []).map((r: { approver?: { slack_user_id?: string; language?: string } }) => r.approver),
  )
}

/** 管理後台「核准通知對象」裡設定、且仍啟用的人（Slack ID ＋ 各自的語言偏好）。 */
async function notificationTargetRecipients(db: SupabaseClient): Promise<Recipient[]> {
  const { data, error } = await db
    .from('notification_targets')
    .select('user:users(slack_user_id, language)')
    .eq('is_active', true)
  if (error) throw new Error(`讀取通知對象失敗：${error.message}`)
  return toRecipients(
    (data ?? []).map((r: { user?: { slack_user_id?: string; language?: string } }) => r.user),
  )
}

function toRecipients(rows: ({ slack_user_id?: string; language?: string } | undefined)[]): Recipient[] {
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const row of rows) {
    if (!row?.slack_user_id || seen.has(row.slack_user_id)) continue
    seen.add(row.slack_user_id)
    out.push({ slackUserId: row.slack_user_id, language: normalizeLang(row.language) })
  }
  return out
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
 * 一次送多人，訊息內容固定（不分語言）。單一個人送失敗（例如某人的
 * slack_user_id 填錯、或已離開 workspace）不應該讓整批通知失敗，所以用
 * allSettled 收集錯誤後回報，而不是讓第一個錯誤就中斷。
 */
async function dmMany(slackUserIds: string[], text: string, blocks?: unknown[]) {
  const targets = [...new Set(slackUserIds.filter(Boolean))]
  const results = await Promise.allSettled(targets.map(id => dmUser(id, text, blocks)))
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${targets[i]}: ${r.reason?.message ?? r.reason}` : null))
    .filter(Boolean)
  return { sent: targets.length - failures.length, failures }
}

/**
 * 一次送多人，但每個人用自己的語言。
 *
 * 先把收件人依語言分組，同一組共用一次 build(lang) 組出來的訊息內容，
 * 組數最多就是 2（zh／en），不會因為收件人多而重複組字串。
 */
async function dmManyLocalized(
  recipients: Recipient[],
  build: (lang: Recipient['language']) => { text: string; blocks?: unknown[] },
) {
  const byLang = new Map<Recipient['language'], string[]>()
  for (const r of recipients) {
    if (!r.slackUserId) continue
    const list = byLang.get(r.language) ?? []
    list.push(r.slackUserId)
    byLang.set(r.language, list)
  }

  let sent = 0
  const failures: string[] = []
  for (const [lang, slackUserIds] of byLang) {
    const { text, blocks } = build(lang)
    const result = await dmMany(slackUserIds, text, blocks)
    sent += result.sent
    failures.push(...result.failures.filter((f): f is string => typeof f === 'string'))
  }
  return { sent, failures }
}

function section(markdown: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: markdown } }
}

function contextLine(markdown: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] }
}

// ───── 內聯自 ../_shared/i18n.ts ─────
// Slack 訊息的中英文字典。
//
// 跟前端 src/i18n/translations.js 是同樣的做法（t(key, params) + {name} 佔位符），
// 但這是完全獨立的一份 —— Slack 訊息的語氣、標點、emoji 位置都跟網頁介面不是
// 同一回事，硬要共用同一份字典只會兩邊互相牽制。
//
// 語言的決定方式：每一則通知都是「發給誰」就照那個人 users.language 的設定，
// 不是看誰觸發了這個動作。核准假單的人可能習慣中文，但假單是要發給可能設定
// 英文的申請人 —— 一則訊息只會用收件人自己的語言，絕對不會把兩種語言混在
// 同一則裡。
//
// 例外是「公開頻道」的訊息（每日請假名單、臨時請假補發公告）：那些是一次發給
// 一整個頻道，沒有「單一收件人」可以決定語言，只能固定一種。用環境變數
// SLACK_CHANNEL_LANGUAGE 決定（預設 zh，未設定就照舊全部中文，行為不變）。

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

    err_missing_request_id: '缺少 request_id',
    err_fetch_leave: '讀取假單失敗：{msg}',
    err_unknown_type: '未知的通知類型：{type}',
    err_fetch_steps: '讀取簽核關卡失敗：{msg}',
    err_fetch_targets: '讀取通知對象失敗：{msg}',

    no_approver_slack_id: '這一關的簽核人沒有設定 Slack ID',
    new_request_text: '{name} 送出了一張待您審核的假單',
    new_request_heading: ':memo: *有一張假單待您審核*\n{detail}',
    btn_approve: '核准',
    btn_reject: '駁回',
    review_on_web_hint: '也可以到請假系統的「首頁 → 待審核假單」處理。',

    approved_text: '您的假單已核准',
    approved_heading: ':white_check_mark: *假單已核准*\n{detail}',
    channel_not_set: '未設定 SLACK_LEAVE_CHANNEL，略過頻道公告',
    today_leave_text: '{name} 今天請假',
    today_leave_heading: ':bell: *今日臨時請假*\n{line}',
    today_leave_note: '此假單於今日上午的請假公告發出後才核准，故補發通知。',
    channel_posted: 'posted',
    channel_pending_digest: '尚未到彙整時間，將由每日公告一併發出',
    channel_not_today: '假期不含今天，不需公告',

    no_requester_slack_id: '申請人沒有設定 Slack ID',
    rejected_text: '您的假單已被拒絕',
    rejected_heading: ':x: *假單未通過*\n{detail}',
    rejected_detail_hint: '詳細原因請到請假系統的「假單管理」查看。',

    no_proxy_or_slack_id: '沒有職務代理人或代理人未設定 Slack ID',
    proxy_already_notified: '代理人已在其他通知對象中，不重複發送',
    proxy_text: '您被指定為 {name} 的職務代理人',
    proxy_heading: ':handshake: *您被指定為職務代理人*\n{detail}',
    proxy_note: '這張假單已核准，該時段請協助代理其職務。',
    proxy_sent: 'sent',

    weekday_0: '日', weekday_1: '一', weekday_2: '二', weekday_3: '三',
    weekday_4: '四', weekday_5: '五', weekday_6: '六',
    digest_heading: ':palm_tree: *{month}/{day}（{weekday}）今日請假名單*',
    digest_group_fullday: '全天',
    digest_group_morning: '上午',
    digest_group_afternoon: '下午',
    digest_group_heading: '*■ {label}*\n{lines}',
    digest_footer: '由請假系統自動發送。完整行事曆請見系統首頁。',
    digest_summary_text: '今日請假名單（共 {n} 筆）',

    overdue_reason: '逾期未審核，系統自動退回',
    overdue_text: '您的請假申請已逾期退回',
    overdue_heading: ':warning: *您的請假申請已逾期退回*\n{detail}',
    overdue_note: '此假單因 {n} 天內未獲審核，已自動退回。請重新送出申請。',
    reminder_text: '{name} 的假單待您審核',
    reminder_heading: ':bell: *待審假單提醒*\n{detail}',
    reminder_note_new: '今天送出，尚未處理',
    reminder_note_waited: '已等待 {n} 天',

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

    guard_not_found: '找不到這張假單，可能已被刪除。',
    guard_already_handled: '這張假單{status}，已由其他方式處理完畢，不需要再動作。',
    guard_no_flow: '這張假單沒有設定審核流程，請到系統處理。',
    guard_not_your_turn: '目前輪到第 {n} 關的簽核人處理，不是您。',
    status_approved: '已核准',
    status_rejected: '已駁回',
    status_withdrawn: '已由申請人收回',
    status_returned: '已逾期退回',

    balance_no_account: '找不到對應的系統帳號，請聯繫管理員在「員工帳號管理」補上您的 Slack User ID。',
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

    err_missing_request_id: 'Missing request_id',
    err_fetch_leave: 'Could not load the leave request: {msg}',
    err_unknown_type: 'Unknown notification type: {type}',
    err_fetch_steps: 'Could not load the approval step: {msg}',
    err_fetch_targets: 'Could not load notification recipients: {msg}',

    no_approver_slack_id: 'The approver for this step has no Slack ID set',
    new_request_text: '{name} submitted a leave request for your review',
    new_request_heading: ':memo: *A leave request needs your review*\n{detail}',
    btn_approve: 'Approve',
    btn_reject: 'Reject',
    review_on_web_hint: 'You can also handle this from “Home → Pending Approvals” in the leave system.',

    approved_text: 'Your leave request was approved',
    approved_heading: ':white_check_mark: *Leave request approved*\n{detail}',
    channel_not_set: 'SLACK_LEAVE_CHANNEL is not set, skipping the channel announcement',
    today_leave_text: '{name} is on leave today',
    today_leave_heading: ':bell: *Same-day leave*\n{line}',
    today_leave_note: 'Approved after this morning’s leave announcement, so this is a follow-up notice.',
    channel_posted: 'posted',
    channel_pending_digest: 'Not yet time for the daily digest — will be included in it',
    channel_not_today: 'The leave period does not cover today, no announcement needed',

    no_requester_slack_id: 'The requester has no Slack ID set',
    rejected_text: 'Your leave request was rejected',
    rejected_heading: ':x: *Leave request rejected*\n{detail}',
    rejected_detail_hint: 'See the “Leave Management” page in the leave system for details.',

    no_proxy_or_slack_id: 'No proxy set, or the proxy has no Slack ID',
    proxy_already_notified: 'The proxy is already in the notification list, not sending again',
    proxy_text: 'You have been assigned as {name}’s proxy',
    proxy_heading: ':handshake: *You’ve been assigned as a proxy*\n{detail}',
    proxy_note: 'This leave request has been approved — please cover their responsibilities during that time.',
    proxy_sent: 'sent',

    weekday_0: 'Sun', weekday_1: 'Mon', weekday_2: 'Tue', weekday_3: 'Wed',
    weekday_4: 'Thu', weekday_5: 'Fri', weekday_6: 'Sat',
    digest_heading: ':palm_tree: *Out today ({month}/{day}, {weekday})*',
    digest_group_fullday: 'All day',
    digest_group_morning: 'Morning',
    digest_group_afternoon: 'Afternoon',
    digest_group_heading: '*■ {label}*\n{lines}',
    digest_footer: 'Posted automatically by the leave system. See the homepage for the full calendar.',
    digest_summary_text: 'Out today ({n} people)',

    overdue_reason: 'Automatically returned — not reviewed in time',
    overdue_text: 'Your leave request was returned (overdue)',
    overdue_heading: ':warning: *Your leave request was returned (overdue)*\n{detail}',
    overdue_note: 'This request was not reviewed within {n} days and was automatically returned. Please submit it again.',
    reminder_text: '{name}’s leave request needs your review',
    reminder_heading: ':bell: *Pending approval reminder*\n{detail}',
    reminder_note_new: 'Submitted today, not yet reviewed',
    reminder_note_waited: 'Waiting for {n} days',

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

    guard_not_found: 'This leave request could not be found — it may have been deleted.',
    guard_already_handled: 'This leave request is {status} and has already been handled elsewhere — no action needed.',
    guard_no_flow: 'This leave request has no approval flow set. Please handle it in the system.',
    guard_not_your_turn: 'It is currently step {n}’s approver’s turn, not yours.',
    status_approved: 'approved',
    status_rejected: 'rejected',
    status_withdrawn: 'withdrawn by the requester',
    status_returned: 'returned as overdue',

    balance_no_account: 'We could not match you to an account. Ask an administrator to add your Slack User ID under “Employee Accounts”.',
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

const WEEKDAY_KEYS = ['weekday_0', 'weekday_1', 'weekday_2', 'weekday_3', 'weekday_4', 'weekday_5', 'weekday_6'] as const

/** getUTCDay()／getDay() 的 0-6 轉成對應的字典 key，避免呼叫端自己拼字串。 */
function weekdayKey(day: number): MsgKey {
  return WEEKDAY_KEYS[day] ?? 'weekday_0'
}

// 事件通知：由前端在關鍵動作發生後呼叫。
//
//   new_request                 有人送出（或重送）假單 → 私訊目前這一關的簽核人
//   approved                    假單最後一關核准     → 私訊申請人＋通知對象；
//                                                     若假期涵蓋今天則另外公告到頻道
//   rejected                    假單被拒絕           → 私訊申請人
//
// 前面三種的呼叫點在 LeaveForm.jsx / MyLeaves.jsx / Home.jsx，呼叫格式已經
// 存在於前端，這支 function 是照著那個既有的 { type, request_id } 契約寫的。
//
// 語言：每一則通知都照「收件人自己」users.language 的設定發，不是看誰觸發
// 動作。核准假單的主管可能是中文介面，但假單是發給可能設定英文的申請人 ——
// 一則訊息只會用收件人自己的語言。頻道公告（今日臨時請假補發）沒有單一收件
// 人，語言固定，見 SLACK_CHANNEL_LANGUAGE（未設定＝中文，行為與改版前一致）。




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

/** 公開頻道公告固定用哪個語言：沒設定環境變數就照舊全部中文。 */
function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
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
      case 'rejected':    return json(await notifyRejected(db, leave))
      default:            return json({ error: `未知的通知類型：${type}` }, 400)
    }
  } catch (e) {
    // 通知失敗不應該讓使用者的操作看起來像失敗（假單其實已經送出了），
    // 所以錯誤訊息照實回傳讓前端可以記錄，但不丟 500 以外的副作用。
    return json({ error: (e as Error).message }, 500)
  }
})

async function notifyApprovers(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  const recipients = await currentApprovers(db, leave)
  if (recipients.length === 0) return { skipped: '這一關的簽核人沒有設定 Slack ID' }

  return await dmManyLocalized(recipients, (lang) => ({
    text: t(lang, 'new_request_text', { name: leave.requester?.full_name ?? '' }),
    blocks: [
      section(t(lang, 'new_request_heading', { detail: leaveDetailLines(leave, lang) })),
      // 按鈕由 slack-interactions 那支處理（Slack 會把所有互動事件送到 App
      // 設定的同一個 Interactivity Request URL），所以這裡只負責把按鈕畫出來。
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_approve'), emoji: true },
            action_id: 'approve_leave', value: leave.id },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: t(lang, 'btn_reject'), emoji: true },
            action_id: 'reject_leave', value: leave.id },
        ],
      },
      contextLine(t(lang, 'review_on_web_hint')),
    ],
  }))
}

async function notifyApproved(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  const results: Record<string, unknown> = {}

  // 1) 通知申請人本人 ＋ 管理後台設定的「核准通知對象」
  const requesterRecipient: Recipient[] = leave.requester?.slack_user_id
    ? [{ slackUserId: leave.requester.slack_user_id, language: normalizeLang(leave.requester.language) }]
    : []
  const targetRecipients = await notificationTargetRecipients(db)
  const recipients = dedupeRecipients([...requesterRecipient, ...targetRecipients])

  results.dm = await dmManyLocalized(recipients, (lang) => ({
    text: t(lang, 'approved_text'),
    blocks: [section(t(lang, 'approved_heading', { detail: leaveDetailLines(leave, lang) }))],
  }))

  // 職務代理人的通知刻意等到「核准後」才發 —— 假單還沒過就先通知，萬一被
  // 駁回，代理人已經以為要代班了。代理人可能同時是申請人自己選的通知對象，
  // 所以先確認不是重複的人再發。
  results.proxy = await notifyProxy(db, leave, recipients.map(r => r.slackUserId))

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
      const lang = channelLang()
      await postToChannel(channel, t(lang, 'today_leave_text', { name: leave.requester?.full_name ?? '' }), [
        section(t(lang, 'today_leave_heading', { line: digestLine(leave, lang, { markFullDay: true }) })),
        contextLine(t(lang, 'today_leave_note')),
      ])
      results.channel = 'posted'
    }
  } else {
    results.channel = coversToday ? '尚未到彙整時間，將由每日公告一併發出' : '假期不含今天，不需公告'
  }

  return results
}

async function notifyRejected(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  if (!leave.requester?.slack_user_id) return { skipped: '申請人沒有設定 Slack ID' }
  const lang = normalizeLang(leave.requester.language)

  // 駁回原因存在 leave_approvals，不在假單本身，所以要另外查最後一筆
  const { data: rejection } = await db
    .from('leave_approvals')
    .select('comment')
    .eq('request_id', leave.id).eq('action', 'rejected')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  const extra = rejection?.comment ? [t(lang, 'detail_reject_reason', { reason: rejection.comment })] : []
  return await dmMany([leave.requester.slack_user_id], t(lang, 'rejected_text'), [
    section(t(lang, 'rejected_heading', { detail: leaveDetailLines(leave, lang, extra) })),
    ...(rejection?.comment ? [] : [contextLine(t(lang, 'rejected_detail_hint'))]),
  ])
}

/** 核准後通知職務代理人。回傳說明字串方便從呼叫端的回應看出結果。 */
async function notifyProxy(
  db: ReturnType<typeof adminClient>, leave: LeaveRow, alreadyNotified: string[],
) {
  const { data } = await db
    .from('leave_requests')
    .select('proxy:users!leave_requests_proxy_user_id_fkey(slack_user_id, language)')
    .eq('id', leave.id).maybeSingle()

  const proxy = (data as { proxy?: { slack_user_id?: string; language?: string } } | null)?.proxy
  if (!proxy?.slack_user_id) return '沒有職務代理人或代理人未設定 Slack ID'
  if (alreadyNotified.includes(proxy.slack_user_id)) return '代理人已在其他通知對象中，不重複發送'

  const lang = normalizeLang(proxy.language)
  await dmMany([proxy.slack_user_id], t(lang, 'proxy_text', { name: leave.requester?.full_name ?? '' }), [
    section(t(lang, 'proxy_heading', { detail: leaveDetailLines(leave, lang) })),
    contextLine(t(lang, 'proxy_note')),
  ])
  return 'sent'
}

function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const r of recipients) {
    if (!r.slackUserId || seen.has(r.slackUserId)) continue
    seen.add(r.slackUserId)
    out.push(r)
  }
  return out
}
