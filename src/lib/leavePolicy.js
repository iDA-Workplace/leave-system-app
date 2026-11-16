/**
 * 開放請假的第一天（2026-11 使用者決定）。
 *
 * 請假紀錄要以「整個年度」統計，系統從 2027 年度正式啟用：開始日期在這之前的假，
 * 不管是同仁自己請、HR 代登記或 HR 改日期，一律不能送出（2026 年的假之後也不能補請）。
 * 資料庫也會擋（migration 20261120_leave_from_2027.sql），這裡是先給清楚的訊息。
 * 改這個日期的話，那支 migration 與 slack-interactions 的 LEAVE_OPEN_FROM 也要一起改。
 */
export const LEAVE_OPEN_FROM = '2027-01-01'

/** 這個開始日期能不能請（日期字串 YYYY-MM-DD）。 */
export function isBeforeLeaveOpen(startDate) {
  return !!startDate && startDate < LEAVE_OPEN_FROM
}
