// 按摩預約的 Slack 通知（主動發出去的那些）。
//
// ⚠️ 跟 slack-interactions 一樣是自給自足的單一檔案（不 import _shared），
// 可以整支貼進 Supabase 網頁編輯器。按摩相關的中英文字串有一部分跟
// slack-interactions 重複（時間格式、「請釋出名額」提醒），改文字時兩邊都要改。
//
// ── 誰會呼叫這支 ─────────────────────────────────────────────────
// 1. 排程（pg_cron）每分鐘一次 —— 主要的觸發來源，時間到才做的事也靠它。
// 2. 網頁：每次按摩相關的動作成功之後（lib/massage.js 的 callMassage）。
//    只是「叫它現在跑一次」，讓通知不用等到下一分鐘。
// 3. 網頁：HR 代登記假單之後，帶 { type: 'leave_reminder', leave_id }。
// 4. slack-interactions：在 Slack 上做完按摩相關的動作之後（同 2）。
//
// 不管誰呼叫，做的事都一樣（3 多做一件）。重複呼叫不會重複發：每一筆異動
// 紀錄、每一件「時間到才做的事」都會先在資料庫占住才發
// （見 migration 20261020_massage_slack.sql）。
//
// ── 每次執行做什麼 ───────────────────────────────────────────────
// a. 過期的遞補邀請 → 改問下一位（massage_expire_offers）
// b. 還沒發過通知的異動紀錄，依種類：
//      drawn             → 抽籤結果公告到頻道（SLACK_LEAVE_CHANNEL）
//      draw_result       → 被詢問「要不要讓給候補」的人：私訊，附兩顆按鈕
//      offered           → 被邀請遞補的候補：私訊，附「我要」；同時私訊負責人
//      offer_superseded  → 邀請被負責人改成其他安排：私訊告知
//    其他種類（報名、取消、換時段……）不發通知。
// c. 時間到才做的事：
//      開放報名公告     新的一期還在報名期間 → 公告到頻道，附「報名」按鈕
//      隔天 10:00      有時段、沒取消、還沒標出席的人 → 私訊「有按到嗎？」
//      隔天 12:00      還是沒回覆的 → 整理成一則私訊給負責人
//
// ── 語言 ─────────────────────────────────────────────────────────
// 私訊照收件人自己的 users.language；頻道公告照 SLACK_CHANNEL_LANGUAGE
// （沒設定＝中文），跟請假公告同一套規則。

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SLACK_API = 'https://slack.com/api'

// 隔天幾點問「有按到嗎？」、幾點提醒負責人（台北時間，分鐘數）
const ASK_ATTENDANCE_AT = 10 * 60
const REMIND_OWNER_AT = 12 * 60

type Lang = 'zh' | 'en'
const normalizeLang = (v: string | null | undefined): Lang => (v === 'en' ? 'en' : 'zh')

// ===== 中英文字串 =====

