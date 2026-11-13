/* iDA Workplace — Service Worker
 *
 * 只有一個目的：讓裝到主畫面／桌面的這個 App 開得快、斷網時不會變成一片
 * 空白的錯誤頁。**不做離線送假單**。
 *
 * 為什麼不做離線送出：假單牽涉額度計算與簽核流程，離線存起來之後再補送，
 * 會跟別人同一時間送出的假單打架（額度算兩次、流程關卡對不上），而且使用者
 * 會以為已經送出了。寧可明確告訴他現在沒網路，也不要製造一張下落不明的假單。
 *
 * 快取策略：
 *   · 開啟頁面（navigate）→ 先走網路，失敗才用快取的外殼，再失敗給離線說明頁。
 *     先走網路是為了「我更新了網站，大家下次打開就是新版」，不必手動清快取。
 *   · /assets/ 裡的 JS/CSS → 直接用快取。這些檔名帶內容雜湊，改一個字檔名就
 *     會變，所以舊檔名的內容永遠是對的，可以放心快取。
 *   · 其他所有請求（Supabase 的資料、登入、Slack）→ 完全不碰，一律走網路。
 *     這些是即時資料與登入狀態，快取只會害人看到過期或別人的資料。
 *
 * App 推播（2026-11）：收到推播就跳出通知、更新 App 圖示上的數字；點通知打開對應的頁面。
 *   圖示數字 ＝ 推播帶來的「待處理件數」（後台算的：待簽核假單＋待評分考核＋待填自評）
 *            ＋ 這台裝置上「未讀的推播」則數（打開 App 就歸零，網頁那邊會清）。
 *   待辦類的推播（例如待你簽核）本身已經算在待處理件數裡，不再算一則未讀，免得算兩次。
 */

const VERSION = 'v2'
const SHELL_CACHE = `ida-shell-${VERSION}`
const ASSET_CACHE = `ida-assets-${VERSION}`
const OFFLINE_URL = '/offline.html'

// 裝好就先把外殼與離線說明頁抓下來，第一次斷網時才有東西可以顯示。
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    await cache.addAll([OFFLINE_URL, '/'])
    // 不等使用者把所有分頁關掉才換新版
    await self.skipWaiting()
  })())
})

// 換版時把舊版的快取整批清掉，不然舊 JS 會一直佔著空間。
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE, PUSH_STATE_CACHE])
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return   // Supabase 等外部請求一律不碰

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request))
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request))
  }
})

async function networkFirstPage(request) {
  try {
    const response = await fetch(request)
    // 把最新的外殼存起來，供下次斷網時使用
    const cache = await caches.open(SHELL_CACHE)
    cache.put('/', response.clone())
    return response
  } catch {
    const cache = await caches.open(SHELL_CACHE)
    return (await cache.match('/')) || (await cache.match(OFFLINE_URL)) || Response.error()
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}


/* ---------------------------------------------------------------------------
 * 推播
 * ------------------------------------------------------------------------- */

// 「未讀的推播」則數存在 Cache Storage（SW 裡沒有 localStorage）。網頁打開時
// 用同一個 key 把它歸零（src/lib/push.js 的 resetUnreadPushCount）。
const PUSH_STATE_CACHE = 'ida-push-state'
const UNREAD_KEY = '/__push/unread'

async function readUnread() {
  try {
    const res = await (await caches.open(PUSH_STATE_CACHE)).match(UNREAD_KEY)
    return res ? Number(await res.text()) || 0 : 0
  } catch { return 0 }
}

async function writeUnread(n) {
  try { await (await caches.open(PUSH_STATE_CACHE)).put(UNREAD_KEY, new Response(String(n))) } catch { /* 存不了就算了 */ }
}

async function setBadge(n) {
  try {
    if (n > 0) await self.navigator.setAppBadge?.(n)
    else await self.navigator.clearAppBadge?.()
  } catch { /* 不支援圖示數字的裝置就略過 */ }
}

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data?.text() } }

  event.waitUntil((async () => {
    let unread = await readUnread()
    if (!data.todo) { unread += 1; await writeUnread(unread) }
    await setBadge((Number(data.badge) || 0) + unread)
    // iPhone／Chrome 都規定：收到推播一定要跳出通知，不能偷偷更新數字就好
    await self.registration.showNotification(data.title || 'iDA Workplace', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    })
  })())
})

// 點通知：App 已經開著就切過去並換到那一頁，沒開就打開
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue
      await w.focus()
      try { await w.navigate(target) } catch { w.postMessage({ type: 'navigate', url: target }) }
      return
    }
    await self.clients.openWindow(target)
  })())
})
