// 考核通知（Slack 私訊＋App 推播）。
//
// 使用者 2026-11 決定要通知的三件事：
//
//   invited  被加入考核名單 → 通知本人：請填自評（附自評截止日）
//   turn     同仁送出自評     → 通知流程第 1 關的評核人：輪到你評分
//            前一關評完       → 通知下一關的評核人：輪到你評分
//            （兩種都是「現在輪到這一關」，所以是同一個動作）
//   全部評完不通知（使用者沒有選）。
//
// 網頁在動作成功之後呼叫：
//   { type: 'invited', participant_ids: [...] }   新增考核名單之後
//   { type: 'turn', participant_id }              送出自評之後、評核人送出（不是最後一關）之後
//
// 安全：呼叫的人要登入，但「要不要發、發給誰」完全照資料庫現在的狀態決定，不信任
// 呼叫端傳來的任何東西 —— 傳了一個還沒輪到的人，什麼都不會發。同一件事只會發一次：
// annual_review_participants 的 invite_notified_at／turn_notified_key 記著已經通知過，
// 先搶到記號的那次才發（重複按、重新整理都不會重發）。
//
// 部署：Supabase 主控台 → Edge Functions → 新增 review-notify → 整份貼上 → Deploy，
//       然後在 Details 把「Verify JWT」關掉（這支自己檢查身分）。
//
// 這支刻意整支自給自足、不 import _shared：網頁編輯器只能貼單一檔案。

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

type Lang = 'zh' | 'en'
const normalizeLang = (v: unknown): Lang => (v === 'en' ? 'en' : 'zh')

const MESSAGES = {
  zh: {
    invite_text: '📋 請填寫考核自評：{title}',
    invite_heading: ':clipboard: *你被加入考核：{title}*\n{when}',
    invite_deadline: '請在 *{deadline}* 前到管理系統「考核管理」填寫並送出自評。',
    invite_no_deadline: '請到管理系統「考核管理」填寫並送出自評。',
    turn_text: '📋 {name} 的考核輪到你評分',
    turn_heading: ':clipboard: *輪到你評分了*\n*考核：* {title}\n*同仁：* {name}\n*關卡：* 第 {step} 關{deadline}',
    turn_deadline: '\n*評分截止：* {deadline}',
    turn_note: '請到管理系統「考核管理 → 團隊管理」評分。',
  },
  en: {
    invite_text: '📋 Please complete your self-assessment: {title}',
    invite_heading: ':clipboard: *You have been added to a review: {title}*\n{when}',
    invite_deadline: 'Please fill in and submit your self-assessment under “Reviews” in the Management Portal by *{deadline}*.',
    invite_no_deadline: 'Please fill in and submit your self-assessment under “Reviews” in the Management Portal.',
    turn_text: '📋 {name}’s review is ready for your scoring',
    turn_heading: ':clipboard: *It is your turn to score*\n*Review:* {title}\n*Employee:* {name}\n*Step:* {step}{deadline}',
    turn_deadline: '\n*Scoring deadline:* {deadline}',
    turn_note: 'Please score it under “Reviews → Team Management” in the Management Portal.',
  },
} as const

type Key = keyof typeof MESSAGES.zh
function t(lang: Lang, key: Key, vars: Record<string, string | number> = {}) {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}

