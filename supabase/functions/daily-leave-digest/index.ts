// 請假公告，一支 function 兩個時段：
//
//   · 當天上午 9:00 —— 「今天有誰請假」（scope=today，預設）
//   · 前一天下午 4:00 —— 「下個上班日有誰請假」的預告（scope=next）
//
// 兩則刻意共用同一支：內容組法完全一樣，只差在查哪一天、標題怎麼寫、
// 以及沒人請假時要不要出聲。複製成兩支遲早會改到不一致。
//
// 兩則都是「沒有人請假也要發一則」—— 每天固定有訊息，看到的人才分得出
// 「今天真的沒人請假」和「排程壞了沒發出來」。安靜跳過的話，沒收到訊息的
// 那天永遠沒辦法判斷是哪一種。
//
// 「下個上班日」會跳過週末：週一到週四發的是明天，週五發的是下週一。
// 週五下班前預告「明天（週六）」沒有意義。
//
// 下午 4:00 之後才送出並核准的隔日假單，這則預告不會有他 —— 但隔天 9:00
// 那則會有，因為那是重新查一次資料庫，不是把預告存起來重發。
//
// 排程方式見 supabase/functions/README.md（用 pg_cron + pg_net 定時打這支）。
// 這支不看系統時間決定「要不要發」—— 被呼叫就發，時間點交給排程決定，
// 這樣手動觸發補發才有用。
//
// 語言：這是發到「公開頻道」的公告，不是私訊給某個人，沒有單一收件人可以
// 決定語言，只能固定一種 —— 用環境變數 SLACK_CHANNEL_LANGUAGE 決定，
// 沒設定就維持原本全部中文的行為。

import {
  adminClient, digestLine, groupBySlot, taipeiToday, nextWorkday,
  LEAVE_SELECT, type LeaveRow,
} from '../_shared/leave.ts'
import { postToChannel, section, contextLine, requireEnv } from '../_shared/slack.ts'
import { normalizeLang, t, weekdayKey, type Lang, type MsgKey } from '../_shared/i18n.ts'

function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
}

/** 日期字串轉成標題要用的 {month}/{day}/{weekday} 三個值。 */
function dateParams(lang: Lang, date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: t(lang, weekdayKey(d.getUTCDay())),
  }
}

/** 兩個日期是不是差剛好一天（決定標題要說「明天」還是「下個上班日」）。 */
function isTomorrow(from: string, target: string): boolean {
  const d = new Date(`${from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10) === target
}

Deno.serve(async req => {
  try {
    const db = adminClient()
    const lang = channelLang()

    // scope=next → 前一天下午的預告；沒帶或帶別的值 → 維持原本的「今天」。
    // 用查詢字串而不是 request body：pg_cron 那邊 net.http_post 只要改網址，
    // 不必再組 JSON，出錯的機會少一點。
    const scope = new URL(req.url).searchParams.get('scope') === 'next' ? 'next' : 'today'
    const today = taipeiToday()
    const target = scope === 'next' ? nextWorkday(today) : today
    const tomorrow = scope === 'next' && isTomorrow(today, target)
    const params = dateParams(lang, target)

    // 涵蓋目標日的所有已核准假單：開始日在當天或更早，結束日在當天或更晚。
    // （表單強制要填 end_date，單日假的 end_date 會等於 start_date，
    //   所以這個範圍條件對單日與多日都成立。）
    const { data, error } = await db
      .from('leave_requests')
      .select(LEAVE_SELECT)
      .eq('status', 'approved')
      .lte('start_date', target)
      .gte('end_date', target)
    if (error) throw new Error(`讀取假單失敗：${error.message}`)

    const leaves = (data ?? []) as LeaveRow[]

    // 分成全天／上午／下午三組 —— 大家真正想知道的是「這個人現在找不找得到」，
    // 全部擠成一串會看不出誰是整天不在、誰只是半天。在家工作再獨立成第四組。
    const { fullDay, morning, afternoon, wfh } = groupBySlot(leaves)

    // 「有幾個人請假」不能把在家工作的人算進去 —— 他們有在上班。這個數字會
    // 出現在手機通知列那一行，算錯會讓人以為今天很多人不在。
    const leaveCount = leaves.length - wfh.length

    if (leaveCount === 0 && wfh.length === 0) {
      const emptyKey: MsgKey = scope === 'today'
        ? 'digest_empty'
        : (tomorrow ? 'preview_empty_tomorrow' : 'preview_empty_nextday')
      const line = t(lang, emptyKey, params)
      await postToChannel(requireEnv('SLACK_LEAVE_CHANNEL'), line, [
        section(line),
        contextLine(t(lang, scope === 'today' ? 'digest_footer' : 'preview_footer')),
      ])
      return json({ scope, date: target, count: 0, posted: true })
    }

    // 只有在家工作、沒有人請假時，標題改用「今天沒有人請假」那句 ——
    // 底下只掛著一段「在家工作」，標題卻寫「請假名單」會前後矛盾。
    const headingKey: MsgKey = leaveCount === 0
      ? (scope === 'today'
          ? 'digest_empty'
          : (tomorrow ? 'preview_empty_tomorrow' : 'preview_empty_nextday'))
      : (scope === 'today'
          ? 'digest_heading'
          : (tomorrow ? 'preview_heading_tomorrow' : 'preview_heading_nextday'))

    const groups: [string, LeaveRow[]][] = [
      [t(lang, 'digest_group_fullday'), fullDay],
      [t(lang, 'digest_group_morning'), morning],
      [t(lang, 'digest_group_afternoon'), afternoon],
      // 在家工作放最後，而且獨立成一段 —— 這些人有在工作，只是不在辦公室，
      // 跟上面三組「找不到人」的性質不同，混在一起會讓同事誤判。
      [t(lang, 'digest_group_wfh'), wfh],
    ]
    const blocks: unknown[] = [section(t(lang, headingKey, params))]
    for (const [label, rows] of groups) {
      if (rows.length === 0) continue   // 空的組別整段不顯示
      blocks.push(section(t(lang, 'digest_group_heading', { label, lines: rows.map(l => digestLine(l, lang)).join('\n') })))
    }
    blocks.push(contextLine(t(lang, scope === 'today' ? 'digest_footer' : 'preview_footer')))

    // 摘要文字是手機通知列上看到的那一行，週五那則不能寫「明天」
    const summaryKey: MsgKey = scope === 'today'
      ? 'digest_summary_text'
      : (tomorrow ? 'preview_summary_text' : 'preview_summary_text_nextday')

    // 只有在家工作、沒有人請假時，手機通知列那行也要跟著改口 ——
    // 寫「今日請假名單（共 0 筆）」既矛盾又沒資訊。
    const summaryText = leaveCount === 0
      ? t(lang, headingKey, params)
      : t(lang, summaryKey, { n: leaveCount })

    await postToChannel(
      requireEnv('SLACK_LEAVE_CHANNEL'),
      summaryText,
      blocks,
    )

    return json({ scope, date: target, count: leaveCount, wfh: wfh.length, posted: true })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