const T = {
  zh: {
    weekdays: '日一二三四五六',
    date: '{m}/{d}（{w}）',
    slot: '時段 {n}（{from}–{to}）',

    open_text: '💆 {title} 開放報名',
    open_heading: '💆 *{title}* 開放報名！',
    open_body: '日期：{date} {from}–{to}\n名額：{n} 位（每人 {len} 分鐘）\n報名截止：{deadline}',
    open_draw_at: '預計抽籤：{time}',
    open_note: '報名人數超過名額時公開抽籤，每個人抽中的機率都一樣。也可以私訊我「按摩」，或到網頁「員工福利」報名。',
    btn_signup: '報名',

    drawn_text: '💆 {title} 抽籤結果',
    drawn_heading: '💆 *{title}* 抽籤結果（{date} {from}–{to}）',
    drawn_lottery: '共 {total} 人報名、名額 {n} 位，公開抽籤結果如下。',
    drawn_no_lottery: '共 {total} 人報名，沒有超過名額，全部錄取，依報名先後排時段。',
    drawn_selected_h: '*正取*',
    drawn_waitlist_h: '*候補*（依順位）',
    drawn_footer: '時段跟會議衝突的話，請自行跟其他同仁協調交換，換好後告訴負責人。無法出席請在 {deadline} 前取消，之後才取消視同未到。',

    yield_text: '💆 要不要把按摩名額讓給候補？',
    yield_heading: '💆 你抽中了 *{title}*（{date}）：{slot}。\n你上一期有按到，這期要不要把名額讓給候補的同仁？（不強制，看你的意願）',
    btn_yield_keep: '不用，我要按',
    btn_yield_give: '讓給候補',
    confirm_yield_title: '讓給候補？',
    confirm_yield_text: '名額會交給候補第一位，讓出之後不能再改回來。',
    confirm_cancel: '先不要',

    offer_text: '💆 按摩有空位，輪到你了',
    offer_heading: '💆 *{title}*（{date}）\n{slot} 有空位，輪到你了！',
    offer_until: '請在 {time} 前按「我要」，逾時會改問下一位候補。',
    offer_no_limit: '按「我要」就是你的。',
    btn_accept: '我要',

    owner_offer_text: '💆 已通知候補遞補',
    owner_offer_heading: '💆 *{title}*（{date}）：系統已通知候補 *{name}* 遞補{slot}。',
    owner_offer_no_slack: '⚠️ {name} 沒有設定 Slack，收不到這則通知，請直接聯絡他。',
    owner_offer_note: '如果當面問比較快，也可以到網頁的現場面板直接「指定遞補」。',

    superseded_text: '💆 遞補邀請已取消',
    superseded_heading: '💆 *{title}*（{date}）{slot}的遞補邀請已取消 —— 負責人已經改成其他安排。',

    ask_text: '💆 昨天的按摩有按到嗎？',
    ask_heading: '💆 昨天（{date}）的 *{title}*，你的{slot}。有按到嗎？',
    ask_note: '有按到請按下面的按鈕；沒按到不用回覆。',
    btn_done: '有按到',

    owner_unmarked_text: '💆 還有人沒回覆是否有按到',
    owner_unmarked_heading: '💆 *{title}*（{date}）還有 {k} 位沒有回覆是否有按到：\n{lines}',
    owner_unmarked_note: '請到網頁「員工福利 → 按摩預約 → 管理」的現場面板標記出席。',

    hit_text: '💆 請釋出按摩名額',
    hit_heading_self: '💆 你剛請的假跟按摩預約撞到了，請把名額釋出給其他同仁：',
    hit_heading_hr: '💆 HR 幫你登記的假跟按摩預約撞到了，請把名額釋出給其他同仁：',
    hit_line_slot: '*{title}*（{date}）{slot}',
    hit_line_waitlist: '*{title}*（{date}）候補中',
    hit_line_signed: '*{title}*（{date}）已報名，等待抽籤',
    btn_release: '釋出名額',
    btn_withdraw: '取消報名',
    confirm_release_title: '釋出名額？',
    confirm_release_text: '名額會交給候補的同仁，釋出之後不能再改回來。超過取消期限才釋出的，會記為未到。',
    confirm_withdraw_title: '取消報名？',
    confirm_withdraw_text: '取消後如果想再報名，會排到最後面。',
  },
  en: {
    weekdays: 'SunMonTueWedThuFriSat',
    date: '{w} {m}/{d}',
    slot: 'slot {n} ({from}–{to})',

    open_text: '💆 {title}: sign-up is open',
    open_heading: '💆 *{title}*: sign-up is open!',
    open_body: 'Date: {date} {from}–{to}\nSpots: {n} ({len} minutes each)\nSign-up deadline: {deadline}',
    open_draw_at: 'Draw scheduled: {time}',
    open_note: 'If more people sign up than there are spots, there is a public draw and everyone has the same chance. You can also DM me "massage" or sign up under Benefits on the website.',
    btn_signup: 'Sign up',

    drawn_text: '💆 {title}: draw results',
    drawn_heading: '💆 *{title}*: draw results ({date} {from}–{to})',
    drawn_lottery: '{total} people signed up for {n} spots. Results of the public draw:',
    drawn_no_lottery: '{total} people signed up, within the {n} spots, so everyone is in. Slots follow sign-up order.',
    drawn_selected_h: '*Confirmed*',
    drawn_waitlist_h: '*Waitlist* (in order)',
    drawn_footer: 'If your slot clashes with a meeting, swap with a colleague and let the organizer know. If you cannot make it, cancel before {deadline}; cancelling after that counts as a no-show.',

    yield_text: '💆 Would you give your massage spot to the waitlist?',
    yield_heading: '💆 You got a spot for *{title}* ({date}): {slot}.\nYou had a massage last time — would you like to give this spot to someone on the waitlist? (Entirely up to you.)',
    btn_yield_keep: 'No, I will go',
    btn_yield_give: 'Give it away',
    confirm_yield_title: 'Give your spot away?',
    confirm_yield_text: 'Your spot goes to the first person on the waitlist. This cannot be undone.',
    confirm_cancel: 'Not now',

    offer_text: '💆 A massage spot opened up for you',
    offer_heading: '💆 *{title}* ({date})\n{slot} is free — it is your turn!',
    offer_until: 'Tap "I want it" before {time}; after that we ask the next person on the waitlist.',
    offer_no_limit: 'Tap "I want it" and it is yours.',
    btn_accept: 'I want it',

    owner_offer_text: '💆 Waitlist offer sent',
    owner_offer_heading: '💆 *{title}* ({date}): the system offered {slot} to *{name}* from the waitlist.',
    owner_offer_no_slack: '⚠️ {name} has no Slack ID set and will not get this message — please contact them directly.',
    owner_offer_note: 'If asking in person is quicker, you can also assign the slot directly in the live panel on the website.',

    superseded_text: '💆 Waitlist offer withdrawn',
    superseded_heading: '💆 *{title}* ({date}): the offer for {slot} was withdrawn — the organizer arranged it differently.',

    ask_text: '💆 Did you get your massage yesterday?',
    ask_heading: '💆 *{title}* yesterday ({date}): your {slot}. Did you get your massage?',
    ask_note: 'If you did, tap the button below. If not, no need to reply.',
    btn_done: 'Yes, I did',

    owner_unmarked_text: '💆 Some people have not confirmed their massage',
    owner_unmarked_heading: '💆 *{title}* ({date}): {k} people have not confirmed whether they got their massage:\n{lines}',
    owner_unmarked_note: 'Please mark attendance in the live panel on the website (Benefits → Massage → Manage).',

    hit_text: '💆 Please release your massage spot',
    hit_heading_self: '💆 The leave you just filed overlaps your massage booking. Please release your spot for others:',
    hit_heading_hr: '💆 The leave HR registered for you overlaps your massage booking. Please release your spot for others:',
    hit_line_slot: '*{title}* ({date}) {slot}',
    hit_line_waitlist: '*{title}* ({date}) on the waitlist',
    hit_line_signed: '*{title}* ({date}) signed up, waiting for the draw',
    btn_release: 'Release spot',
    btn_withdraw: 'Cancel sign-up',
    confirm_release_title: 'Release your spot?',
    confirm_release_text: 'Your spot goes to the waitlist and cannot be taken back. Releasing after the cancellation deadline counts as a no-show.',
    confirm_withdraw_title: 'Cancel your sign-up?',
    confirm_withdraw_text: 'If you sign up again later, you will be placed last.',
  },
} as const

