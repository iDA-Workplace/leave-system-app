import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, TextField } from '../components/ui'
import './Login.css'

function Login() {
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
      setError('帳號或密碼錯誤，請重新輸入')
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <Card className="login-card">
        <h1 className="login-card__title">請假系統</h1>
        <p className="login-card__subtitle">請登入您的帳號</p>

        {error && <div className="login-card__error" role="alert">{error}</div>}

        <form onSubmit={handleLogin}>
          <TextField
            label="電子郵件"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            placeholder="請輸入電子郵件"
          />

          <div className="login-card__password-field">
            <TextField
              label="密碼"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="請輸入密碼"
            />
            <button
              type="button"
              className="login-card__toggle-password"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? '隱藏' : '顯示'}
            </button>
          </div>

          <Button type="submit" block loading={loading} style={{ marginTop: 'var(--space-100)' }}>
            {loading ? '登入中...' : '登入'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

export default Login
