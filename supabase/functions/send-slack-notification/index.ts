// 事件通知：由前端在關鍵動作發生後呼叫。
//
//   new_request                 有人送出（或重送）假單 → 私訊目前這一關的簽核人
//   approved                    假單最後一關核准     → 私訊申請人＋通知對象；
//                                                     若假期涵蓋今天則另外公告到頻道
//   rejected                    假單被拒絕           → 私訊申請人
//   self_assessment_submitted   員工送出年度自評     → 私訊目前這一關的評核人
//
// 前面三種的呼叫點在 LeaveForm.jsx / MyLeaves.jsx / Home.jsx，呼叫格式已經
// 存在於前端，這支 function 是照著那個既有的 { type, request_id } 契約寫的。

import {
  adminClient, currentApproverSlackIds, notificationTargetSlackIds,
  leaveSummary, taipeiNow, taipeiToday, DIGEST_HOUR,
  LEAVE_SELECT, type LeaveRow,
} from '../_shared/leave.ts'
import { dmMany, postToChannel, section, contextLine } from '../_shared/slack.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { type, request_id, participant_id } = await req.json()
    const db = adminClient()

    if (type === 'self_assessment_submitted') {
      return json(await notifyReviewEvaluators(db, participant_id))
    }

    if (!request_id) return json({ error: '缺少 request_id' }, 400)

    const { data, error } = await db
      .from('leave_requests').select(LEAVE_SELECT).eq('id', request_id).single()
    if (error) return json({ error: `讀取假單失敗：${error.message}` }, 500)
    const leave = data as unknown as LeaveRow

    switch (type) {
      case 'new_request': return json(await notifyApprovers(db, leave))
      case 'approved':    return json(await notifyApproved(db, leave))
      case 'rejected':    return json(await notifyRejected(db, leave))
      default:            return json({ error: `未知的通知類型：${type}` }, 400)
    }
  } catch (e) {
    // 通知失敗不應該讓使用者的操作看起來像失敗（假單其實已經送出了），
    // 所以錯誤訊息照實回傳讓前端可以記錄，但不丟 500 以外的副作用。
    return json({ error: (e as Error).message }, 500)
  }
})

async function notifyApprovers(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  const slackIds = await currentApproverSlackIds(db, leave)
  if (slackIds.length === 0) return { skipped: '這一關的簽核人沒有設定 Slack ID' }

  const text = `${leave.requester?.full_name ?? ''} 送出了一張待您審核的假單`
  return await dmMany(slackIds, text, [
    section(`:memo: *有一張假單待您審核*\n${leaveSummary(leave)}`),
    ...(leave.reason ? [section(`*事由*\n${leave.reason}`)] : []),
    ...(leave.proxy?.full_name ? [contextLine(`職務代理人：${leave.proxy.full_name}`)] : []),
    contextLine(`請到請假系統的「首頁 → 待審核假單」進行審核。`),
  ])
}

async function notifyApproved(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  const results: Record<string, unknown> = {}

  // 1) 通知申請人本人 ＋ 管理後台設定的「核准通知對象」
  const recipients = [
    ...(leave.requester?.slack_user_id ? [leave.requester.slack_user_id] : []),
    ...(await notificationTargetSlackIds(db)),
  ]
  results.dm = await dmMany(recipients, '您的假單已核准', [
    section(`:white_check_mark: *假單已核准*\n${leaveSummary(leave)}`),
  ])

  // 2) 當天臨時請假的補發公告。
  //
  //    每天 09:00 的彙整只看得到「當下已核准」的假單，所以下午才核准、
  //    而且假期就涵蓋今天的那種臨時假，早上那則公告一定漏掉 —— 這裡補一則。
  //    只在過了彙整時間之後才補發，否則 09:00 前核准的假會被公告兩次。
  const today = taipeiToday()
  const coversToday = leave.start_date <= today && leave.end_date >= today
  const afterDigest = taipeiNow().getUTCHours() >= DIGEST_HOUR

  if (coversToday && afterDigest) {
    const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
    if (!channel) {
      results.channel = '未設定 SLACK_LEAVE_CHANNEL，略過頻道公告'
    } else {
      await postToChannel(channel, `${leave.requester?.full_name ?? ''} 今天請假`, [
        section(`:bell: *今日臨時請假*\n${leaveSummary(leave)}`),
        contextLine('此假單於今日上午的請假公告發出後才核准，故補發通知。'),
      ])
      results.channel = 'posted'
    }
  } else {
    results.channel = coversToday ? '尚未到彙整時間，將由每日公告一併發出' : '假期不含今天，不需公告'
  }

  return results
}

async function notifyRejected(_db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  if (!leave.requester?.slack_user_id) return { skipped: '申請人沒有設定 Slack ID' }
  return await dmMany([leave.requester.slack_user_id], '您的假單已被拒絕', [
    section(`:x: *假單未通過*\n${leaveSummary(leave)}`),
    contextLine('詳細原因請到請假系統的「假單管理」查看。'),
  ])
}

async function notifyReviewEvaluators(db: ReturnType<typeof adminClient>, participantId: string) {
  if (!participantId) return { error: '缺少 participant_id' }

  const { data: p, error } = await db
    .from('annual_review_participants')
    .select(`
      id, flow_id, current_step,
      review:annual_reviews(title, year, evaluation_deadline),
      user:users!annual_review_participants_user_id_fkey(full_name, department)
    `)
    .eq('id', participantId)
    .single()
  if (error) return { error: `讀取考核參與者失敗：${error.message}` }
  if (!p.flow_id) return { skipped: '此員工尚未設定考核流程' }

  const { data: steps, error: stepErr } = await db
    .from('review_flow_steps')
    .select('evaluator:users(slack_user_id)')
    .eq('flow_id', p.flow_id)
    .eq('step_order', p.current_step)
  if (stepErr) return { error: `讀取考核關卡失敗：${stepErr.message}` }

  const slackIds = (steps ?? [])
    .map((s: { evaluator?: { slack_user_id?: string } }) => s.evaluator?.slack_user_id)
    .filter(Boolean) as string[]
  if (slackIds.length === 0) return { skipped: '這一關的評核人沒有設定 Slack ID' }

  const dept = p.user?.department ? `（${p.user.department}）` : ''
  return await dmMany(slackIds, `${p.user?.full_name ?? ''} 已送出年度自評，待您評分`, [
    section(`:clipboard: *有一份年度自評待您評分*\n*${p.user?.full_name ?? ''}*${dept}　${p.review?.title ?? ''}`),
    ...(p.review?.evaluation_deadline ? [contextLine(`評分截止：${p.review.evaluation_deadline}`)] : []),
    contextLine('請到請假系統的「考核管理 → 團隊管理」進行評分。'),
  ])
}