type MsgKey = keyof typeof T['zh']

function t(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  let text: string = T[lang][key] ?? T.zh[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.split(`{${k}}`).join(String(v))
  return text
}

function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
}

// ===== 時間（台灣全年 UTC+8，沒有日光節約） =====

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const fmtMin = (total: number) =>
  `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

interface Session {
  id: string; title: string; session_date: string; start_time: string
  slot_minutes: number; break_minutes: number; slot_count: number
  signup_deadline: string; cancel_deadline: string; draw_scheduled_at: string | null
  drawn_at: string | null; created_at: string
}

function slotRange(s: Session, n: number) {
  const start = toMin(s.start_time) + (n - 1) * (s.slot_minutes + s.break_minutes)
  return { from: fmtMin(start), to: fmtMin(start + s.slot_minutes) }
}
function sessionWindow(s: Session) {
  const start = toMin(s.start_time)
  return { from: fmtMin(start), to: fmtMin(start + s.slot_count * (s.slot_minutes + s.break_minutes)) }
}

/** 現在的台北日期與分鐘數 */
function taipeiNow() {
  const d = new Date(Date.now() + 8 * 3600_000)
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function fmtDate(lang: Lang, date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  const w = lang === 'en'
    ? T.en.weekdays.slice(d.getUTCDay() * 3, d.getUTCDay() * 3 + 3)
    : T.zh.weekdays[d.getUTCDay()]
  return t(lang, 'date', { m: d.getUTCMonth() + 1, d: d.getUTCDate(), w })
}
/** timestamptz → 「10/21（二）12:00」 */
function fmtDateTime(lang: Lang, iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000)
  return `${fmtDate(lang, d.toISOString().slice(0, 10))} ${fmtMin(d.getUTCHours() * 60 + d.getUTCMinutes())}`
}
function slotText(lang: Lang, s: Session, n: number) {
  return t(lang, 'slot', { n, ...slotRange(s, n) })
}

// ===== Slack =====

function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`缺少環境變數 ${name}`)
  return v
}

/** Slack 失敗時照樣回 HTTP 200，錯誤在 body.error。網路錯誤才會丟例外（那種情況下次重試）。 */
async function callSlack(method: string, payload: unknown) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}` },
    body: JSON.stringify(payload),
  })
  const body = await res.json()
  if (!body.ok) console.error(`Slack ${method} 失敗：${body.error}`)
  return body
}

