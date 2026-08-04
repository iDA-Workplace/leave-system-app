import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, PageHeader, TextField } from '../components/ui'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import './Settings.css'

function ChangePasswordSection() {
  const [form, setForm] = useState({ newPass: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

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
        <div className="settings-password-field">
          <TextField
            label="新密碼"
            required
            type={showNew ? 'text' : 'password'}
            value={form.newPass}
            onChange={e => setForm(p => ({ ...p, newPass: e.target.value }))}
            placeholder="請輸入新密碼（至少 6 位）"
          />
          <button type="button" className="settings-password-toggle" onClick={() => setShowNew(v => !v)}>
            {showNew ? '隱藏' : '顯示'}
          </button>
        </div>
        <div className="settings-password-field">
          <TextField
            label="確認新密碼"
            required
            type={showConfirm ? 'text' : 'password'}
            value={form.confirm}
            onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))}
            placeholder="請再次輸入新密碼"
          />
          <button type="button" className="settings-password-toggle" onClick={() => setShowConfirm(v => !v)}>
            {showConfirm ? '隱藏' : '顯示'}
          </button>
        </div>
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

function ProfileSection({ userProfile }) {
  const [serviceLabel, setServiceLabel] = useState('')
  const [flowName, setFlowName] = useState('')

  useEffect(() => {
    if (!userProfile?.id) return
    supabase.from('annual_leave_summary').select('*').eq('user_id', userProfile.id).single()
      .then(({ data }) => {
        if (!data) return
        const parts = []
        if (data.service_years > 0) parts.push(`${data.service_years}年`)
        if (data.service_months > 0) parts.push(`${data.service_months}個月`)
        if (data.service_days > 0) parts.push(`${data.service_days}天`)
        setServiceLabel(parts.join('') || '未滿 1 天')
      })
    if (userProfile.default_flow_id) {
      supabase.from('approval_flows').select('name').eq('id', userProfile.default_flow_id).single()
        .then(({ data }) => setFlowName(data?.name || ''))
    }
  }, [])

  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">個人資料</h3>
      <div className="settings-profile-row"><span className="settings-profile-label">姓名</span><span>{userProfile?.full_name}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">Email</span><span>{userProfile?.email}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">入職日</span><span>{userProfile?.hire_date || '—'}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">年資</span><span>{serviceLabel || '—'}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">審核流程</span><span>{flowName || '未指定'}</span></div>
      <p className="settings-hint">個人資料由 HR 於員工管理維護，如需異動請聯繫管理員。</p>
    </Card>
  )
}

function LanguageSection() {
  const { lang, setLang, t } = useLanguage()
  const options = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ]
  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_language')}</h3>
      <div className="settings-theme-options">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`settings-theme-option${lang === opt.value ? ' settings-theme-option--active' : ''}`}
            onClick={() => setLang(opt.value)}
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

      <ProfileSection userProfile={userProfile} />
      <AppearanceSection />
      <LanguageSection />
      <ChangePasswordSection />
    </div>
  )
}

export default Settings
