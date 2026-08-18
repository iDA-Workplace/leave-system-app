import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, TextField } from '../components/ui'
import { useLanguage } from '../context/LanguageContext'
import './Login.css'

// 「記住我」只記 email，不記密碼。
//
// 密碼一律留白讓人自己打：這台裝置可能是共用的（公司的公用電腦、借人用的
// 手機），email 被別人看到頂多是知道你的信箱，密碼被自動帶入就等於帳號送人。
// 瀏覽器本身的密碼管理員要不要記是使用者自己的選擇，那有系統層級的保護，
// 跟我們把密碼寫進 localStorage 是兩回事。
const REMEMBERED_EMAIL_KEY = 'leave-system-remembered-email'

function Login() {
  const { t } = useLanguage()
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBERED_EMAIL_KEY) || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  // 上次有記住 email 的話，勾選框預設就是勾起來的，跟畫面上帶出來的 email 一致
  const [remember, setRemember] = useState(() => !!localStorage.getItem(REMEMBERED_EMAIL_KEY))

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(t('login_error'))
      setLoading(false)
      return
    }

    // 登入成功才記 —— 打錯的 email 記下來只會讓下次更難登入
    if (remember) localStorage.setItem(REMEMBERED_EMAIL_KEY, email)
    else localStorage.removeItem(REMEMBERED_EMAIL_KEY)
  }

  return (
    <div className="login-page">
      <Card className="login-card">
        <div className="login-card__brand">
          <img
            className="login-card__logo"
            src="/ida-logo-white.png"
            alt="iDA Workplace"
            width="900"
            height="487"
          />
        </div>

        <div className="login-card__body">
          <h1 className="login-card__title">{t('login_title')}</h1>
          <p className="login-card__subtitle">{t('login_subtitle')}</p>

          {error && <div className="login-card__error" role="alert">{error}</div>}

          <form onSubmit={handleLogin}>
            <TextField
              label={t('login_email')}
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder={t('login_email_placeholder')}
            />

            <div className="login-card__password-field">
              <TextField
                label={t('login_password')}
                type={showPassword ? 'text' : 'password'}
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

            <label className="login-card__remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
              />
              <span>{t('login_remember_me')}</span>
            </label>

            <Button type="submit" block loading={loading} style={{ marginTop: 'var(--space-100)' }}>
              {loading ? t('login_submitting') : t('login_submit')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  )
}

export default Login