const section = (md: string) => ({ type: 'section', text: { type: 'mrkdwn', text: md } })
const contextLine = (md: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: md }] })
const button = (text: string, action_id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id, value, ...extra })
const confirm = (lang: Lang, title: MsgKey, text: MsgKey, ok: string) => ({
  title: { type: 'plain_text', text: t(lang, title) },
  text: { type: 'mrkdwn', text: t(lang, text) },
  confirm: { type: 'plain_text', text: ok },
  deny: { type: 'plain_text', text: t(lang, 'confirm_cancel') },
})

function dm(slackId: string, text: string, blocks: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackId, text, blocks })
}
function postChannel(text: string, blocks: unknown[]) {
  const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
  if (!channel) { console.error('沒有設定 SLACK_LEAVE_CHANNEL，頻道公告略過'); return null }
  return callSlack('chat.postMessage', { channel, text, blocks })
}

// ===== 資料 =====

interface Person { id: string; full_name: string; slack_user_id: string | null; language: string | null; is_active: boolean | null }

const SESSION_COLS = 'id, title, session_date, start_time, slot_minutes, break_minutes, slot_count, signup_deadline, cancel_deadline, draw_scheduled_at, drawn_at, created_at'

class Ctx {
  sessions = new Map<string, Session>()
  people = new Map<string, Person | null>()
  ownerId: string | null | undefined = undefined
  constructor(public db: SupabaseClient) {}

  async session(id: string): Promise<Session | null> {
    if (!this.sessions.has(id)) {
      const { data } = await this.db.from('massage_sessions').select(SESSION_COLS).eq('id', id).maybeSingle()
      if (data) this.sessions.set(id, normalizeSession(data))
    }
    return this.sessions.get(id) ?? null
  }

  async person(id: string | null): Promise<Person | null> {
    if (!id) return null
    if (!this.people.has(id)) {
      const { data } = await this.db.from('users')
        .select('id, full_name, slack_user_id, language, is_active').eq('id', id).maybeSingle()
      this.people.set(id, data ?? null)
    }
    return this.people.get(id) ?? null
  }

