// 管理員幫同仁重設密碼（使用者決定）：密碼改回新員工用的預設密碼，同仁用它登入後，
// 自己到「設定」改成新密碼。
//
// 為什麼要有這支：密碼是加密存的，任何人（包含管理員、Supabase 後台）都看不到原本的
// 密碼，忘記了只能重設。改別人的密碼要用 service role 金鑰，這把金鑰只能放在伺服器端，
// 所以不能在網頁上直接做，要透過這支 function。
//
// ⚠️ 自給自足的單一檔案（不 import _shared），可以整支貼進 Supabase 網頁編輯器。
//
// ── 誰可以用 ────────────────────────────────────────────────────
// 只有「管理員」（users.is_admin）。員工帳號管理本來就只有管理員看得到（AdminPanel.jsx）。
// 不能用來改自己的密碼（自己的請到「設定」改：登入狀態下輸入新密碼兩次即可，不用輸入舊密碼）。
//
// ── 怎麼確認呼叫的人是誰 ──────────────────────────────────────────
// 網頁用 supabase.functions.invoke 呼叫，會自動帶上登入者的 token。這裡用
// auth.getUser(token) 向 Supabase 確認這個 token 是真的、是誰的，再查 users 表看他是不是
// 管理員。所以這支的 Verify JWT 要「關掉」（跟 massage-notify 一樣：正式專案用的是新制
// 金鑰，閘道的 Verify JWT 會擋掉不是舊制格式的呼叫）——身分檢查在這裡做，不是沒有保護。
//
// 預設密碼跟 src/pages/AdminPanel.jsx 的 DEFAULT_PASSWORD 一致；要改的話兩邊一起改。
// 刻意寫死在這裡、不接受網頁傳來的密碼：就算有人偽造請求，也只能把密碼改回預設值。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DEFAULT_PASSWORD = 'Welcome@123'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 一律回 200，結果放在 { ok, code }：網頁那邊用 supabase.functions.invoke，非 2xx 的回應
// 內容不好讀，統一這樣處理比較單純（跟資料庫函式回 { ok, code } 是同一套習慣）。
const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply({ ok: false, code: 'bad_request' })

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } })

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    if (!auth?.user) return reply({ ok: false, code: 'not_signed_in' })

    const { data: caller } = await db.from('users').select('id, is_admin, is_active').eq('id', auth.user.id).maybeSingle()
    if (!caller?.is_admin || caller.is_active === false) return reply({ ok: false, code: 'not_allowed' })

    const body = await req.json().catch(() => ({}))
    const targetId = typeof body?.user_id === 'string' ? body.user_id : ''
    if (!targetId) return reply({ ok: false, code: 'bad_request' })
    if (targetId === caller.id) return reply({ ok: false, code: 'self' })

    const { data: target } = await db.from('users').select('id, full_name').eq('id', targetId).maybeSingle()
    if (!target) return reply({ ok: false, code: 'not_found' })

    const { error } = await db.auth.admin.updateUserById(target.id, { password: DEFAULT_PASSWORD })
    if (error) {
      console.error(`重設密碼失敗（${target.full_name}）：`, error.message)
      return reply({ ok: false, code: 'failed' })
    }
    // 留一筆紀錄在 Logs：誰、什麼時候、幫誰重設（不記密碼）
    console.log(`管理員 ${caller.id} 重設了 ${target.full_name}（${target.id}）的密碼`)
    return reply({ ok: true })
  } catch (e) {
    console.error(e)
    return reply({ ok: false, code: 'failed' })
  }
})
