// 期間選擇共用（匯出報表、團隊請假統計）

export function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 快速選擇的期間：本月、本季、今年（使用者要求） */
export function quickRange(kind) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  if (kind === 'month') return [toISODate(new Date(y, m, 1)), toISODate(new Date(y, m + 1, 0))]
  if (kind === 'quarter') { const q = Math.floor(m / 3) * 3; return [toISODate(new Date(y, q, 1)), toISODate(new Date(y, q + 3, 0))] }
  return [toISODate(new Date(y, 0, 1)), toISODate(new Date(y, 11, 31))]
}