  async owner(): Promise<Person | null> {
    if (this.ownerId === undefined) {
      const { data } = await this.db.from('massage_settings').select('owner_id').maybeSingle()
      this.ownerId = data?.owner_id ?? null
    }
    const p = await this.person(this.ownerId ?? null)
    return p && p.is_active !== false ? p : null
  }
}

function normalizeSession(s: Record<string, any>): Session {
  return { ...s, start_time: String(s.start_time).slice(0, 5) } as Session
}

// ===== 進入點 =====

Deno.serve(async req => {
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } })
    const ctx = new Ctx(db)
    const body = await req.json().catch(() => ({}))
    const summary: Record<string, unknown> = {}

    if (body?.type === 'leave_reminder' && body.leave_id) {
      summary.leave_reminder = await leaveReminder(ctx, req, String(body.leave_id))
    }

    const { error: expireError } = await db.rpc('massage_expire_offers')
    if (expireError) console.error('massage_expire_offers 失敗：', expireError.message)

    summary.events = await processEvents(ctx)
    summary.announced = await announceOpenSessions(ctx)
    summary.asked = await askAttendance(ctx)
    summary.owner_reminded = await remindOwner(ctx)

    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})

// ===== b. 異動紀錄 → 通知 =====

interface MassageEvent {
  id: number; session_id: string | null; signup_id: string | null; user_id: string | null
  actor_id: string | null; event: string; slot_no: number | null; details: Record<string, any>
}

async function processEvents(ctx: Ctx) {
  let handled = 0
  // 一次最多 4 批（200 筆）。正常一分鐘內不會有這麼多；真的有，下一分鐘再接著做。
  for (let round = 0; round < 4; round++) {
    const { data, error } = await ctx.db.rpc('massage_notify_claim', { p_limit: 50 })
    if (error) { console.error('massage_notify_claim 失敗：', error.message); break }
    const events = (data ?? []) as MassageEvent[]
    if (events.length === 0) break
    for (const e of events) {
      try {
        await handleEvent(ctx, e)
      } catch (err) {
        // 沒標記完成 → 5 分鐘後會再拿出來重試（最多 3 次）
        console.error(`通知失敗（event ${e.id} ${e.event}）：`, err)
        continue
      }
      await ctx.db.rpc('massage_notify_done', { p_event_id: e.id })
      handled++
    }
  }
  return handled
}

async function handleEvent(ctx: Ctx, e: MassageEvent) {
  if (!e.session_id) return
  switch (e.event) {
    case 'drawn': return announceDraw(ctx, e)
    case 'draw_result': return e.details?.yield_asked ? askYield(ctx, e) : undefined
    case 'offered': return notifyOffer(ctx, e)
    case 'offer_superseded': return notifySuperseded(ctx, e)
  }
}

async function announceDraw(ctx: Ctx, e: MassageEvent) {
  const s = await ctx.session(e.session_id!)
  if (!s) return
  const lang = channelLang()
  // 用抽籤當下記下的結果（draw_result），不是現在的報名資料 —— 公告的是「抽籤結果」，
  // 這幾秒之間如果有人已經讓出或換時段，那是之後的事
  const { data } = await ctx.db.from('massage_events')
    .select('user_id, slot_no, details').eq('session_id', s.id).eq('event', 'draw_result')
  const rows = (data ?? []).sort((a, b) => (a.details?.rank ?? 0) - (b.details?.rank ?? 0))
  const name = async (id: string) => (await ctx.person(id))?.full_name ?? '—'

  // 正取照時段排（大家要找的是「我幾點」），候補照順位
  const selected: { slot: number; line: string }[] = []
  const waitlist: string[] = []
  for (const r of rows) {
    if (r.details?.result === 'selected') {
      const from = r.slot_no ? slotRange(s, r.slot_no).from : '--:--'
      selected.push({ slot: r.slot_no ?? Infinity, line: `\`${from}\` ${await name(r.user_id)}` })
    } else {
      waitlist.push(`${waitlist.length + 1}. ${await name(r.user_id)}`)
    }
  }
  const selectedLines = selected.sort((a, b) => a.slot - b.slot).map(x => x.line)

  const win = sessionWindow(s)
  const blocks: unknown[] = [
    section(t(lang, 'drawn_heading', { title: s.title, date: fmtDate(lang, s.session_date), ...win })),
    section(t(lang, e.details?.was_lottery ? 'drawn_lottery' : 'drawn_no_lottery',
      { total: e.details?.total ?? rows.length, n: s.slot_count })),
    section(`${t(lang, 'drawn_selected_h')}\n${selectedLines.join('\n') || '—'}`),
  ]
  if (waitlist.length) blocks.push(section(`${t(lang, 'drawn_waitlist_h')}\n${waitlist.join('\n')}`))
  blocks.push(contextLine(t(lang, 'drawn_footer', { deadline: fmtDateTime(lang, s.cancel_deadline) })))
  await postChannel(t(lang, 'drawn_text', { title: s.title }), blocks)
}