function fmtDate(lang: Lang, iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return lang === 'en' ? `${m}/${d}/${y}` : `${y}/${m}/${d}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    })
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    if (!auth?.user) return json({ error: '請先登入' }, 401)

    const body = await req.json().catch(() => ({}))
    if (body?.type === 'invited') {
      const ids = Array.isArray(body.participant_ids) ? body.participant_ids.filter((x: unknown) => typeof x === 'string') : []
      return json(await notifyInvited(db, ids.slice(0, 500)))
    }
    if (body?.type === 'turn' && typeof body.participant_id === 'string') {
      return json(await notifyTurn(db, body.participant_id))
    }
    return json({ error: '未知的通知類型' }, 400)
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, 500)
  }
})

interface Person { id: string; full_name: string; slack_user_id: string | null; language: string | null; is_active: boolean | null }
interface Review { title: string; status: string; self_assessment_deadline: string | null; evaluation_deadline: string | null }

/** 被加入考核名單 → 通知本人填自評。 */
async function notifyInvited(db: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return { sent: 0 }
  // 先搶記號：只有這次把 invite_notified_at 從空的改成有值的那幾筆才發
  const { data: claimed, error } = await db.from('annual_review_participants')
    .update({ invite_notified_at: new Date().toISOString() })
    .in('id', ids).is('invite_notified_at', null)
    .select('id, user_id, review_id, self_submitted, review:annual_reviews(title, status, self_assessment_deadline, evaluation_deadline)')
  if (error) throw new Error(`讀取考核名單失敗：${error.message}`)

  let sent = 0
  for (const p of (claimed ?? []) as unknown as { user_id: string; review_id: string; self_submitted: boolean | null; review: Review | null }[]) {
    if (!p.review || p.review.status !== 'active' || p.self_submitted) continue
    const person = await loadPerson(db, p.user_id)
    if (!person) continue
    const lang = normalizeLang(person.language)
    const deadline = fmtDate(lang, p.review.self_assessment_deadline)
    const text = t(lang, 'invite_text', { title: p.review.title })
    const blocks = [section(t(lang, 'invite_heading', {
      title: p.review.title,
      when: deadline ? t(lang, 'invite_deadline', { deadline }) : t(lang, 'invite_no_deadline'),
    }))]
    await dmAndPush(person, text, blocks, { url: '/review', tag: `review-self-${p.review_id}`, todo: true })
    sent++
  }
  return { sent }
}

/** 現在輪到某一關 → 通知那一關的評核人。 */
async function notifyTurn(db: SupabaseClient, participantId: string) {
  const { data: p, error } = await db.from('annual_review_participants')
    .select('id, user_id, flow_id, current_step, self_submitted, supervisor_submitted, turn_notified_key, review:annual_reviews(title, status, self_assessment_deadline, evaluation_deadline)')
    .eq('id', participantId).maybeSingle()
  if (error) throw new Error(`讀取考核名單失敗：${error.message}`)
  const row = p as unknown as {
    id: string; user_id: string; flow_id: string | null; current_step: number; self_submitted: boolean | null
    supervisor_submitted: boolean | null; turn_notified_key: string | null; review: Review | null
  } | null
  if (!row || !row.flow_id || !row.self_submitted || row.supervisor_submitted || row.review?.status !== 'active') {
    return { skipped: '目前沒有輪到任何人評分' }
  }

  const key = `${row.flow_id}:${row.current_step}`
  if (row.turn_notified_key === key) return { skipped: '這一關已經通知過' }
  // 搶記號：同一關只有一次會成功
  const { data: claimed } = await db.from('annual_review_participants')
    .update({ turn_notified_key: key })
    .eq('id', row.id).eq('flow_id', row.flow_id).eq('current_step', row.current_step)
    .or(`turn_notified_key.is.null,turn_notified_key.neq."${key}"`)
    .select('id')
  if (!claimed?.length) return { skipped: '這一關已經通知過' }

  const { data: steps } = await db.from('review_flow_steps')
    .select('evaluator_id').eq('flow_id', row.flow_id).eq('step_order', row.current_step)
  const employee = await loadPerson(db, row.user_id)
  let sent = 0
  for (const s of (steps ?? []) as { evaluator_id: string | null }[]) {
    const evaluator = s.evaluator_id ? await loadPerson(db, s.evaluator_id) : null
    if (!evaluator) continue
    const lang = normalizeLang(evaluator.language)
    const name = employee?.full_name ?? '—'
    const deadline = fmtDate(lang, row.review.evaluation_deadline)
    const text = t(lang, 'turn_text', { name })
    const blocks = [
      section(t(lang, 'turn_heading', {
        title: row.review.title, name, step: row.current_step,
        deadline: deadline ? t(lang, 'turn_deadline', { deadline }) : '',
      })),
      contextLine(t(lang, 'turn_note')),
    ]
    await dmAndPush(evaluator, text, blocks, { url: '/review/team', tag: `review-turn-${row.id}`, todo: true })
    sent++
  }
  return { sent }
}

async function loadPerson(db: SupabaseClient, id: string): Promise<Person | null> {
  const { data } = await db.from('users').select('id, full_name, slack_user_id, language, is_active').eq('id', id).maybeSingle()
  const p = data as Person | null
  return p && p.is_active !== false ? p : null
}


// ===== 發送：Slack 私訊＋App 推播 =====

const section = (md: string) => ({ type: 'section', text: { type: 'mrkdwn', text: md } })
const contextLine = (md: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: md }] })

interface PushOptions { url: string; tag?: string; todo?: boolean }

/** 有 Slack ID 就私訊；有開 App 通知就推播。兩邊互不影響，失敗只記 log。 */
async function dmAndPush(person: Person, text: string, blocks: unknown[], opts: PushOptions) {
  const slack = person.slack_user_id?.trim()
  if (slack) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${Deno.env.get('SLACK_BOT_TOKEN') ?? ''}` },
        body: JSON.stringify({ channel: slack, text, blocks, unfurl_links: false }),
      })
      const body = await res.json()
      if (!body.ok) console.error(`Slack 私訊 ${person.full_name} 失敗：${body.error}`)
    } catch (e) {
      console.error('Slack 私訊失敗', e)
    }
  }
  await pushTo([person.id], text, blocks, opts)
}

// 與 _shared/push.ts 同一份邏輯（這支刻意不 import 共用檔）
async function pushTo(userIds: string[], text: string, blocks: unknown[], opts: PushOptions) {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (userIds.length === 0 || !url || !key) return
  try {
    const res = await fetch(`${url}/functions/v1/send-push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', user_ids: userIds, ...slackToPush(text, blocks), ...opts }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.text()
    if (!res.ok) console.error(`推播失敗 ${res.status}: ${body.slice(0, 300)}`)
  } catch (e) {
    console.error('推播失敗', e)
  }
}

function slackToPush(text: string, blocks?: unknown[]) {
  const parts: string[] = []
  for (const b of (blocks ?? []) as { type?: string; text?: { text?: string }; elements?: { text?: string }[] }[]) {
    if (b?.type === 'section' && b.text?.text) parts.push(b.text.text)
    else if (b?.type === 'context') for (const e of b.elements ?? []) if (e?.text) parts.push(e.text)
  }
  const lines = parts.join('\n').split('\n')
  if (lines.length > 1 && /^\s*(:[a-z0-9_+-]+:\s*|\p{Extended_Pictographic}\s*)?\*[^*]+\*\s*$/u.test(lines[0])) lines.shift()
  const body = lines.map(pushPlain).filter(Boolean).join('\n')
  return { title: pushPlain(text), body: body.length > 600 ? body.slice(0, 599) + '…' : body }
}

function pushPlain(s: string): string {
  return s
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/[*~`]/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
