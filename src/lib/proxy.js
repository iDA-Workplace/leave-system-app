import { supabase } from './supabase'

/**
 * 職務代理人確認（2026-11）。
 *
 * 同仁送出的假單先由職務代理人確認：同意 → 接著走簽核流程（流程沒有關卡的直接核准）；
 * 不能代理（要寫原因）→ 假單退回給申請人換人。規則在資料庫的 proxy_decide() 裡，
 * 這裡只負責呼叫、通知、告訴畫面上其他地方數字要更新。
 */

/** 待我確認的代理（只有基本資料：誰、什麼假、哪天、幾點、幾小時）。 */
export async function fetchMyProxyRequests() {
  const { data, error } = await supabase.rpc('my_proxy_requests')
  if (error) return []
  return data || []
}

/**
 * 回覆代理。回傳資料庫的結果代碼：
 *   approved / approved_final / returned ＝ 成功；
 *   reason_required / not_proxy / already_handled / not_found / not_signed_in ＝ 沒有改動
 */
export async function decideProxy(requestId, approve, comment = null) {
  const { data, error } = await supabase.rpc('proxy_decide', {
    p_request: requestId, p_approve: approve, p_comment: comment,
  })
  if (error) throw new Error(error.message)
  if (['approved', 'approved_final', 'returned'].includes(data)) {
    // 通知下一步該知道的人（簽核人／已核准／申請人），由後台照假單現在的狀態決定
    supabase.functions.invoke('send-slack-notification', { body: { type: 'proxy_decided', request_id: requestId } })
      .catch(() => {})
    notifyProxyTodoChanged()
  }
  return data
}

/** 鈴鐺、首頁卡片之間同步「待我確認的代理」數字（同 reviewTodo 的做法）。 */
export const PROXY_TODO_EVENT = 'proxy-todo-changed'

export function notifyProxyTodoChanged() {
  window.dispatchEvent(new CustomEvent(PROXY_TODO_EVENT))
}