async function askYield(ctx: Ctx, e: MassageEvent) {
  const s = await ctx.session(e.session_id!)
  const p = await ctx.person(e.user_id)
  if (!s || !p?.slack_user_id || !e.signup_id) return
  // 已經回答過（例如在網頁上）、或已經取消的，不用再問
  const { data: g } = await ctx.db.from('massage_signups')
    .select('slot_no, yield_answer, released_at').eq('id', e.signup_id).maybeSingle()
  if (!g || g.released_at || g.yield_answer || !g.slot_no) return

  const lang = normalizeLang(p.language)
  await dm(p.slack_user_id, t(lang, 'yield_text'), [
    section(t(lang, 'yield_heading', { title: s.title, date: fmtDate(lang, s.session_date), slot: slotText(lang, s, g.slot_no) })),
    {
      type: 'actions',
      elements: [
        button(t(lang, 'btn_yield_keep'), 'massage_yield_keep', e.signup_id),
        button(t(lang, 'btn_yield_give'), 'massage_yield_give', e.signup_id,
          { confirm: confirm(lang, 'confirm_yield_title', 'confirm_yield_text', t(lang, 'btn_yield_give')) }),
      ],
    },
  ])
}

async function notifyOffer(ctx: Ctx, e: MassageEvent) {
  const s = await ctx.session(e.session_id!)
  const p = await ctx.person(e.user_id)
  if (!s || !p || !e.signup_id || !e.slot_no) return
  // 處理到這筆時，邀請可能已經被接受／作廢了（例如網頁上秒按「我要」）——
  // 那就不用再發「輪到你了」
  const { data: g } = await ctx.db.from('massage_signups')
    .select('offer_status, offer_slot_no, offer_expires_at').eq('id', e.signup_id).maybeSingle()
  const stillPending = g?.offer_status === 'pending' && g.offer_slot_no === e.slot_no

  if (stillPending && p.slack_user_id) {
    const lang = normalizeLang(p.language)
    await dm(p.slack_user_id, t(lang, 'offer_text'), [
      section(t(lang, 'offer_heading', { title: s.title, date: fmtDate(lang, s.session_date), slot: slotText(lang, s, e.slot_no) })),
      contextLine(g.offer_expires_at
        ? t(lang, 'offer_until', { time: fmtDateTime(lang, g.offer_expires_at) })
        : t(lang, 'offer_no_limit')),
      { type: 'actions', elements: [button(t(lang, 'btn_accept'), 'massage_accept', e.signup_id, { style: 'primary' })] },
    ])
  }

  // 負責人也同時收到（使用者決定：系統和負責人同時通知）
  const owner = await ctx.owner()
  if (stillPending && owner?.slack_user_id && owner.id !== p.id) {
    const lang = normalizeLang(owner.language)
    const blocks: unknown[] = [
      section(t(lang, 'owner_offer_heading', {
        title: s.title, date: fmtDate(lang, s.session_date), name: p.full_name, slot: slotText(lang, s, e.slot_no),
      })),
    ]
    if (!p.slack_user_id) blocks.push(section(t(lang, 'owner_offer_no_slack', { name: p.full_name })))
    blocks.push(contextLine(t(lang, 'owner_offer_note')))
    await dm(owner.slack_user_id, t(lang, 'owner_offer_text'), blocks)
  }
}

