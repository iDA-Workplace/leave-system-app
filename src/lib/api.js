import { supabase } from './supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// 呼叫後台 function。Authorization 一定要帶「登入者的 token」，不能帶公開金鑰：
// function 靠這個 token 確認呼叫的人是誰、有沒有權限（例如 manage-users 只給
// 管理員／HR 用）。以前這裡帶的是公開金鑰，function 根本分不出是誰在呼叫。
// apikey 標頭照樣帶公開金鑰，那是 Supabase 閘道要的，本來就是公開的。
export async function invokeFunction(functionName, body) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { data: { error: 'not_signed_in' }, error: { message: 'not_signed_in' } }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  return { data, error: response.ok ? null : data }
}
