import { supabase } from './supabase'

// The app has always treated a full leave day as 8 hours (LeaveForm records
// same-day leave in hours; multi-day leave is counted as workdays x 8), so
// quotas are stored in hours and only converted for display.
export const HOURS_PER_DAY = 8

export function isAnnualLeaveType(leaveType) {
  return !!leaveType?.name?.includes('特休')
}

// 假別名稱存在資料庫裡，沒辦法寫進前端字典，所以 leave_types 多了一個
// name_en 欄位（見 migration 20260817）。切成英文但還沒填英文名的假別，
// 沿用中文名 —— 寧可中英夾雜，也不要在畫面上留一片空白。
export function leaveTypeName(leaveType, lang) {
  if (!leaveType) return ''
  if (lang === 'en' && leaveType.name_en) return leaveType.name_en
  return leaveType.name || ''
}

// lib 裡拿不到 useLanguage()，所以錯誤帶著 i18n key 往外丟，由畫面那一層翻譯。
export class LocalizedError extends Error {
  constructor(i18nKey, i18nParams) {
    super(i18nKey)
    this.i18nKey = i18nKey
    this.i18nParams = i18nParams
  }
}

export function errorText(err, t) {
  if (err?.i18nKey) return t(err.i18nKey, err.i18nParams)
  return err?.message || ''
}

// Per-employee agreed quotas, set by 財務 in 員工假期管理. Returns a map of
// leave_type_id -> quota in hours, containing ONLY the leave types that were
// explicitly switched to 手動調整; anything absent falls back to the company
// default (比照勞基法). RLS lets each employee read their own rows.
export async function fetchEntitlementOverrides(userId) {
  if (!userId) return {}
  const { data } = await supabase
    .from('user_leave_entitlements')
    .select('leave_type_id, mode, quota_hours')
    .eq('user_id', userId)
    .eq('mode', 'manual')

  const map = {}
  for (const row of data || []) {
    if (row.quota_hours != null) map[row.leave_type_id] = Number(row.quota_hours)
  }
  return map
}

// Shared by 假單管理 and 請假申請, which show the identical balance panel.
// `annualLeave` is the annual_leave_summary row (in DAYS); everything else
// comes from leave_types.annual_quota_hours (in HOURS). A manual override
// replaces whichever of those two would otherwise apply.
export function buildBalanceRows({ leaveTypes, leaveStats, annualLeave, overrides = {} }) {
  return (leaveTypes || []).map(lt => {
    const override = overrides[lt.id]

    if (isAnnualLeaveType(lt)) {
      return {
        id: lt.id,
        name: lt.name,
        name_en: lt.name_en,
        color: lt.color,
        used: (annualLeave?.used || 0) * HOURS_PER_DAY,
        total: override != null ? override : (annualLeave?.entitled || 0) * HOURS_PER_DAY,
      }
    }

    // leaveStats 一律用中文名當 key（資料庫裡的原名），翻譯只發生在畫面上，
    // 這樣切語言不會讓已用時數對不上。
    const stat = (leaveStats || []).find(s => s.name === lt.name)
    return {
      id: lt.id,
      name: lt.name,
      name_en: lt.name_en,
      color: lt.color,
      used: stat?.totalHours || 0,
      total: override != null ? override : (lt.annual_quota_hours ?? null),
    }
  })
}

// ===== 請假時數計算 =====
// 原本只長在 LeaveForm.jsx 裡，但送出時的額度檢查、以及 Slack 版送單都要用
// 同一套算法，所以搬到這裡共用 —— 兩邊各算各的遲早會算出不一樣的數字。

/** 單日請假的時數，扣掉 12:00–13:00 午休。 */
export function calcHours(start, end) {
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return 0
  let total = endMin - startMin
  const lunchStart = 12 * 60
  const lunchEnd = 13 * 60
  const overlapStart = Math.max(startMin, lunchStart)
  const overlapEnd = Math.min(endMin, lunchEnd)
  if (overlapEnd > overlapStart) total -= (overlapEnd - overlapStart)
  return Math.max(0, total / 60)
}

