// 國定假日匯入：從行政院人事行政總處的「政府行政機關辦公日曆表」（政府資料開放平台
// 資料集 14718）抓某一年的日曆，把「週一～週五、是否放假 = 2」的日子寫進 holidays。
//
// ⚠️ 自給自足的單一檔案（不 import _shared），可以整支貼進 Supabase 網頁編輯器。
// ⚠️ Verify JWT 要關掉（跟 manage-users 一樣）：身分檢查在這裡做。
//
// ── 使用者決定（2026-11）──────────────────────────────────────────
//   · 公司不補班：補班的週六不記；「調整放假」的平日照放 → 只記平日的放假日
//   · 管理員與 HR 都能匯入；新增／修改／刪除假日只有 HR（網頁直接寫，權限規則擋）
//   · 自動匯入：排程每月叫一次 { action: 'auto' }，今年與明年有公布就匯入
//
// ── 動作 ────────────────────────────────────────────────────────
//   preview  { year, csv_base64? }  看會匯入哪些日子（不寫入）。需要管理員或 HR 登入。
//   import   { year, csv_base64? }  匯入。需要管理員或 HR 登入。
//            沒給 csv_base64 就去政府網站抓；給了就用上傳的檔案（網站抓不到時的備案）。
//   auto     {}                     排程用，不需登入：今年、明年各試一次。
//            被別人叫也無害：只會寫入官方公布的日子，而且已經有的日期一律不動。
//
// 已經有的日期一律不動（on conflict do nothing）：HR 改過名稱或刪掉的日子（刪掉的會留一列
// is_holiday = false 當記號）都會保留 HR 的版本。
//
// ── 回應 ────────────────────────────────────────────────────────
// 一律 200，內容 { ok, code?, ... }。code：not_signed_in / not_allowed / bad_request /
// not_published（政府還沒公布那一年）/ fetch_failed（連不到政府網站）/ bad_file（檔案格式不對）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DATASET_API = 'https://data.gov.tw/api/v2/rest/dataset/14718'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { headers: { ...CORS, 'Content-Type': 'application/json' } })

type Day = { date: string; name: string }
class Fail extends Error { constructor(public code: string, msg = code) { super(msg) } }

// ── 解析日曆檔 ─────────────────────────────────────────────────────

/** 官方檔案有 UTF-8（含 BOM）也有 Big5，兩種都收 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('big5').decode(bytes)
  }
}

/**
 * 欄位：西元日期,星期,是否放假,備註（2026-11 使用者提供的 115、116 年官方檔案）。
 * 照欄位名稱找，不靠欄位順序。整份檢查過才回傳：日期都在那一年、而且一天不少，
 * 檔案不對就整份不收（不要匯入一半）。
 */
export function parseCalendar(text: string, year: number): Day[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const head = (lines.shift() ?? '').split(',').map(s => s.trim().replace(/^"|"$/g, ''))
  const iDate = head.indexOf('西元日期'), iOff = head.indexOf('是否放假'), iNote = head.indexOf('備註')
  if (iDate < 0 || iOff < 0) throw new Fail('bad_file', '找不到「西元日期」「是否放假」欄位')

  const seen = new Set<string>()
  const out: Day[] = []
  for (const line of lines) {
    const cols = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
    const raw = cols[iDate] ?? ''
    if (!/^\d{8}$/.test(raw)) throw new Fail('bad_file', `日期格式不對：${raw}`)
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    if (Number(raw.slice(0, 4)) !== year) throw new Fail('bad_file', `檔案裡有不是 ${year} 年的日期：${date}`)
    seen.add(date)
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (cols[iOff] === '2' && dow !== 0 && dow !== 6) {
      out.push({ date, name: iNote >= 0 ? (cols[iNote] ?? '') : '' })
    }
  }
  const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365
  if (seen.size !== daysInYear) throw new Fail('bad_file', `天數不對：${seen.size} 天，應該是 ${daysInYear} 天`)
  return out
}

// ── 去政府網站抓 ───────────────────────────────────────────────────

/**
 * 資料集的每個檔案：從 API 的回應裡把「說明 + 下載網址」找出來（不假設確切的欄位層級）。
 * 2026-11-12 正式環境實測可用（找到 115、116 年）。
 */
function collectResources(node: unknown, out: { text: string; url: string }[] = []) {
  if (Array.isArray(node)) { node.forEach(n => collectResources(n, out)); return out }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    const url = Object.entries(o).find(([k, v]) => /url/i.test(k) && typeof v === 'string' && /^https?:\/\//.test(v))?.[1] as string | undefined
    if (url) {
      const text = Object.entries(o).filter(([k, v]) => typeof v === 'string' && !/url/i.test(k)).map(([, v]) => v).join(' ')
      out.push({ text: `${text} ${url}`, url })
    }
    Object.values(o).forEach(v => collectResources(v, out))
  }
  return out
}

