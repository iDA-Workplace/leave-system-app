import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, TextField } from '../components/ui'
import { useLanguage } from '../context/LanguageContext'
import './Login.css'

function Login() {
  const { t } = useLanguage()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(t('login_error'))
      setLoading(false)
    }
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
