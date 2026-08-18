import { supabase } from './supabase'

/**
 * 「現在輪到我評分」的唯一判定規則，以及它的計數查詢。
 *
 * 這一份被三個地方共用：
 *   1. 側邊選單「考核管理」上的紅色數字（Layout.jsx）
 *   2. 「團隊管理」分頁上的紅色數字與「待我評分數量」統計格（Review.jsx）
 *   3. 團隊管理清單裡「開始評分」按鈕出不出現（Review.jsx）
 *
 * 刻意抽成一個檔案：各自寫一次的話，遲早會變成側邊選單說有 3 個待辦、
 * 點進去卻只看到 2 個，而且沒人知道哪一邊才是對的。
 */

/**
 * 我擔任評核人的所有簽核關卡。
 * 回傳 flow_id:step_order 的集合（用來比對「這一關是不是我」）與我涉入的流程清單。
 */
export async function fetchMyStepSet(userId) {
  const { data } = await supabase
    .from('review_flow_steps').select('flow_id, step_order').eq('evaluator_id', userId)
  const pairs = data || []
  return {
    myStepSet: new Set(pairs.map(s => `${s.flow_id}:${s.step_order}`)),
    myFlowIds: [...new Set(pairs.map(s => s.flow_id))],
  }
}

/**
 * 已結束的考核週期不算：那種情況「開始評分」按鈕本來就不會出現，
 * 算進待辦只會讓人一直看到一個永遠消不掉的數字。
 */
export function isAwaitingMyScore(participant, myStepSet) {
  return !!(
    participant.self_submitted &&
    !participant.supervisor_submitted &&
    participant.flow_id &&
    participant.review?.status === 'active' &&
    myStepSet.has(`${participant.flow_id}:${participant.current_step}`)
  )
}

/**
 * 徽章用的輕量查詢：只要一個數字，所以不抓簽核鏈與草稿。
 */
export async function fetchAwaitingMyScoreCount(userProfile, isBoss) {
  if (!userProfile?.id) return 0
  const { myStepSet, myFlowIds } = await fetchMyStepSet(userProfile.id)
  if (!isBoss && myFlowIds.length === 0) return 0

  let query = supabase
    .from('annual_review_participants')
    .select('flow_id, current_step, self_submitted, supervisor_submitted, review:annual_reviews(status)')
  if (!isBoss) query = query.in('flow_id', myFlowIds)

  const { data, error } = await query
  if (error) return 0   // 徽章拿不到數字就不顯示，不要因此讓整個頁面壞掉
  return (data || []).filter(p => isAwaitingMyScore(p, myStepSet)).length
}

/**
 * 側邊選單跟考核頁面是兩個各自獨立的元件，中間沒有共同的父層可以放狀態。
 * 主管在考核頁面按下「送出評分」的當下，側邊選單的數字也要跟著少一個，
 * 所以用一個瀏覽器原生的事件當通知管道 —— 比為了一個數字去架 context
 * 或狀態管理套件單純得多，也不會讓兩邊互相 import。
 */
export const REVIEW_TODO_EVENT = 'review-todo-changed'

export function notifyReviewTodoChanged() {
  window.dispatchEvent(new CustomEvent(REVIEW_TODO_EVENT))
}