async function fetchOfficial(year: number): Promise<Day[]> {
  const roc = year - 1911
  let meta: unknown
  try {
    const res = await fetch(DATASET_API)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    meta = await res.json()
  } catch (e) {
    throw new Fail('fetch_failed', `讀不到政府資料開放平台：${(e as Error).message}`)
  }
  // 那一年的 CSV；「Google 行事曆專用」那種格式不一樣的跳過
  const candidates = collectResources(meta)
    .filter(r => r.text.includes(`${roc}年`) && /csv/i.test(r.text) && !/google/i.test(r.text))
  if (candidates.length === 0) throw new Fail('not_published', `還沒有 ${roc} 年（${year}）的辦公日曆`)

  let lastError = ''
  for (const c of candidates) {
    try {
      const res = await fetch(c.url)
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue }
      return parseCalendar(decodeCsv(new Uint8Array(await res.arrayBuffer())), year)
    } catch (e) {
      lastError = (e as Error).message
    }
  }
  throw new Fail('bad_file', `找到 ${candidates.length} 個 ${roc} 年的檔案，但都讀不了：${lastError}`)
}

function fromUpload(b64: string, year: number): Day[] {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))
  } catch {
    throw new Fail('bad_file', '檔案讀不了')
  }
  return parseCalendar(decodeCsv(bytes), year)
}

// ── 寫入 ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function existing(db: any, year: number) {
  const { data, error } = await db.from('holidays').select('date, name, is_holiday')
    .gte('date', `${year}-01-01`).lte('date', `${year}-12-31`)
  if (error) throw new Error(error.message)
  return new Map<string, { name: string; is_holiday: boolean }>((data ?? []).map((r: { date: string; name: string; is_holiday: boolean }) => [r.date, r]))
}

// deno-lint-ignore no-explicit-any
async function save(db: any, days: Day[], by: string | null) {
  if (days.length === 0) return 0
  const { data, error } = await db.from('holidays')
    .upsert(days.map(d => ({ ...d, source: 'dgpa', updated_by: by })), { onConflict: 'date', ignoreDuplicates: true })
    .select('date')
  if (error) throw new Error(error.message)
  return (data ?? []).length
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply({ ok: false, code: 'bad_request' })

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } })
    const body = await req.json().catch(() => ({}))
    const action = body?.action

    // ── 排程：今年、明年 ──
    if (action === 'auto') {
      const thisYear = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4))
      const results: Record<string, unknown> = {}
      for (const year of [thisYear, thisYear + 1]) {
        try {
          const days = await fetchOfficial(year)
          const inserted = await save(db, days, null)
          results[year] = { found: days.length, inserted }
          if (inserted) console.log(`自動匯入 ${year} 年假日：新增 ${inserted} 天`)
        } catch (e) {
          results[year] = { code: e instanceof Fail ? e.code : 'error', message: (e as Error).message }
        }
      }
      return reply({ ok: true, results })
    }

    if (action !== 'preview' && action !== 'import') return reply({ ok: false, code: 'bad_request' })

    // ── 網頁：管理員或 HR ──
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    if (!auth?.user) return reply({ ok: false, code: 'not_signed_in' })
    const { data: caller } = await db.from('users')
      .select('id, full_name, is_admin, is_finance, is_active').eq('id', auth.user.id).maybeSingle()
    if (!caller || caller.is_active === false || !(caller.is_admin || caller.is_finance)) {
      return reply({ ok: false, code: 'not_allowed' })
    }

    const year = Number(body?.year)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return reply({ ok: false, code: 'bad_request' })

    const days = typeof body?.csv_base64 === 'string' && body.csv_base64
      ? fromUpload(body.csv_base64, year)
      : await fetchOfficial(year)
    const have = await existing(db, year)

    if (action === 'preview') {
      return reply({
        ok: true, year, source: body?.csv_base64 ? 'upload' : 'dgpa',
        days: days.map(d => {
          const h = have.get(d.date)
          return { ...d, status: !h ? 'new' : h.is_holiday ? 'exists' : 'removed_by_hr' }
        }),
      })
    }

    const inserted = await save(db, days, caller.id)
    console.log(`${caller.full_name} 匯入 ${year} 年假日：新增 ${inserted} 天（檔案共 ${days.length} 天）`)
    return reply({ ok: true, year, found: days.length, inserted })
  } catch (e) {
    if (e instanceof Fail) return reply({ ok: false, code: e.code, message: e.message })
    console.error('import-holidays 失敗：', e)
    return reply({ ok: false, code: 'error', message: (e as Error).message })
  }
})
