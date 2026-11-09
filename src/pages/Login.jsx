import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../context/LanguageContext'
import './Login.css'

// 「記住我」只記 email，不記密碼。
//
// 密碼一律留白讓人自己打：這台裝置可能是共用的（公司的公用電腦、借人用的
// 手機），email 被別人看到頂多是知道你的信箱，密碼被自動帶入就等於帳號送人。
// 瀏覽器本身的密碼管理員要不要記是使用者自己的選擇，那有系統層級的保護，
// 跟我們把密碼寫進 localStorage 是兩回事。
const REMEMBERED_EMAIL_KEY = 'leave-system-remembered-email'

// 被系統登出時要在登入頁說明原因（目前只有「帳號已停用」）。App.jsx 登出前寫入
// 翻譯的 key，登入頁讀一次就清掉。
export const LOGIN_NOTICE_KEY = 'leave-system-login-notice'

function takeLoginNotice() {
  try {
    const key = sessionStorage.getItem(LOGIN_NOTICE_KEY)
    sessionStorage.removeItem(LOGIN_NOTICE_KEY)
    return key
  } catch {
    return null
  }
}

/**
 * 登入頁：「品牌紅」版（使用者從 5 種風格裡挑的第 3 款）。
 *
 * 整片品牌紅底、淡淡的 IDA 字形壓在背景、白色卡片放表單。登入頁是公司的門面，
 * 刻意不跟著系統的深色模式變色 —— 顏色全部寫死在 Login.css，不用系統的 token。
 */
function Login() {
  const { t } = useLanguage()
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBERED_EMAIL_KEY) || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(() => { const key = takeLoginNotice(); return key ? t(key) : '' })
  const [showPassword, setShowPassword] = useState(false)
  // 上次有記住 email 的話，勾選框預設就是勾起來的，跟畫面上帶出來的 email 一致
  const [remember, setRemember] = useState(() => !!localStorage.getItem(REMEMBERED_EMAIL_KEY))

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      // 停用的帳號在後台被封鎖登入，Supabase 回 user_banned —— 要講清楚是「停用」，
      // 不然本人會以為密碼打錯一直重試。
      setError(error.code === 'user_banned' ? t('login_disabled') : t('login_error'))
      setLoading(false)
      return
    }

    // 登入成功才記 —— 打錯的 email 記下來只會讓下次更難登入
    if (remember) localStorage.setItem(REMEMBERED_EMAIL_KEY, email)
    else localStorage.removeItem(REMEMBERED_EMAIL_KEY)
  }

  return (
    <div className="login-page">
      <img className="login-page__mark" src="/ida-icon-white.png" alt="" aria-hidden="true" width="900" height="327" />

      <header className="login-page__header">
        <img className="login-page__logo" src="/ida-logo-horizontal-white.png" alt="iDA Workplace" width="2400" height="187" />
        <span className="login-page__eyebrow">Management Portal</span>
      </header>

      <main className="login-page__main">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="login-card__heading">
            <h1 className="login-card__title">{t('login_title')}</h1>
            <p className="login-card__subtitle">{t('login_subtitle')}</p>
          </div>

          {error && <div className="login-card__error" role="alert">{error}</div>}

          <div className="login-card__fields">
            <div className="login-card__field">
              <label htmlFor="login-email">{t('login_email')}</label>
              <input
                id="login-email"
                className="login-card__input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder={t('login_email_placeholder')}
              />
            </div>

            <div className="login-card__field">
              <label htmlFor="login-password">{t('login_password')}</label>
              <div className="login-card__input login-card__input--password">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder={t('login_password_placeholder')}
                />
                <button
                  type="button"
                  className="login-card__toggle-password"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? t('login_hide') : t('login_show')}
                </button>
              </div>
            </div>

            <label className="login-card__remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
              />
              <span>{t('login_remember_me')}</span>
            </label>
          </div>

          <button type="submit" className="login-card__submit" disabled={loading}>
            {loading ? t('login_submitting') : t('login_submit')}
          </button>

          <p className="login-card__help">{t('login_forgot')}</p>
        </form>
      </main>

      <footer className="login-page__footer">© iDA Workplace</footer>
    </div>
  )
}

export default Login
