import { supabase } from './supabase'

/**
 * 按摩預約的共用工具。
 *
 * 所有「規則」都在資料庫函式裡（supabase/migrations/20261019_massage_booking.sql），
 * 這裡只負責時間換算、顯示用的格式，以及把資料庫回傳的錯誤代碼對到翻譯字串。
 * 前端刻意不重算任何規則 —— 兩邊各寫一次，遲早會對不起來。
 */

// 有兩個外鍵指到 users（user_id、attendance_marked_by），所以 embed 要指定是哪一個
export const SIGNUP_SELECT = `
  id, session_id, user_id, signed_up_at, draw_rank, result, went_last_time,
  yield_asked, yield_answer, slot_no, slot_conflict, released_at, released_late,
  offer_slot_no, offer_status, offer_expires_at, attendance, grabbed_at,
  user:users!massage_signups_user_id_fkey(full_name, department)
`

/** 管理員或 HR —— 跟資料庫的 is_massage_manager() 同一個判斷 */
export function isMassageManager(userProfile) {
  return !!userProfile && userProfile.is_active !== false && !!(userProfile.is_admin || userProfile.is_finance)
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

function fmtMinutes(total) {
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 第 n 個時段的起訖時間（'13:40'、'13:55'） */
export function slotRange(session, n) {
  const start = toMinutes(session.start_time) + (n - 1) * (session.slot_minutes + session.break_minutes)
  return { from: fmtMinutes(start), to: fmtMinutes(start + session.slot_minutes) }
}

/** 整段按摩時間（含最後一位的休息），預設 13:00–16:00 */
export function sessionWindow(session) {
  const start = toMinutes(session.start_time)
  return {
    from: fmtMinutes(start),
    to: fmtMinutes(start + session.slot_count * (session.slot_minutes + session.break_minutes)),
  }
}

/** 台灣時間的「某天幾點幾分」→ Date（不管使用者電腦設哪個時區都一樣） */
export function taipeiDate(dateStr, hhmm) {
  return new Date(`${dateStr}T${String(hhmm).slice(0, 5)}:00+08:00`)
}

export function slotStartAt(session, n) {
  return taipeiDate(session.session_date, slotRange(session, n).from)
}

export function slotEndAt(session, n) {
  return taipeiDate(session.session_date, slotRange(session, n).to)
}

/** 台灣時間的今天（YYYY-MM-DD） */
export function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
}

/**
 * 這一期現在在哪個階段。
 *   open      報名中
 *   closed    報名截止、還沒抽籤
 *   drawn     已抽籤、按摩還沒結束
 *   finished  按摩已結束
 */
export function sessionPhase(session, now = new Date()) {
  if (session.drawn_at) {
    const end = taipeiDate(session.session_date, sessionWindow(session).to)
    return now >= end ? 'finished' : 'drawn'
  }
  return now < new Date(session.signup_deadline) ? 'open' : 'closed'
}

const PHASE_TONE = { open: 'success', closed: 'warning', drawn: 'info', finished: 'neutral' }
export function phaseTone(phase) {
  return PHASE_TONE[phase] || 'neutral'
}

function locale(lang) {
  return lang === 'en' ? 'en-US' : 'zh-TW'
}

export function fmtDate(dateStr, lang) {
  return new Date(`${dateStr}T00:00:00+08:00`).toLocaleDateString(locale(lang), {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  })
}

export function fmtDateTime(ts, lang) {
  if (!ts) return ''
  return new Date(ts).toLocaleString(locale(lang), {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** 'YYYY-MM-DDTHH:MM'（台灣時間，給 <input type="datetime-local">）↔ ISO */
export function toTaipeiInput(ts) {
  if (!ts) return ''
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ts)).map(p => [p.type, p.value]),
  )
  const hour = parts.hour === '24' ? '00' : parts.hour
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`
}

export function fromTaipeiInput(value) {
  return value ? new Date(`${value}:00+08:00`).toISOString() : null
}

/** 某天往前推 n 天（YYYY-MM-DD） */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 新增一期時的預設值，照試算表原本的規則：
 *   報名截止 = 按摩前一天 12:00、預計抽籤 = 前一天 16:00、取消期限 = 當天 12:00
 */
export function defaultDeadlines(sessionDate) {
  const dayBefore = addDays(sessionDate, -1)
  return {
    signup_deadline: `${dayBefore}T12:00`,
    draw_scheduled_at: `${dayBefore}T16:00`,
    cancel_deadline: `${sessionDate}T12:00`,
    release_open_at: `${sessionDate}T11:00`,
  }
}

/**
 * 釋出等待期（使用者決定）：抽籤後到「釋出開放時間」之前釋出的名額先保留、可以取消釋出，
 * 時間到才交給候補或開放報名。跟資料庫的 massage_release_held 同一個判斷，只用來決定畫面上顯示什麼。
 */
export function releaseHeld(session, now = new Date()) {
  return !!session?.drawn_at && !session.release_opened_at && !!session.release_open_at
    && now < new Date(session.release_open_at)
}

/** 這個人的釋出是不是還在等待期（可以取消釋出） */
export function isHeldRelease(session, signup, now = new Date()) {
  return !!signup?.released_at && signup.slot_no != null && !!session?.drawn_at
    && new Date(signup.released_at) >= new Date(session.drawn_at) && releaseHeld(session, now)
}

/** 等待期間「釋出中」的時段（沒有人、而且是抽籤後有人釋出的）—— 同 massage_held_slots */
export function heldSlots(session, signups, now = new Date()) {
  if (!releaseHeld(session, now)) return []
  const set = new Set(signups.filter(s => isHeldRelease(session, s, now)).map(s => s.slot_no))
  return [...set].filter(n => !holderOf(signups, n)).sort((a, b) => a - b)
}

/** 現在可以搶的時段（已開放、還沒結束、沒有人、沒有人手上有邀請）—— 同 massage_open_slots */
export function openSlots(session, signups, now = new Date()) {
  if (!session?.drawn_at || !session.release_opened_at) return []
  return Array.from({ length: session.slot_count }, (_, i) => i + 1)
    .filter(n => now < slotEndAt(session, n) && !holderOf(signups, n) && !pendingOfferFor(signups, n))
}

/** 釋出開放時間 →「10/28（三）上午 11:00」（使用者指定的寫法，跟 Slack 一致） */
export function fmtOpens(ts, lang) {
  if (!ts) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts)).map(p => [p.type, p.value]))
  const h = Number(parts.hour) % 24
  const h12 = h % 12 || 12
  if (lang === 'en') return `${parts.weekday} ${parts.month}/${parts.day} ${h12}:${parts.minute} ${h < 12 ? 'AM' : 'PM'}`
  const zhWeek = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' }[parts.weekday]
  return `${parts.month}/${parts.day}（${zhWeek}）${h < 12 ? '上午' : '下午'} ${h12}:${parts.minute}`
}

/** 假單 →「2026/10/27 特休 13:00–18:00」（搶空位時「這個時段你剛好請假」用） */
export function leaveShort(leave, lang) {
  if (!leave) return ''
  const d = v => String(v).slice(0, 10).replaceAll('-', '/')
  const sameDay = leave.start_date === leave.end_date
  const dates = sameDay ? d(leave.start_date) : `${d(leave.start_date)}–${d(leave.end_date)}`
  const type = (lang === 'en' && leave.leave_type_en) || leave.leave_type || ''
  const time = sameDay && leave.start_time && leave.end_time ? ` ${leave.start_time}–${leave.end_time}` : ''
  return `${dates} ${type}${time}`.trim()
}

// 資料庫函式回傳的 code → 翻譯字串的 key。沒列到的一律顯示通用錯誤。
const KNOWN_CODES = new Set([
  'not_signed_in', 'session_not_found', 'already_drawn', 'signup_closed', 'user_inactive',
  'leave_conflict', 'already_signed_up', 'not_allowed', 'signup_not_closed', 'not_found',
  'already_released', 'slot_over', 'no_pending_offer', 'offer_expired', 'slot_taken',
  'invalid_slot', 'not_started', 'already_marked', 'invalid_status', 'no_slot',
  'not_asked', 'already_answered', 'not_waitlisted', 'owner_not_manager',
  'not_drawn', 'already_has_slot', 'not_open', 'cancel_release_closed', 'not_released',
])

export function massageErrorKey(code) {
  return KNOWN_CODES.has(code) ? `massage_err_${code}` : 'massage_err_unknown'
}

/**
 * 呼叫按摩預約的資料庫函式。回傳 { ok, data, errorKey, raw }：
 *   · 連線 / 權限錯誤（supabase error）→ errorKey = massage_err_unknown
 *   · 函式自己回 { ok: false, code } → errorKey 對到那個 code
 */
export async function callMassage(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { ok: false, errorKey: 'massage_err_unknown', raw: error.message }
  // 有些「失敗」其實也改了資料（例如按「我要」時邀請已過期 → 改問下一位），所以不論成敗都觸發
  pokeMassageNotify()
  if (data && data.ok === false) return { ok: false, errorKey: massageErrorKey(data.code), data }
  return { ok: true, data }
}

/**
 * 叫 Slack 通知那支（massage-notify）現在跑一次，通知不用等到下一分鐘的排程。
 * 不等它、失敗也不管 —— 排程每分鐘都會補做，畫面不該因為 Slack 慢而卡住。
 */
export function pokeMassageNotify(body = {}) {
  supabase.functions.invoke('massage-notify', { body }).catch(() => {})
}

/** HR 代登記（或改了代登記的假單）之後：撞到當事人的按摩 → Slack 私訊提醒當事人釋出 */
export function remindMassageForLeave(leaveId) {
  pokeMassageNotify({ type: 'leave_reminder', leave_id: leaveId })
}

/** 一期的完整資料：這一期 + 所有報名（含已取消的） */
export async function fetchSessionBundle(sessionId) {
  const [{ data: session }, { data: signups }] = await Promise.all([
    supabase.from('massage_sessions').select('*').eq('id', sessionId).maybeSingle(),
    supabase.from('massage_signups').select(SIGNUP_SELECT).eq('session_id', sessionId),
  ])
  return { session, signups: signups || [] }
}

/** 還在的報名（沒取消的） */
export function activeSignups(signups) {
  return signups.filter(s => !s.released_at)
}

/** 依抽籤名次排好的候補（還沒拿到時段的） */
export function waitlistOf(signups) {
  return activeSignups(signups)
    .filter(s => s.result === 'waitlist' && s.slot_no == null)
    .sort((a, b) => a.draw_rank - b.draw_rank)
}

/** 第 n 個時段現在是誰（沒有就 undefined） */
export function holderOf(signups, n) {
  return activeSignups(signups).find(s => s.slot_no === n)
}

/** 誰手上有第 n 個時段的邀請（還沒回覆的） */
export function pendingOfferFor(signups, n) {
  return activeSignups(signups).find(s => s.offer_status === 'pending' && s.offer_slot_no === n)
}

export async function fetchOwnerName() {
  const { data } = await supabase
    .from('massage_settings')
    .select('owner_id, owner:users!massage_settings_owner_id_fkey(full_name)')
    .maybeSingle()
  return data?.owner?.full_name || null
}
