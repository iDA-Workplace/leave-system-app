// App 推播通知（Web Push）。
//
// 三種呼叫方式：
//
//   1. 其他後台程式（send-slack-notification、massage-notify…）：
//        Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//        { action: 'send', user_ids: [...], title, body, url, tag, todo }
//      → 發給這些人「所有開啟通知的裝置」。沒開的人直接略過，不算錯誤。
//
//   2. 網頁（登入的人）：{ action: 'public_key' }
//      → 回傳推播金鑰的公開那一半，瀏覽器開啟通知時要用。
//        金鑰第一次用到時由這裡自動產生，存在 push_config（只有後台讀得到）。
//
//   3. 網頁（登入的人）：{ action: 'test' }
//      → 發一則測試通知給「自己」所有開啟通知的裝置。
//
// 推播內容全程加密（RFC 8291 aes128gcm）：Apple／Google 的推播伺服器只負責轉送，
// 看不到內容。金鑰的私密那一半永遠不會離開這支程式與資料庫。
//
// 部署：Supabase 主控台 → Edge Functions → 新增 send-push → 整份貼上 → Deploy，
//       然後在 Details 把「Verify JWT」關掉（這支自己檢查身分，同 manage-users）。
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

// 推播的「聯絡方式」欄位（VAPID 規定要有一個 https 網址或 mailto，Apple 會檢查格式）。
// 依序用：PUSH_CONTACT → 網站網址 SITE_URL（按摩通知已經在用）→ Supabase 專案網址（一定有）。
const SUBJECT = (Deno.env.get('PUSH_CONTACT') || Deno.env.get('SITE_URL') || Deno.env.get('SUPABASE_URL') || '')
  .trim().replace(/\/+$/, '')

const TEST_TEXT = {
  zh: { title: 'iDA Workplace', body: '測試通知：這台裝置收得到 App 通知了 🎉' },
  en: { title: 'iDA Workplace', body: 'Test notification: this device can receive app notifications 🎉' },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    })
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const body = await req.json().catch(() => ({}))
    const action = body?.action

    // ── 後台程式呼叫 ──
    if (token && token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      if (action !== 'send') return json({ error: `未知的動作：${action}` }, 400)
      const userIds = Array.isArray(body.user_ids) ? body.user_ids.filter((x: unknown) => typeof x === 'string') : []
      if (!body.title) return json({ error: '缺少 title' }, 400)
      return json(await sendToUsers(db, userIds, {
        title: String(body.title), body: body.body ? String(body.body) : '',
        url: typeof body.url === 'string' ? body.url : '/', tag: typeof body.tag === 'string' ? body.tag : undefined,
        todo: body.todo === true,
      }))
    }

    // ── 網頁呼叫：要登入 ──
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    const user = auth?.user
    if (!user) return json({ error: '請先登入' }, 401)

    if (action === 'public_key') {
      const vapid = await getVapid(db)
      return json({ publicKey: vapid.publicKey })
    }

    if (action === 'test') {
      const { data: me } = await db.from('users').select('language').eq('id', user.id).maybeSingle()
      const text = me?.language === 'en' ? TEST_TEXT.en : TEST_TEXT.zh
      return json(await sendToUsers(db, [user.id], { ...text, url: '/settings', tag: 'test', todo: false }))
    }

    return json({ error: `未知的動作：${action}` }, 400)
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, 500)
  }
})


// ===== 發送 =====

interface PushMessage { title: string; body: string; url: string; tag?: string; todo: boolean }
interface SubRow { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }

// 推播內容上限：加密後一筆紀錄 4096 bytes，扣掉加密的額外長度留點餘裕
const MAX_TEXT = 1200

