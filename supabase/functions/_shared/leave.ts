// 請假相關的共用工具：台北時區換算、假單文字描述。
// 兩支 function（事件通知、每日彙整）都要用，所以放這裡，
// 免得「幾點算今天」這種事在兩邊各寫一次然後慢慢長歪。

// 用 esm.sh 而不是 jsr:，因為前者在所有版本的 Supabase Edge Runtime 上都能跑；
// jsr: 只有比較新的 runtime 支援，而這個專案的 runtime 版本無從確認。
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { normalizeLang, t, type Lang } from './i18n.ts'

/**
 * 台灣沒有日光節約時間，全年固定 UTC+8，所以直接用固定位移就夠，
 * 不需要拉完整的時區資料庫進來。
 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 每日彙整發送的時間（台北時間，24 小時制）。 */
export const DIGEST_HOUR = 9

/** 現在時刻，但各欄位（getUTCHours 等）讀出來會是台北的牆上時間。 */
export function taipeiNow(): Date {
  return new Date(Date.now() + TAIPEI_OFFSET_MS)
}

/** 台北的今天，格式 YYYY-MM-DD。 */
export function taipeiToday(): string {
  return taipeiNow().toISOString().slice(0, 10)
}

/**
 * 用 service role 連資料庫。
 *
 * Edge function 沒有使用者的登入狀態，所以只能用 service role key，
 * 這把鑰匙會繞過所有 RLS。這裡可以接受，是因為這兩支 function 全部都是
 * 「唯讀 + 往 Slack 送訊息」，不會依照外部傳進來的身分去寫入任何資料。
 */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

// language 一併帶出來：通知要用「收件人自己」的語言，不是觸發動作那個人的。
export const LEAVE_SELECT = `
  id, created_at, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id, language),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name, slack_user_id, language),
  leave_type:leave_types(name, name_en)
`

export interface LeaveRow {
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
export interface Recipient {
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
export function countWorkdays(startDate: string, endDate: string): number {
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

export function isMultiDay(l: LeaveRow): boolean {
  return !!l.end_date && l.end_date > l.start_date
}

/** 全天＝多日連假，或單日請滿 8 小時。 */
export function isFullDay(l: LeaveRow): boolean {
  return isMultiDay(l) || (l.hours ?? FULL_DAY_HOURS) >= FULL_DAY_HOURS
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const hhmm = (time: string) => time.slice(0, 5)

/** 假別名稱：跟網頁版的 leaveTypeName() 同一套規則 —— 英文模式沒填 name_en 就沿用中文名。 */
export function leaveTypeName(l: LeaveRow, lang: Lang): string {
  if (!l.leave_type) return t(lang, 'leave_fallback_type')
  if (lang === 'en' && l.leave_type.name_en) return l.leave_type.name_en
  return l.leave_type.name || t(lang, 'leave_fallback_type')
}

/** 「8/17」或「8/17 ~ 8/19」 */
export function dateLabel(l: LeaveRow): string {
  return isMultiDay(l) ? `${shortDate(l.start_date)} ~ ${shortDate(l.end_date)}` : shortDate(l.start_date)
}

/** 「08:30-17:30」；多日假沒有時間意義，寫「整日」。 */
export function timeLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'all_day')
  if (l.start_time && l.end_time) return `${hhmm(l.start_time)}-${hhmm(l.end_time)}`
  return t(lang, 'all_day')
}

/** 連續一天以上一律用天數表示，單日才用小時。 */
export function durationLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'days_unit', { n: countWorkdays(l.start_date, l.end_date) })
  return t(lang, 'hours_unit', { n: l.hours ?? FULL_DAY_HOURS })
}

/**
 * 單張假單的條列式明細。`extra` 用來補該情境專屬的欄位
 * （例如駁回通知要多一行駁回原因）。
 */
export function leaveDetailLines(l: LeaveRow, lang: Lang, extra: string[] = []): string {
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
export function digestLine(l: LeaveRow, lang: Lang, { markFullDay = false } = {}): string {
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
export function groupBySlot(leaves: LeaveRow[]) {
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
export async function currentApprovers(db: SupabaseClient, leave: LeaveRow): Promise<Recipient[]> {
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
export async function notificationTargetRecipients(db: SupabaseClient): Promise<Recipient[]> {
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
