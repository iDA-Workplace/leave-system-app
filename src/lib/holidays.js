import { supabase } from './supabase'

/**
 * 國定假日（2026-11 第 2 階段第 3 步）。
 *
 * 公司不補班，所以「上班日」= 週一～週五，而且不在 holidays 資料表裡（is_holiday = true）。
 * holidays 只記平日的假日，一年十幾筆，登入時整份讀進來放在這裡，
 * 之後算天數都是同步的（countWorkdays 不用改成 async）。
 *
 * App.jsx 會在讀使用者資料的同時呼叫 loadHolidays()，等兩個都好了才顯示畫面，
 * 所以頁面上算天數的時候假日一定已經讀好。讀失敗就當作沒有假日（只扣週末），
 * 不會擋住整個網站；資料庫那邊的特休計算與「不能整張落在假日」的檢查照樣會生效。
 */

let holidays = new Set()
let pending = null

export function loadHolidays({ force = false } = {}) {
  if (pending && !force) return pending
  pending = (async () => {
    const { data, error } = await supabase.from('holidays').select('date').eq('is_holiday', true)
    if (error) { console.error('讀取國定假日失敗：', error.message); holidays = new Set(); return holidays }
    holidays = new Set((data || []).map(r => r.date))
    return holidays
  })()
  return pending
}

/** 目前讀到的假日（Set<'YYYY-MM-DD'>） */
export function getHolidays() {
  return holidays
}

const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** 這一天要不要上班：週一～週五而且不是國定假日。日期一律用 'YYYY-MM-DD' 字串、UTC 算，避免時區差一天。 */
export function isWorkday(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && !holidays.has(date)
}

/** 起訖日期之間的上班日天數（含頭尾）。 */
export function countWorkdays(startDate, endDate) {
  if (!startDate) return 0
  let count = 0
  const d = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`)
  const last = new Date(`${String(endDate || startDate).slice(0, 10)}T00:00:00Z`)
  while (d <= last) {
    if (isWorkday(ymd(d))) count++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return count
}

/** 這段日期裡碰到的國定假日（給畫面提示用） */
export function holidaysBetween(startDate, endDate) {
  if (!startDate) return []
  return [...holidays].filter(h => h >= startDate && h <= (endDate || startDate)).sort()
}
