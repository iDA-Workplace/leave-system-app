import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, PageHeader, TextField } from '../components/ui'
import { useTheme } from '../context/ThemeContext'
import './Settings.css'

function ChangePasswordSection() {
  const [form, setForm] = useState({ newPass: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.newPass !== form.confirm) { setMessage('error:新密碼與確認密碼不符'); return }
    if (form.newPass.length < 6) { setMessage('error:密碼長度至少 6 位'); return }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: form.newPass })
    if (error) { setMessage('error:' + error.message) }
    else { setMessage('success:密碼修改成功！'); setForm({ newPass: '', confirm: '' }) }
    setSaving(false)
  }

  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">修改密碼</h3>
      {message && (
        <div className={message.startsWith('error:') ? 'settings-message settings-message--error' : 'settings-message settings-message--success'}>
          {message.replace(/^(error|success):/, '')}
        </div>
      )}
      <form onSubmit={handleSubmit} className="settings-form">
        <TextField
          label="新密碼"
          required
          type="password"
          value={form.newPass}
          onChange={e => setForm(p => ({ ...p, newPass: e.target.value }))}
          placeholder="請輸入新密碼（至少 6 位）"
        />
        <TextField
          label="確認新密碼"
          required
          type="password"
          value={form.confirm}
          onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))}
          placeholder="請再次輸入新密碼"
        />
        <Button type="submit" loading={saving}>{saving ? '修改中...' : '確認修改'}</Button>
      </form>
    </Card>
  )
}

function AppearanceSection() {
  const { mode, setMode } = useTheme()
  const options = [
    { value: 'light', label: '淺色' },
    { value: 'dark', label: '深色' },
    { value: 'system', label: '跟隨系統' },
  ]
  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">外觀</h3>
      <div className="settings-theme-options">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`settings-theme-option${mode === opt.value ? ' settings-theme-option--active' : ''}`}
            onClick={() => setMode(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </Card>
  )
}

function Settings({ userProfile }) {
  return (
    <div className="settings-page">
      <PageHeader title="個人設定" />

      <Card className="settings-section">
        <h3 className="settings-section__title">個人資料</h3>
        <div className="settings-profile-row"><span className="settings-profile-label">姓名</span><span>{userProfile?.full_name}</span></div>
        <div className="settings-profile-row"><span className="settings-profile-label">Email</span><span>{userProfile?.email}</span></div>
        <p className="settings-hint">姓名／Email 由 HR 於員工管理維護，如需異動請聯繫管理員。</p>
      </Card>

      <AppearanceSection />
      <ChangePasswordSection />
    </div>
  )
}

export default Settings
