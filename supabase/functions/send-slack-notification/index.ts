// 事件通知：由前端在關鍵動作發生後呼叫。
//
//   new_request                 有人送出（或重送）假單 → 私訊目前這一關的簽核人
//   approved                    假單最後一關核准     → 私訊申請人＋通知對象；
//                                                     若假期涵蓋今天則另外公告到頻道
//   rejected                    假單被拒絕           → 私訊申請人
//
// 前面三種的呼叫點在 LeaveForm.jsx / MyLeaves.jsx / Home.jsx，呼叫格式已經
// 存在於前端，這支 function 是照著那個既有的 { type, request_id } 契約寫的。
//
// 語言：每一則通知都照「收件人自己」users.language 的設定發，不是看誰觸發
// 動作。核准假單的主管可能是中文介面，但假單是發給可能設定英文的申請人 ——
// 一則訊息只會用收件人自己的語言。頻道公告（今日臨時請假補發）沒有單一收件
// 人，語言固定，見 SLACK_CHANNEL_LANGUAGE（未設定＝中文，行為與改版前一致）。

import {
  adminClient, currentApprovers, notificationTargetRecipients,
  leaveDetailLines, digestLine, taipeiNow, taipeiToday, DIGEST_HOUR,
  LEAVE_SELECT, type LeaveRow, type Recipient,
} from '../_shared/leave.ts'
import { dmMany, dmManyLocalized, postToChannel, section, contextLine } from '../_shared/slack.ts'
import { normalizeLang, t, type Lang } from '../_shared/i18n.ts'

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

/** 公開頻道公告固定用哪個語言：沒設定環境變數就照舊全部中文。 */
function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { type, request_id } = await req.json()
    const db = adminClient()

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
  const recipients = await currentApprovers(db, leave)
  if (recipients.length === 0) return { skipped: '這一關的簽核人沒有設定 Slack ID' }

  return await dmManyLocalized(recipients, (lang) => ({
    text: t(lang, 'new_request_text', { name: leave.requester?.full_name ?? '' }),
    blocks: [
      section(t(lang, 'new_request_heading', { detail: leaveDetailLines(leave, lang) })),
      // 按鈕由 slack-interactions 那支處理（Slack 會把所有互動事件送到 App
      // 設定的同一個 Interactivity Request URL），所以這裡只負責把按鈕畫出來。
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_approve'), emoji: true },
            action_id: 'approve_leave', value: leave.id },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: t(lang, 'btn_reject'), emoji: true },
            action_id: 'reject_leave', value: leave.id },
        ],
      },
      contextLine(t(lang, 'review_on_web_hint')),
    ],
  }))
}

async function notifyApproved(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  const results: Record<string, unknown> = {}

  // 1) 通知申請人本人 ＋ 管理後台設定的「核准通知對象」
  const requesterRecipient: Recipient[] = leave.requester?.slack_user_id
    ? [{ slackUserId: leave.requester.slack_user_id, language: normalizeLang(leave.requester.language) }]
    : []
  const targetRecipients = await notificationTargetRecipients(db)
  const recipients = dedupeRecipients([...requesterRecipient, ...targetRecipients])

  results.dm = await dmManyLocalized(recipients, (lang) => ({
    text: t(lang, 'approved_text'),
    blocks: [section(t(lang, 'approved_heading', { detail: leaveDetailLines(leave, lang) }))],
  }))

  // 職務代理人的通知刻意等到「核准後」才發 —— 假單還沒過就先通知，萬一被
  // 駁回，代理人已經以為要代班了。代理人可能同時是申請人自己選的通知對象，
  // 所以先確認不是重複的人再發。
  results.proxy = await notifyProxy(db, leave, recipients.map(r => r.slackUserId))

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
      const lang = channelLang()
      await postToChannel(channel, t(lang, 'today_leave_text', { name: leave.requester?.full_name ?? '' }), [
        section(t(lang, 'today_leave_heading', { line: digestLine(leave, lang, { markFullDay: true }) })),
        contextLine(t(lang, 'today_leave_note')),
      ])
      results.channel = 'posted'
    }
  } else {
    results.channel = coversToday ? '尚未到彙整時間，將由每日公告一併發出' : '假期不含今天，不需公告'
  }

  return results
}

async function notifyRejected(db: ReturnType<typeof adminClient>, leave: LeaveRow) {
  if (!leave.requester?.slack_user_id) return { skipped: '申請人沒有設定 Slack ID' }
  const lang = normalizeLang(leave.requester.language)

  // 駁回原因存在 leave_approvals，不在假單本身，所以要另外查最後一筆
  const { data: rejection } = await db
    .from('leave_approvals')
    .select('comment')
    .eq('request_id', leave.id).eq('action', 'rejected')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  const extra = rejection?.comment ? [t(lang, 'detail_reject_reason', { reason: rejection.comment })] : []
  return await dmMany([leave.requester.slack_user_id], t(lang, 'rejected_text'), [
    section(t(lang, 'rejected_heading', { detail: leaveDetailLines(leave, lang, extra) })),
    ...(rejection?.comment ? [] : [contextLine(t(lang, 'rejected_detail_hint'))]),
  ])
}

/** 核准後通知職務代理人。回傳說明字串方便從呼叫端的回應看出結果。 */
async function notifyProxy(
  db: ReturnType<typeof adminClient>, leave: LeaveRow, alreadyNotified: string[],
) {
  const { data } = await db
    .from('leave_requests')
    .select('proxy:users!leave_requests_proxy_user_id_fkey(slack_user_id, language)')
    .eq('id', leave.id).maybeSingle()

  const proxy = (data as { proxy?: { slack_user_id?: string; language?: string } } | null)?.proxy
  if (!proxy?.slack_user_id) return '沒有職務代理人或代理人未設定 Slack ID'
  if (alreadyNotified.includes(proxy.slack_user_id)) return '代理人已在其他通知對象中，不重複發送'

  const lang = normalizeLang(proxy.language)
  await dmMany([proxy.slack_user_id], t(lang, 'proxy_text', { name: leave.requester?.full_name ?? '' }), [
    section(t(lang, 'proxy_heading', { detail: leaveDetailLines(leave, lang) })),
    contextLine(t(lang, 'proxy_note')),
  ])
  return 'sent'
}

function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const r of recipients) {
    if (!r.slackUserId || seen.has(r.slackUserId)) continue
    seen.add(r.slackUserId)
    out.push(r)
  }
  return out
}
