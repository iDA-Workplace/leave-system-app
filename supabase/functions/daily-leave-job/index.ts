// 待審假單的每日處理：逾期自動退回 ＋ 提醒還沒簽的主管。
//
// 這支在這個專案之前就存在，跟「每日請假名單」公告完全是兩回事（只是名字
// 相近容易搞混）。原本會查 approval_delegates（代理審核人），但那張表已在
// 20260810_remove_approval_delegates.sql 被整個刪掉，所以一觸發就查詢失敗，
// 等於長期是壞的。這裡是修好並改寫成與其他 function 共用同一套工具的版本。
//
// 商業規則沿用原本的，沒有另外調整：
//   - 待審超過 7 天 → 自動退回，並私訊申請人
//   - 未逾期 → 私訊目前這一關的簽核人提醒（現在附上核准／駁回按鈕）
//
// 2026-09 多了第三件事：HR 代登記的假單過了確認期限還沒被確認的，自動
// 視同確認，並私訊當事人留下紀錄（見 migration 20260915_hr_registered_leave）。
//
// 語言：每則私訊都照收件人（申請人／簽核人）自己 users.language 的設定發。

import {
  adminClient, currentApprovers, leaveDetailLines, LEAVE_SELECT, type LeaveRow,
} from '../_shared/leave.ts'
import { dmMany, dmManyLocalized, section, contextLine } from '../_shared/slack.ts'
import { normalizeLang, t } from '../_shared/i18n.ts'

/** 待審幾天後自動退回。 */
const EXPIRE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

function waitedDays(leave: LeaveRow): number {
  if (!leave.created_at) return 0
  return Math.floor((Date.now() - new Date(leave.created_at).getTime()) / DAY_MS)
}

Deno.serve(async () => {
  try {
    const db = adminClient()
    const cutoff = new Date(Date.now() - EXPIRE_DAYS * DAY_MS).toISOString()

    const { data, error } = await db
      .from('leave_requests').select(LEAVE_SELECT).eq('status', 'pending')
    if (error) throw new Error(`讀取待審假單失敗：${error.message}`)

    const pending = (data ?? []) as unknown as LeaveRow[]
    if (pending.length === 0) {
      return json({ message: 'No pending requests' })
    }

    const toReturn = pending.filter(r => r.created_at && r.created_at <= cutoff)
    const toRemind = pending.filter(r => !r.created_at || r.created_at > cutoff)

    // ── 逾期退回 ──
    for (const leave of toReturn) {
      await db.from('leave_requests').update({
        status: 'returned',
        returned_at: new Date().toISOString(),
        returned_reason: '逾期未審核，系統自動退回',
      }).eq('id', leave.id)

      if (leave.requester?.slack_user_id) {
        const lang = normalizeLang(leave.requester.language)
        await dmMany([leave.requester.slack_user_id], t(lang, 'overdue_text'), [
          section(t(lang, 'overdue_heading', { detail: leaveDetailLines(leave, lang) })),
          contextLine(t(lang, 'overdue_note', { n: EXPIRE_DAYS })),
        ])
      }
    }

    // ── 提醒簽核人 ──
    //
    // 一張假單一則訊息，不是把全部擠成一則清單。因為按下核准／駁回時，
    // 處理端是用 response_url「改寫原本那則訊息」把按鈕換成結果 —— 如果
    // 一則訊息裝了好幾張假單，處理其中一張就會把其他張的按鈕一起蓋掉。
    const remindedIds: string[] = []
    for (const leave of toRemind) {
      if (!leave.flow_id || !leave.current_step) continue

      const recipients = await currentApprovers(db, leave)
      if (recipients.length === 0) continue

      const waited = waitedDays(leave)
      await dmManyLocalized(recipients, (lang) => ({
        text: t(lang, 'reminder_text', { name: leave.requester?.full_name ?? '' }),
        blocks: [
          section(t(lang, 'reminder_heading', { detail: leaveDetailLines(leave, lang) })),
          contextLine(waited === 0 ? t(lang, 'reminder_note_new') : t(lang, 'reminder_note_waited', { n: waited })),
          {
            type: 'actions',
            elements: [
              { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_approve'), emoji: true },
                action_id: 'approve_leave', value: leave.id },
              { type: 'button', style: 'danger', text: { type: 'plain_text', text: t(lang, 'btn_reject'), emoji: true },
                action_id: 'reject_leave', value: leave.id },
            ],
          },
        ],
      }))
      remindedIds.push(leave.id)
    }

    if (remindedIds.length > 0) {
      await db.from('leave_requests')
        .update({ last_reminded_at: new Date().toISOString() })
        .in('id', remindedIds)
    }

    const autoAcked = await autoAcknowledgeExpired(db)

    return json({ returned: toReturn.length, reminded: remindedIds.length, autoAcked })
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, 500)
  }
})

/**
 * HR 代登記、但同仁過了期限還沒確認的假單，自動視同確認。
 *
 * 規則在登記當下就寫在通知裡了（「{日期} 前未提出異議，視同確認」），這裡
 * 只是把它執行掉。auto_acknowledged 設成 true，是為了日後有爭議時分得出
 * 「本人按的」與「逾期自動生效的」—— 兩者的意義完全不同。
 *
 * 一樣會發一則通知，讓當事人知道這件事已經定案，而不是無聲無息地生效。
 * 通知失敗不影響確認本身：假單的狀態才是結算依據，通知只是知會。
 */
async function autoAcknowledgeExpired(db: ReturnType<typeof adminClient>): Promise<number> {
  const { data, error } = await db
    .from('leave_requests')
    .select(LEAVE_SELECT)
    .not('registered_by', 'is', null)
    .is('acknowledged_at', null)
    // 已經提出異議的絕對不能自動確認：同仁明確表示過不同意，再套用「未提出
    // 異議視同確認」在勞資爭議上站不住腳 —— 那句話的前提就是「沒有提出異議」。
    // 這些會一直留著等 HR 處理。
    .is('disputed_at', null)
    .lt('ack_deadline', new Date().toISOString())
  if (error) throw new Error(`讀取待確認假單失敗：${error.message}`)

  const expired = (data ?? []) as unknown as LeaveRow[]
  if (expired.length === 0) return 0

  const { error: updateError } = await db
    .from('leave_requests')
    .update({ acknowledged_at: new Date().toISOString(), auto_acknowledged: true })
    .in('id', expired.map(l => l.id))
  if (updateError) throw new Error(`自動確認失敗：${updateError.message}`)

  for (const leave of expired) {
    const slackId = leave.requester?.slack_user_id
    if (!slackId) continue   // 沒填 Slack ID 的人收不到，但確認本身已經生效
    const lang = normalizeLang(leave.requester?.language)
    await dmManyLocalized([{ slackUserId: slackId, language: lang }], (l) => ({
      text: t(l, 'hrreg_auto_text'),
      blocks: [
        section(t(l, 'hrreg_auto_heading', { detail: leaveDetailLines(leave, l) })),
        contextLine(t(l, 'hrreg_auto_note')),
      ],
    }))
  }

  return expired.length
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}