async function notifySuperseded(ctx: Ctx, e: MassageEvent) {
  const s = await ctx.session(e.session_id!)
  const p = await ctx.person(e.user_id)
  if (!s || !p?.slack_user_id || !e.slot_no) return
  const lang = normalizeLang(p.language)
  await dm(p.slack_user_id, t(lang, 'superseded_text'), [
    section(t(lang, 'superseded_heading', { title: s.title, date: fmtDate(lang, s.session_date), slot: slotText(lang, s, e.slot_no) })),
  ])
}

// ===== c. 時間到才做的事 =====

/** 還在報名期間、還沒公告過的期數 → 公告到頻道 */
async function announceOpenSessions(ctx: Ctx) {
  const { data } = await ctx.db.from('massage_sessions').select(SESSION_COLS)
    .is('drawn_at', null).gt('signup_deadline', new Date().toISOString())
  let n = 0
  for (const raw of data ?? []) {
    const s = normalizeSession(raw)
    if (!(await claim(ctx, `announce_open:${s.id}`))) continue
    const lang = channelLang()
    const win = sessionWindow(s)
    const blocks: unknown[] = [
      section(t(lang, 'open_heading', { title: s.title })),
      section(t(lang, 'open_body', {
        date: fmtDate(lang, s.session_date), ...win, n: s.slot_count, len: s.slot_minutes,
        deadline: fmtDateTime(lang, s.signup_deadline),
      }) + (s.draw_scheduled_at ? `\n${t(lang, 'open_draw_at', { time: fmtDateTime(lang, s.draw_scheduled_at) })}` : '')),
      { type: 'actions', elements: [button(t(lang, 'btn_signup'), 'massage_signup', s.id, { style: 'primary' })] },
      contextLine(t(lang, 'open_note')),
    ]
    await postChannel(t(lang, 'open_text', { title: s.title }), blocks)
    n++
  }
  return n
}

/** 昨天那一期：有時段、沒取消、還沒標出席的人 */
async function unmarkedOf(ctx: Ctx, sessionId: string) {
  const { data } = await ctx.db.from('massage_signups')
    .select('id, user_id, slot_no')
    .eq('session_id', sessionId).not('slot_no', 'is', null).is('released_at', null).is('attendance', null)
    .order('slot_no')
  return data ?? []
}

async function yesterdaysSessions(ctx: Ctx) {
  const { date } = taipeiNow()
  const { data } = await ctx.db.from('massage_sessions').select(SESSION_COLS)
    .eq('session_date', addDays(date, -1)).not('drawn_at', 'is', null)
  return (data ?? []).map(normalizeSession)
}

/** 隔天 10:00 起：私訊「有按到嗎？」，只有一顆「有按到」 */
async function askAttendance(ctx: Ctx) {
  if (taipeiNow().minutes < ASK_ATTENDANCE_AT) return 0
  let n = 0
  for (const s of await yesterdaysSessions(ctx)) {
    for (const g of await unmarkedOf(ctx, s.id)) {
      const p = await ctx.person(g.user_id)
      if (!p?.slack_user_id) continue
      if (!(await claim(ctx, `ask_attendance:${g.id}`))) continue
      const lang = normalizeLang(p.language)
      await dm(p.slack_user_id, t(lang, 'ask_text'), [
        section(t(lang, 'ask_heading', { title: s.title, date: fmtDate(lang, s.session_date), slot: slotText(lang, s, g.slot_no) })),
        contextLine(t(lang, 'ask_note')),
        { type: 'actions', elements: [button(t(lang, 'btn_done'), 'massage_done', g.id, { style: 'primary' })] },
      ])
      n++
    }
  }
  return n
}

