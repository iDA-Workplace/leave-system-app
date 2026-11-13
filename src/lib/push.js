import { supabase } from './supabase'
import { detectPlatform, isStandalone } from './pwa'

/**
 * App 推播通知＋圖示上的數字（2026-11）。
 *
 * 流程：同仁在「設定 → App 通知」按開啟 → 瀏覽器詢問允許通知 → 向瀏覽器訂閱推播
 * （用 send-push 給的公開金鑰）→ 把這台裝置記到資料庫（save_push_subscription）。
 * 之後後台程式發 Slack 私訊時，同一則內容也會推播到這台裝置（public/sw.js 接收）。
 *
 * 圖示數字 ＝ 待處理件數（my_app_badge_count：待簽核假單＋待評分考核＋待填自評）
 *          ＋ 這台裝置上未讀的推播則數（打開 App 就歸零）。
 */

const PUSH_STATE_CACHE = 'ida-push-state'   // 跟 public/sw.js 同一個名字
const UNREAD_KEY = '/__push/unread'

/** 這個瀏覽器能不能收推播。 */
export function pushSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * 這台裝置目前的狀態：
 *   'unsupported'  瀏覽器不支援
 *   'needs-install' iPhone／iPad：要先「加入主畫面」、從主畫面圖示打開才能開通知
 *   'denied'       之前按了「不允許」，要到系統／瀏覽器設定裡改
 *   'on'           已開啟
 *   'off'          還沒開
 */
export async function getPushState() {
  const platform = detectPlatform()
  const ios = platform === 'ios-safari' || platform === 'ios-other-browser'
  if (ios && !isStandalone()) return 'needs-install'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const sub = await currentSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

async function registration() {
  // 開發模式沒有註冊 Service Worker（見 lib/pwa.js），這時 ready 會永遠等不到
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return navigator.serviceWorker.ready
}

async function currentSubscription() {
  const reg = await registration()
  return reg ? reg.pushManager.getSubscription() : null
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4)
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function sameKey(a, b) {
  if (!a || !b) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

async function saveSubscription(sub) {
  const json = sub.toJSON()
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh,
    p_auth: json.keys?.auth,
    p_user_agent: navigator.userAgent,
  })
  if (error) throw new Error(error.message)
}

/**
 * 開啟通知。一定要在使用者按按鈕的當下呼叫（瀏覽器規定）。
 * 回傳 'on' / 'denied'；其他錯誤丟出去讓畫面顯示。
 */
export async function enablePush() {
  if (!pushSupported()) throw new Error('unsupported')
  const reg = await registration()
  if (!reg) throw new Error('no-service-worker')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const { data, error } = await supabase.functions.invoke('send-push', { body: { action: 'public_key' } })
  if (error || !data?.publicKey) throw new Error(error?.message || 'no-public-key')
  const appKey = keyBytes(data.publicKey)

  let sub = await reg.pushManager.getSubscription()
  // 金鑰換過（例如資料庫重建）的舊訂閱收不到，要重新訂一次
  if (sub && !sameKey(sub.options?.applicationServerKey, appKey)) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
  await saveSubscription(sub)
  return 'on'
}

/** 關閉這台裝置的通知（資料庫那筆一起刪）。 */
export async function disablePush() {
  const sub = await currentSubscription()
  if (!sub) return
  await supabase.rpc('remove_push_subscription', { p_endpoint: sub.endpoint })
  await sub.unsubscribe().catch(() => {})
}

/** 發一則測試通知給自己所有開啟通知的裝置。回傳成功送出的裝置數。 */
export async function sendTestPush() {
  const { data, error } = await supabase.functions.invoke('send-push', { body: { action: 'test' } })
  if (error) throw new Error(error.message)
  return data?.sent ?? 0
}

/**
 * 登入後同步一次：這台裝置已經開過通知的話，把它記到「現在登入的人」名下。
 * （瀏覽器偶爾會自己換推播網址；同一台裝置換人登入時也要改成新的人。）
 */
export async function syncPushSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return
    const sub = await currentSubscription()
    if (sub) await saveSubscription(sub)
  } catch { /* 同步失敗不影響使用，下次打開再試 */ }
}

/**
 * 登出前呼叫：這台裝置不再收這個人的通知（共用電腦、交接手機時，不會收到前一個人的通知）。
 * 下一個登入的人要自己再開一次。
 */
export async function clearPushOnLogout() {
  try {
    await disablePush()
    await setAppBadge(0)
  } catch { /* 登出照常進行 */ }
}

/** 打開 App 時呼叫：未讀的推播歸零。 */
export async function resetUnreadPushCount() {
  try {
    if (!('caches' in window)) return
    await (await caches.open(PUSH_STATE_CACHE)).put(UNREAD_KEY, new Response('0'))
  } catch { /* 不支援就略過 */ }
}

/** 設定 App 圖示上的數字（0 ＝ 清掉）。不支援的裝置安靜略過。 */
export async function setAppBadge(n) {
  try {
    if (n > 0) await navigator.setAppBadge?.(n)
    else await navigator.clearAppBadge?.()
  } catch { /* 不支援 */ }
}

/** 重新算圖示數字：打開 App 的當下只剩「待處理件數」（未讀已歸零）。 */
export async function refreshAppBadge() {
  if (!('setAppBadge' in navigator)) return
  const { data, error } = await supabase.rpc('my_app_badge_count')
  if (error) return
  await setAppBadge(typeof data === 'number' ? data : 0)
}

// 點通知時 App 已經開著、但 Service Worker 沒辦法直接換頁（例如這個分頁不是它管的）
// 會改用訊息叫網頁自己換頁。
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const url = e.data?.type === 'navigate' && typeof e.data.url === 'string' ? new URL(e.data.url) : null
    if (url && url.origin === window.location.origin) window.location.assign(url.href)
  })
}
