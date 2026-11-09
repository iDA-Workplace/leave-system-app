// 員工帳號的新增／修改／停用。網頁「管理後台 → 員工帳號管理」呼叫的就是這支。
//
// ⚠️ 自給自足的單一檔案（不 import _shared），可以整支貼進 Supabase 網頁編輯器。
//
// ── 為什麼要改寫（使用者同意後修正的安全問題）─────────────────────────
// 舊版沒有確認「呼叫的人是誰」：網頁送的是公開金鑰（anon key，任何人都能從網站
// 程式碼裡看到），所以不只同仁，連沒登入的人都能直接呼叫它新增帳號、改任何人的
// 角色、把人停用，甚至用 action: 'delete' 永久刪除別人的登入帳號。
// 另外，舊版「停用」只改 users.is_active，登入帳號本身還在，停用的人照樣登得進來。
//
// ── 誰可以用 ────────────────────────────────────────────────────
// 在職的「管理員」或「HR」（users.is_admin / users.is_finance）。
// 網頁呼叫時會帶上登入者的 token（src/lib/api.js），這裡用 auth.getUser(token)
// 向 Supabase 確認 token 是真的、是誰的，再查 users 表看他的身分。
// Verify JWT 要「關掉」（跟 admin-reset-password 一樣）：身分檢查在這裡做，不是沒有保護。
//
// ── 支援的動作 ──────────────────────────────────────────────────
// create：新增帳號（預設密碼 Welcome@123，跟 AdminPanel.jsx 的 DEFAULT_PASSWORD 一致）
// update：改姓名／角色／Slack ID／在職狀態。停用時一併「封鎖登入」，恢復時解除封鎖。
// （舊版的 delete 已拿掉：網站從來沒用到，留著只會變成可以把人整個刪掉的後門。
//   離職一律用停用，資料全部保留。）
//
// ── 回應格式 ────────────────────────────────────────────────────
// 跟舊版一樣：成功 { success: true, ... }；失敗 { error: '代碼' } 加上非 2xx 狀態。
// 網頁那邊會把認得的代碼翻成中文／英文（AdminPanel.jsx 的 manageUsersError）。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DEFAULT_PASSWORD = 'Welcome@123'
// 停用 = 封鎖登入。Supabase 的封鎖要給一段時間，給 100 年等於永久；恢復時用 'none' 解除。
const BAN_FOREVER = '876000h'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply({ error: 'bad_request' }, 400)

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } })

    // ── 確認呼叫的人 ──
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } }
    if (!auth?.user) return reply({ error: 'not_signed_in' }, 401)

    const { data: caller } = await db.from('users')
      .select('id, full_name, is_admin, is_finance, is_active').eq('id', auth.user.id).maybeSingle()
    if (!caller || caller.is_active === false || !(caller.is_admin || caller.is_finance)) {
      return reply({ error: 'not_allowed' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const { action, userId, email, password, full_name, role, slack_user_id, is_active } = body ?? {}

    // ── 新增員工 ──
    if (action === 'create') {
      if (!email || !full_name) return reply({ error: 'bad_request' }, 400)
      const { data, error } = await db.auth.admin.createUser({
        email,
        password: password || DEFAULT_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name, role },
      })
      if (error) return reply({ error: error.message }, 400)

      await db.from('users').update({ full_name, role }).eq('id', data.user.id)
      console.log(`${caller.full_name}（${caller.id}）新增了帳號 ${full_name}（${data.user.id}）`)
      return reply({ success: true, user: data.user })
    }

    // ── 更新員工資料（含停用／恢復）──
    if (action === 'update') {
      if (typeof userId !== 'string' || !userId) return reply({ error: 'bad_request' }, 400)
      const { data: target } = await db.from('users').select('id, full_name, is_active').eq('id', userId).maybeSingle()
      if (!target) return reply({ error: 'not_found' }, 404)

      // 沒帶的欄位不動（JSON 裡沒有 undefined，所以只更新有送來的欄位）
      const patch: Record<string, unknown> = {}
      if (full_name !== undefined) patch.full_name = full_name
      if (role !== undefined) patch.role = role
      if (slack_user_id !== undefined) patch.slack_user_id = slack_user_id
      if (typeof is_active === 'boolean') patch.is_active = is_active

      const { error: updateError } = await db.from('users').update(patch).eq('id', userId)
      if (updateError) return reply({ error: updateError.message }, 400)

      // 停用 → 封鎖登入；恢復 → 解除封鎖。每次都同步一次（不只狀態有變時），
      // 這樣以前用舊版停用、還沒被封鎖的人，只要再存一次就會補上。
      if (typeof is_active === 'boolean') {
        const { error: banError } = await db.auth.admin.updateUserById(userId,
          { ban_duration: is_active ? 'none' : BAN_FOREVER })
        if (banError) {
          console.error(`封鎖／解除封鎖登入失敗（${target.full_name}）：`, banError.message)
          return reply({ error: 'ban_failed' }, 500)
        }
        if (is_active !== target.is_active) {
          console.log(`${caller.full_name}（${caller.id}）${is_active ? '恢復' : '停用'}了 ${target.full_name}（${target.id}）的帳號`)
        }
      }
      return reply({ success: true })
    }

    return reply({ error: 'unknown_action' }, 400)
  } catch (e) {
    console.error(e)
    return reply({ error: 'internal_error' }, 500)
  }
})