async function sendToUsers(db: SupabaseClient, userIds: string[], msg: PushMessage) {
  let ids = [...new Set(userIds)]
  if (ids.length === 0) return { sent: 0, devices: 0 }
  // 已停用（離職）的帳號不發
  const { data: active } = await db.from('users').select('id').in('id', ids).or('is_active.is.null,is_active.eq.true')
  ids = (active ?? []).map((u: { id: string }) => u.id)
  if (ids.length === 0) return { sent: 0, devices: 0 }

  const { data, error } = await db.from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth').in('user_id', ids)
  if (error) throw new Error(`讀取推播裝置失敗：${error.message}`)
  const subs = (data ?? []) as SubRow[]
  if (subs.length === 0) return { sent: 0, devices: 0 }

  const vapid = await getVapid(db)

  // 每個人的圖示數字（待處理件數）各算一次
  const badges = new Map<string, number>()
  for (const uid of new Set(subs.map(s => s.user_id))) {
    const { data: n } = await db.rpc('app_badge_count', { p_user: uid })
    badges.set(uid, typeof n === 'number' ? n : 0)
  }

  let sent = 0
  const removed: string[] = []
  const failures: string[] = []
  await Promise.all(subs.map(async (s) => {
    const payload = JSON.stringify({
      title: msg.title.slice(0, 200),
      body: msg.body.slice(0, MAX_TEXT),
      url: msg.url.startsWith('/') ? msg.url : '/',
      tag: msg.tag,
      todo: msg.todo,
      badge: badges.get(s.user_id) ?? 0,
    })
    try {
      const res = await pushOne(s, enc.encode(payload), vapid)
      if (res.status === 404 || res.status === 410) {
        // 裝置已經取消（解除安裝、清掉資料、關掉通知）→ 刪掉，下次不用再試
        removed.push(s.id)
      } else if (res.ok) {
        sent++
        await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), last_error: null }).eq('id', s.id)
      } else {
        const why = `${res.status} ${(await res.text()).slice(0, 200)}`
        failures.push(why)
        await db.from('push_subscriptions').update({ last_error: why }).eq('id', s.id)
      }
    } catch (e) {
      failures.push((e as Error).message)
    }
  }))

  if (removed.length) await db.from('push_subscriptions').delete().in('id', removed)
  return { sent, devices: subs.length, removed: removed.length, failures }
}

async function pushOne(s: SubRow, payload: Bytes, vapid: Vapid): Promise<Response> {
  const body = await encryptPayload(s.p256dh, s.auth, payload)
  return await fetch(s.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(24 * 60 * 60),          // 裝置離線時最多保留一天
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidAuthorization(s.endpoint, vapid),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })
}


// ===== 金鑰（VAPID） =====

interface Vapid { publicKey: string; privateKey: CryptoKey }
let vapidCache: Vapid | null = null

async function getVapid(db: SupabaseClient): Promise<Vapid> {
  if (vapidCache) return vapidCache

  let { data: row } = await db.from('push_config').select('public_key, private_jwk').eq('id', 1).maybeSingle()
  if (!row) {
    // 第一次：產生一組，存起來。兩個請求同時產生時，只有先寫進去的那組算數（on conflict do nothing），
    // 之後一律重新讀資料庫裡的那組。
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const { error } = await db.from('push_config')
      .upsert({ id: 1, public_key: b64url(publicRaw), private_jwk: privateJwk }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw new Error(`儲存推播金鑰失敗：${error.message}`)
    ;({ data: row } = await db.from('push_config').select('public_key, private_jwk').eq('id', 1).maybeSingle())
    if (!row) throw new Error('推播金鑰讀不到')
  }

  const privateKey = await crypto.subtle.importKey(
    'jwk', row.private_jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  vapidCache = { publicKey: row.public_key as string, privateKey }
  return vapidCache
}

/** RFC 8292：用金鑰簽一張 12 小時有效的 JWT，證明推播是我們發的。 */
async function vapidAuthorization(endpoint: string, vapid: Vapid): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: SUBJECT,
  })))
  const unsigned = `${header}.${claims}`
  // WebCrypto 的 ECDSA 簽章本來就是 JWT 要的 r||s（64 bytes）格式
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(unsigned)))
  return `vapid t=${unsigned}.${b64url(sig)}, k=${vapid.publicKey}`
}


// ===== 加密（RFC 8291，Content-Encoding: aes128gcm） =====

const enc = new TextEncoder()
// 一律用「底層是 ArrayBuffer」的位元組陣列，WebCrypto／fetch 的型別才對得上
type Bytes = Uint8Array<ArrayBuffer>

export async function encryptPayload(p256dh: string, authSecret: string, plaintext: Bytes): Promise<Bytes> {
  const uaPublic = fromB64url(p256dh)
  const auth = fromB64url(authSecret)

  // 每則推播都用一組新的臨時金鑰
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256))

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const record = concat(plaintext, new Uint8Array([2]))   // 0x02 ＝ 最後一筆紀錄
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record))

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

function b64url(bytes: Bytes): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Bytes {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}
