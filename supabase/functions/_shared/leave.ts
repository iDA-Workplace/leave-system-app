// 請假相關的共用工具：台北時區換算、假單文字描述。
// 兩支 function（事件通知、每日彙整）都要用，所以放這裡，
// 免得「幾點算今天」這種事在兩邊各寫一次然後慢慢長歪。

// 用 esm.sh 而不是 jsr:，因為前者在所有版本的 Supabase Edge Runtime 上都能跑；
// jsr: 只有比較新的 runtime 支援，而這個專案的 runtime 版本無從確認。
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

export const LEAVE_SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name),
  leave_type:leave_types(name)
`

export interface LeaveRow {
  id: string
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
  hours: number | null
  reason: string | null
  status: string
  flow_id: string | null
  current_step: number | null
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null } | null
  proxy?: { full_name: string } | null
  leave_type?: { name: string } | null
}

/** 「8/12 09:00～13:00（4 小時）」或「8/12 ～ 8/15（多日）」 */
export function periodLabel(leave: LeaveRow): string {
  const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  if (leave.end_date && leave.end_date > leave.start_date) {
    return `${short(leave.start_date)} ～ ${short(leave.end_date)}`
  }
  if (leave.start_time && leave.end_time) {
    const hm = (t: string) => t.slice(0, 5)
    return `${short(leave.start_date)} ${hm(leave.start_time)}～${hm(leave.end_time)}`
  }
  return short(leave.start_date)
}

export function durationLabel(leave: LeaveRow): string {
  if (leave.end_date && leave.end_date > leave.start_date) return '整日'
  return leave.hours ? `${leave.hours} 小時` : '整日'
}

/** 一行摘要，彙整訊息與事件通知都用同一種寫法。 */
export function leaveSummary(leave: LeaveRow): string {
  const name = leave.requester?.full_name ?? '（未知人員）'
  const dept = leave.requester?.department ? `（${leave.requester.department}）` : ''
  const type = leave.leave_type?.name ?? '請假'
  return `*${name}*${dept}　${type}　${periodLabel(leave)}　${durationLabel(leave)}`
}

/** 查出某張假單「目前這一關」該簽核的人的 Slack ID。 */
export async function currentApproverSlackIds(db: SupabaseClient, leave: LeaveRow): Promise<string[]> {
  if (!leave.flow_id || !leave.current_step) return []
  const { data, error } = await db
    .from('approval_flow_steps')
    .select('approver:users!approval_flow_steps_approver_id_fkey(slack_user_id)')
    .eq('flow_id', leave.flow_id)
    .eq('step_order', leave.current_step)
  if (error) throw new Error(`讀取簽核關卡失敗：${error.message}`)
  return (data ?? []).map((r: { approver?: { slack_user_id?: string } }) => r.approver?.slack_user_id).filter(Boolean) as string[]
}

/** 管理後台「核准通知對象」裡設定、且仍啟用的人。 */
export async function notificationTargetSlackIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('notification_targets')
    .select('user:users(slack_user_id)')
    .eq('is_active', true)
  if (error) throw new Error(`讀取通知對象失敗：${error.message}`)
  return (data ?? []).map((r: { user?: { slack_user_id?: string } }) => r.user?.slack_user_id).filter(Boolean) as string[]
}
