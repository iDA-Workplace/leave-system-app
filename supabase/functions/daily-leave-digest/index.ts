// 每日請假公告：每天上午 9 點（台北時間）把「今天有誰請假」發到公開頻道，
// 用來取代目前的 Outlook calendar 公告。
//
// 沒有人請假的日子就安靜跳過，不發任何訊息。
//
// 排程方式見 supabase/functions/README.md（用 pg_cron + pg_net 定時打這支）。
// 這支 function 不看系統時間決定「要不要發」—— 被呼叫就發，時間點交給排程
// 決定，這樣手動觸發補發也才有用。

import {
  adminClient, digestLine, groupBySlot, taipeiToday, LEAVE_SELECT, type LeaveRow,
} from '../_shared/leave.ts'
import { postToChannel, section, contextLine, requireEnv } from '../_shared/slack.ts'

Deno.serve(async () => {
  try {
    const db = adminClient()
    const today = taipeiToday()

    // 涵蓋今天的所有已核准假單：開始日在今天或更早，結束日在今天或更晚。
    // （表單強制要填 end_date，單日假的 end_date 會等於 start_date，
    //   所以這個範圍條件對單日與多日都成立。）
    const { data, error } = await db
      .from('leave_requests')
      .select(LEAVE_SELECT)
      .eq('status', 'approved')
      .lte('start_date', today)
      .gte('end_date', today)
    if (error) throw new Error(`讀取假單失敗：${error.message}`)

    const leaves = (data ?? []) as LeaveRow[]
    if (leaves.length === 0) {
      return new Response(JSON.stringify({ date: today, count: 0, posted: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 分成全天／上午／下午三組 —— 大家真正想知道的是「這個人現在找不找得到」，
    // 全部擠成一串會看不出誰是整天不在、誰只是半天。
    const { fullDay, morning, afternoon } = groupBySlot(leaves)

    const d = new Date(today)
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()]
    const heading = `:palm_tree: *${d.getUTCMonth() + 1}/${d.getUTCDate()}（${weekday}）今日請假名單*`

    const groups: [string, LeaveRow[]][] = [
      ['全天', fullDay], ['上午', morning], ['下午', afternoon],
    ]
    const blocks: unknown[] = [section(heading)]
    for (const [label, rows] of groups) {
      if (rows.length === 0) continue   // 空的組別整段不顯示
      blocks.push(section(`*■ ${label}*\n${rows.map(digestLine).join('\n')}`))
    }
    blocks.push(contextLine('由請假系統自動發送。完整行事曆請見系統首頁。'))

    await postToChannel(
      requireEnv('SLACK_LEAVE_CHANNEL'),
      `今日請假名單（共 ${leaves.length} 筆）`,
      blocks,
    )

    return new Response(JSON.stringify({ date: today, count: leaves.length, posted: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