/** 跨日請假的工作天數（不含週六日）。 */
export function countWorkdays(startDate, endDate) {
  let count = 0
  const current = new Date(startDate)
  const end = new Date(endDate)
  while (current <= end) {
    const day = current.getDay()
    if (day !== 0 && day !== 6) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

/** 一張假單佔用的時數：跨日的算工作天 x 8，單日的用 hours 欄位。 */
export function leaveRequestHours(leave) {
  if (leave.hours != null) return Number(leave.hours)
  return countWorkdays(leave.start_date, leave.end_date) * HOURS_PER_DAY
}

// ===== 送出假單時的額度檢查 =====

/**
 * 算某位員工今年在某個假別上「已經佔掉」的時數。
 *
 * 刻意把 pending 也算進去：只算 approved 的話，同一個人可以連送好幾張各自
 * 都剛好卡在額度內的假單 —— 每一張送出的當下檢查都會過（前面幾張還在審核中
 * 不列入計算），等全部被核准就直接超額。被駁回或收回的假單狀態不是 pending，
 * 時數會自動回到可用額度，行為是合理的。
 */
export async function fetchUsedHours(userId, leaveTypeId) {
  const year = new Date().getFullYear()
  const { data, error } = await supabase
    .from('leave_requests')
    .select('hours, start_date, end_date')
    .eq('requester_id', userId)
    .eq('leave_type_id', leaveTypeId)
    .in('status', ['approved', 'pending'])
    .gte('start_date', `${year}-01-01`)
    .lte('start_date', `${year}-12-31`)
  if (error) throw new LocalizedError('quota_read_used_failed', { msg: error.message })
  return (data || []).reduce((sum, row) => sum + leaveRequestHours(row), 0)
}

/**
 * 這位員工這個假別的年度額度（小時）。回傳 null 代表「沒有設上限」。
 *
 * 優先序：財務的個人設定（手動調整）> 假別本身的公司預設。
 * 特休的公司預設存在 annual_leave_summary（以「天」為單位、依年資計算），
 * 跟其他假別存在 leave_types.annual_quota_hours 不一樣，所以要分開處理。
 */
export async function fetchQuotaHours(userId, leaveType) {
  const overrides = await fetchEntitlementOverrides(userId)
  const override = overrides[leaveType.id]
  if (override != null) return override

  if (isAnnualLeaveType(leaveType)) {
    const { data } = await supabase
      .from('annual_leave_summary').select('entitled_days').eq('user_id', userId).single()
    if (!data || data.entitled_days == null) return null
    return Number(data.entitled_days) * HOURS_PER_DAY
  }

  return leaveType.annual_quota_hours ?? null
}

/**
 * 送出假單前的額度檢查。
 *
 * 回傳 { ok: true } 或 { ok: false, i18nKey, i18nParams } —— 訊息由畫面那一層
 * 用 t(i18nKey, i18nParams) 翻譯。沒有設額度的假別一律放行（額度欄位空白 =
 * 無上限），只有財務有設額度、或有個人專屬設定的假別才擋。
 */
export async function checkQuota({ userId, leaveType, requestedHours, lang }) {
  const quota = await fetchQuotaHours(userId, leaveType)
  if (quota == null) return { ok: true }

  const used = await fetchUsedHours(userId, leaveType.id)
  const remaining = quota - used
  if (requestedHours <= remaining) return { ok: true }

  const fmt = h => (Number.isInteger(h) ? h : h.toFixed(1))
  return {
    ok: false,
    i18nKey: 'quota_exceeded',
    i18nParams: {
      type: leaveTypeName(leaveType, lang),
      requested: fmt(requestedHours),
      remaining: fmt(Math.max(0, remaining)),
      quota: fmt(quota),
      used: fmt(used),
    },
  }
}

// The homepage shows 特休 in days rather than as a full balance table, so it
// needs the override resolved back into days on its own.
export async function fetchAnnualLeaveDays(userId) {
  const [summaryRes, typesRes] = await Promise.all([
    supabase.from('annual_leave_summary').select('*').eq('user_id', userId).single(),
    supabase.from('leave_types').select('id, name'),
  ])

  const summary = summaryRes.data
  if (!summary) return null

  let entitled = summary.entitled_days || 0
  const annualType = (typesRes.data || []).find(isAnnualLeaveType)
  if (annualType) {
    const overrides = await fetchEntitlementOverrides(userId)
    const override = overrides[annualType.id]
    if (override != null) entitled = override / HOURS_PER_DAY
  }

  const used = summary.used_days || 0
  return { entitled, used, remaining: entitled - used }
}
