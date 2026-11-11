// 請假統計（大數據總表）的計算。純函式、不碰資料庫，方便單獨測試，
// HR 的「匯出報表」與之後主管的「團隊請假統計」共用同一份。
//
// 規則（使用者決定，2026-11）：
//   · 只算「已核准」的假單
//   · 離職（停用）的同仁不列入
//   · WFH 另外統計，不算進請假天數
//   · 跨月的假單：每一天算在它所在的月份；查詢期間外的天數不算
//   · 一天 = 8 小時；跨日假單算週一～週五（之後加國定假日設定時，從 holidays 參數排除）

export const HOURS_PER_DAY = 8

const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** 起訖日期之間的每一天（含頭尾），用 UTC 算，避免時區讓日期錯一天 */
export function eachDate(start, end) {
  const out = []
  const d = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (d <= last) {
    out.push(ymd(d))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export function isWorkday(date, holidays) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && !(holidays && holidays.has(date))
}

/**
 * 一張假單拆成「哪一天、幾天」。
 *   · 有填時數（單日假單）→ 時數 ÷ 8，平均分到範圍內的工作天
 *   · 沒填時數（跨日假單）→ 每個工作天算 1 天
 */
export function leaveDayParts(leave, holidays) {
  const dates = eachDate(leave.start_date, leave.end_date || leave.start_date)
  const work = dates.filter(d => isWorkday(d, holidays))
  if (leave.hours != null) {
    const total = Number(leave.hours) / HOURS_PER_DAY
    const on = work.length ? work : [leave.start_date]
    return on.map(date => ({ date, days: total / on.length }))
  }
  return work.map(date => ({ date, days: 1 }))
}

/** 期間內有哪些月份（'YYYY-MM'，依序） */
export function monthsBetween(start, end) {
  const out = []
  let [y, m] = start.slice(0, 7).split('-').map(Number)
  const [ey, em] = end.slice(0, 7).split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}`)
    m += 1
    if (m === 13) { m = 1; y += 1 }
  }
  return out
}

const round1 = n => Math.round(n * 10) / 10

/**
 * @param leaves  已核准的假單，含 requester_id、proxy_user_id、registered_by、disputed_at、
 *                hours、start_date、end_date、leave_type（id、name、name_en、is_wfh）
 * @param users   在職同仁（id、full_name、department）—— 統計的母體；不在這裡面的人的假單不算
 * @param annual  今年特休：[{ user_id, entitled, used }]（天）
 * @param holidays Set<'YYYY-MM-DD'>（目前還沒有國定假日設定，傳空的）
 */
export function computeLeaveStats({ leaves, users, start, end, annual = [], holidays = new Set() }) {
  const people = new Map(users.map(u => [u.id, u]))
  const months = monthsBetween(start, end)
  const monthCount = Math.max(1, months.length)

  const person = new Map(users.map(u => [u.id, {
    user: u, count: 0, days: 0, byType: {}, byMonth: Object.fromEntries(months.map(m => [m, 0])), wfhDays: 0, wfhCount: 0,
    hrRegistered: 0, disputed: 0, proxyCount: 0, proxyDays: 0,
  }]))
  const types = new Map()
  const byMonth = new Map(months.map(m => [m, { month: m, days: 0, wfhDays: 0 }]))
  let totalDays = 0
  let leaveCount = 0
  let wfhDays = 0

  for (const lr of leaves) {
    if (lr.status && lr.status !== 'approved') continue
    const p = person.get(lr.requester_id)
    if (!p) continue   // 離職或不在這次統計範圍的人
    const parts = leaveDayParts(lr, holidays).filter(x => x.date >= start && x.date <= end)
    if (parts.length === 0) continue
    const days = parts.reduce((s, x) => s + x.days, 0)
    const isWfh = !!lr.leave_type?.is_wfh

    if (lr.registered_by) p.hrRegistered += 1
    if (lr.disputed_at) p.disputed += 1

    if (isWfh) {
      p.wfhDays += days
      p.wfhCount += 1
      wfhDays += days
      for (const x of parts) byMonth.get(x.date.slice(0, 7)).wfhDays += x.days
      continue
    }

    p.count += 1
    p.days += days
    const typeId = lr.leave_type?.id ?? 'unknown'
    p.byType[typeId] = (p.byType[typeId] ?? 0) + days
    if (!types.has(typeId)) types.set(typeId, { type: lr.leave_type ?? null, count: 0, days: 0 })
    const ty = types.get(typeId)
    ty.count += 1
    ty.days += days
    for (const x of parts) {
      byMonth.get(x.date.slice(0, 7)).days += x.days
      p.byMonth[x.date.slice(0, 7)] += x.days
    }
    totalDays += days
    leaveCount += 1

    // 職務代理人：代理的人也要在統計母體裡（在職）
    const proxy = lr.proxy_user_id && person.get(lr.proxy_user_id)
    if (proxy) { proxy.proxyCount += 1; proxy.proxyDays += days }
  }

  const headcount = users.length
  const perPerson = [...person.values()].map(p => ({
    ...p,
    days: round1(p.days),
    wfhDays: round1(p.wfhDays),
    proxyDays: round1(p.proxyDays),
    perMonth: round1(p.count / monthCount),
    byType: Object.fromEntries(Object.entries(p.byType).map(([k, v]) => [k, round1(v)])),
    byMonth: months.map(m => ({ month: m, days: round1(p.byMonth[m]) })),
  })).sort((a, b) => b.days - a.days || (a.user.full_name || '').localeCompare(b.user.full_name || ''))

  const byType = [...types.entries()].map(([id, ty]) => ({
    id, type: ty.type, count: ty.count, days: round1(ty.days),
    share: totalDays ? ty.days / totalDays : 0,
  })).sort((a, b) => b.days - a.days)

  const depts = new Map()
  for (const p of person.values()) {
    const key = p.user.department || ''
    if (!depts.has(key)) depts.set(key, { department: key, headcount: 0, days: 0, count: 0 })
    const d = depts.get(key)
    d.headcount += 1
    d.days += p.days
    d.count += p.count
  }
  const byDepartment = [...depts.values()].map(d => ({
    ...d, days: round1(d.days), avg: round1(d.headcount ? d.days / d.headcount : 0),
  })).sort((a, b) => b.avg - a.avg)

  const proxies = perPerson.filter(p => p.proxyCount > 0)
    .map(p => ({ user: p.user, count: p.proxyCount, days: p.proxyDays }))
    .sort((a, b) => b.count - a.count || b.days - a.days)

  const annualRows = annual.filter(a => people.has(a.user_id)).map(a => {
    const entitled = Number(a.entitled) || 0
    const used = Number(a.used) || 0
    return {
      user: people.get(a.user_id), entitled: round1(entitled), used: round1(used),
      remaining: round1(entitled - used), rate: entitled ? used / entitled : null,
    }
  }).sort((a, b) => b.remaining - a.remaining)

  return {
    overview: {
      totalDays: round1(totalDays), leaveCount, wfhDays: round1(wfhDays), headcount,
      avgPerPerson: round1(headcount ? totalDays / headcount : 0),
      peopleWithLeave: perPerson.filter(p => p.count > 0).length,
    },
    perPerson,
    byType,
    byMonth: [...byMonth.values()].map(m => ({ ...m, days: round1(m.days), wfhDays: round1(m.wfhDays) })),
    byDepartment,
    proxies,
    annual: annualRows,
    typeColumns: byType.map(t => ({ id: t.id, type: t.type })),
  }
}
