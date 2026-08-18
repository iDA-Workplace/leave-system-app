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
 */

const VERSION = 'v1'
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
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
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
