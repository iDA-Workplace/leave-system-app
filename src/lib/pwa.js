/**
 * 安裝成 App 的相關工具：註冊 Service Worker、判斷現在是不是「已安裝的 App」、
 * 判斷使用者的裝置與瀏覽器該用哪一種安裝方式。
 */

/**
 * 註冊 Service Worker。
 *
 * 只在正式站台註冊：開發時掛著 SW 會讓「改完存檔沒反應」變成很難查的問題。
 * 註冊失敗（例如瀏覽器不支援、或不是 https）一律安靜略過 —— 系統照樣能用，
 * 只是不能安裝成 App，不該因此在畫面上丟錯誤給使用者。
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (!import.meta.env.PROD) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

/** 現在是不是從主畫面／桌面圖示開起來的（而不是瀏覽器分頁）。 */
export function isStandalone() {
  return !!(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true   // iOS Safari 專用的舊旗標
  )
}

/**
 * 判斷該顯示哪一段安裝步驟。
 *
 * 刻意用 userAgent 判斷而不是偵測功能：這裡要回答的是「你手上這台裝置的
 * 安裝步驟長什麼樣」，那本來就是裝置與瀏覽器的問題，沒有對應的功能可以測。
 * 判斷錯了也不嚴重 —— 說明頁三種步驟都會列出來，這只決定哪一段先展開。
 */
export function detectPlatform() {
  const ua = navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13 之後的 Safari 會自稱 Macintosh，用觸控點數再確認一次
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (isIOS) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other-browser' : 'ios-safari'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

/* ---------------------------------------------------------------------------
 * Chrome／Edge 的「安裝」提示
 *
 * 瀏覽器判斷這個網站可以安裝時會丟出 beforeinstallprompt，而且丟得很早 ——
 * 常常在 React 還沒掛載完之前。所以在這裡（模組載入時）就先接住並存起來，
 * 安裝說明頁之後才拿得到它，可以給使用者一顆真的「立即安裝」按鈕。
 *
 * iOS 完全沒有這個事件，Safari 只能手動「加入主畫面」，所以說明頁還是要
 * 保留圖文步驟，不能只靠這顆按鈕。
 * ------------------------------------------------------------------------- */

let deferredPrompt = null
const listeners = new Set()

function notify() {
  for (const fn of listeners) fn()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault()   // 擋掉瀏覽器自己的橫幅，改由說明頁上的按鈕觸發
    deferredPrompt = e
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

/** 現在有沒有可以直接觸發的安裝提示（沒有就只能照說明手動安裝）。 */
export function canPromptInstall() {
  return deferredPrompt !== null
}

/** 訂閱「可不可以安裝」的變化，回傳取消訂閱的函式。 */
export function onInstallPromptChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 叫出瀏覽器的安裝對話框。回傳 'accepted' / 'dismissed' / 'unavailable'。 */
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable'
  deferredPrompt.prompt()
  const { outcome } = await deferredPrompt.userChoice
  // 同一個事件只能用一次，用掉就丟
  deferredPrompt = null
  notify()
  return outcome
}