/** 隔天 12:00 起：還是沒回覆的，整理成一則私訊給負責人 */
async function remindOwner(ctx: Ctx) {
  if (taipeiNow().minutes < REMIND_OWNER_AT) return 0
  const owner = await ctx.owner()
  if (!owner?.slack_user_id) return 0
  let n = 0
  for (const s of await yesterdaysSessions(ctx)) {
    const rows = await unmarkedOf(ctx, s.id)
    if (!(await claim(ctx, `remind_owner:${s.id}`))) continue
    if (rows.length === 0) continue
    const lang = normalizeLang(owner.language)
    const lines: string[] = []
    for (const g of rows) lines.push(`• ${slotText(lang, s, g.slot_no)} ${(await ctx.person(g.user_id))?.full_name ?? '—'}`)
    await dm(owner.slack_user_id, t(lang, 'owner_unmarked_text'), [
      section(t(lang, 'owner_unmarked_heading', { title: s.title, date: fmtDate(lang, s.session_date), k: rows.length, lines: lines.join('\n') })),
      contextLine(t(lang, 'owner_unmarked_note')),
    ])
    n++
  }
  return n
}

async function claim(ctx: Ctx, key: string) {
  const { data, error } = await ctx.db.rpc('massage_job_claim', { p_key: key })
  if (error) { console.error(`massage_job_claim(${key}) 失敗：`, error.message); return false }
  return data === true
}

// ===== 網頁上 HR 代登記假單之後：提醒當事人釋出按摩名額 =====

/**
 * 用「呼叫者自己的身分」查這張假單撞到哪些按摩：資料庫函式只回給本人或
 * 管理者（HR）看，所以別人拿一個假單 id 來打這支，什麼都查不到、也不會
 * 發任何訊息。
 */
async function leaveReminder(ctx: Ctx, req: Request, leaveId: string) {
  const auth = req.headers.get('Authorization')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!auth || !anonKey) return 0
  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, anonKey, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  })
  const { data: hits, error } = await asCaller.rpc('massage_signups_hit_by_leave', { p_leave_id: leaveId })
  if (error || !hits?.length) return 0

  const { data: leave } = await ctx.db.from('leave_requests')
    .select('requester_id, registered_by').eq('id', leaveId).maybeSingle()
  const p = await ctx.person(leave?.requester_id ?? null)
  if (!p?.slack_user_id) return 0
  const lang = normalizeLang(p.language)
  await dm(p.slack_user_id, t(lang, 'hit_text'),
    await leaveHitBlocks(ctx, lang, hits, leave?.registered_by ? 'hit_heading_hr' : 'hit_heading_self'))
  return hits.length
}

/** 「請釋出名額」的訊息內容。slack-interactions 有一份一樣的（Slack 上送假單時用），改的話兩邊都要改。 */
async function leaveHitBlocks(ctx: Ctx, lang: Lang, hits: any[], heading: MsgKey) {
  const blocks: unknown[] = [section(t(lang, heading))]
  for (const h of hits) {
    const s = await ctx.session(h.session_id)
    if (!s) continue
    const date = fmtDate(lang, s.session_date)
    const line = h.slot_no
      ? t(lang, 'hit_line_slot', { title: s.title, date, slot: slotText(lang, s, h.slot_no) })
      : h.drawn
        ? t(lang, 'hit_line_waitlist', { title: s.title, date })
        : t(lang, 'hit_line_signed', { title: s.title, date })
    const btn = h.drawn
      ? button(t(lang, 'btn_release'), 'massage_release', h.signup_id,
        { style: 'danger', confirm: confirm(lang, 'confirm_release_title', 'confirm_release_text', t(lang, 'btn_release')) })
      : button(t(lang, 'btn_withdraw'), 'massage_withdraw', h.signup_id,
        { confirm: confirm(lang, 'confirm_withdraw_title', 'confirm_withdraw_text', t(lang, 'btn_withdraw')) })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line }, accessory: btn })
  }
  return blocks
}
