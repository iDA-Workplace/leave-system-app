import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, PageHeader, TextField } from '../components/ui'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import './Settings.css'

function ChangePasswordSection() {
  const { t } = useLanguage()
  const [form, setForm] = useState({ newPass: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.newPass !== form.confirm) { setMessage('error:' + t('settings_password_mismatch')); return }
    if (form.newPass.length < 6) { setMessage('error:' + t('settings_password_too_short')); return }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: form.newPass })
    if (error) { setMessage('error:' + error.message) }
    else { setMessage('success:' + t('settings_password_updated')); setForm({ newPass: '', confirm: '' }) }
    setSaving(false)
  }

  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_change_password')}</h3>
      {message && (
        <div className={message.startsWith('error:') ? 'settings-message settings-message--error' : 'settings-message settings-message--success'}>
          {message.replace(/^(error|success):/, '')}
        </div>
      )}
      <form onSubmit={handleSubmit} className="settings-form">
        <div className="settings-password-field">
          <TextField
            label={t('settings_new_password')}
            required
            type={showNew ? 'text' : 'password'}
            value={form.newPass}
            onChange={e => setForm(p => ({ ...p, newPass: e.target.value }))}
            placeholder={t('settings_new_password_placeholder')}
          />
          <button type="button" className="settings-password-toggle" onClick={() => setShowNew(v => !v)}>
            {showNew ? t('login_hide') : t('login_show')}
          </button>
        </div>
        <div className="settings-password-field">
          <TextField
            label={t('settings_confirm_password')}
            required
            type={showConfirm ? 'text' : 'password'}
            value={form.confirm}
            onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))}
            placeholder={t('settings_confirm_password_placeholder')}
          />
          <button type="button" className="settings-password-toggle" onClick={() => setShowConfirm(v => !v)}>
            {showConfirm ? t('login_hide') : t('login_show')}
          </button>
        </div>
        <Button type="submit" loading={saving}>{saving ? t('settings_updating') : t('settings_confirm_change')}</Button>
      </form>
    </Card>
  )
}

function AppearanceSection() {
  const { mode, setMode } = useTheme()
  const { t } = useLanguage()
  const options = [
    { value: 'light', label: t('theme_light') },
    { value: 'dark', label: t('theme_dark') },
    { value: 'system', label: t('theme_system') },
  ]
  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_appearance')}</h3>
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
  const { t } = useLanguage()
  const [serviceLabel, setServiceLabel] = useState('')
  const [flowName, setFlowName] = useState('')

  useEffect(() => {
    if (!userProfile?.id) return
    supabase.from('annual_leave_summary').select('*').eq('user_id', userProfile.id).single()
      .then(({ data }) => {
        if (!data) return
        const parts = []
        if (data.service_years > 0) parts.push(t('settings_service_years', { n: data.service_years }))
        if (data.service_months > 0) parts.push(t('settings_service_months', { n: data.service_months }))
        if (data.service_days > 0) parts.push(t('settings_service_days', { n: data.service_days }))
        setServiceLabel(parts.join(' ') || t('settings_service_less_than_day'))
      })
    if (userProfile.default_flow_id) {
      supabase.from('approval_flows').select('name').eq('id', userProfile.default_flow_id).single()
        .then(({ data }) => setFlowName(data?.name || ''))
    }
    // t 在 deps 裡：年資字串是在這裡組好才存進 state 的，切語言時要重算。
  }, [userProfile?.id, t])

  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_profile')}</h3>
      <div className="settings-profile-row"><span className="settings-profile-label">{t('settings_name')}</span><span>{userProfile?.full_name}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">{t('settings_email')}</span><span>{userProfile?.email}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">{t('settings_hire_date')}</span><span>{userProfile?.hire_date || '—'}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">{t('settings_service_length')}</span><span>{serviceLabel || '—'}</span></div>
      <div className="settings-profile-row"><span className="settings-profile-label">{t('settings_flow')}</span><span>{flowName || t('settings_flow_unassigned')}</span></div>
      <p className="settings-hint">{t('settings_profile_hint')}</p>
    </Card>
  )
}

function LanguageSection() {
  const { lang, setLang, t } = useLanguage()
  const { showToast } = useToast()
  const options = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ]

  // 畫面本身讀 localStorage（每台裝置可以不一樣），但 Slack 的 Edge Function
  // 讀不到瀏覽器，所以同一個選擇也寫進 users.language。走 set_my_language()
  // 這支 SECURITY DEFINER 函式，因為直接開 users 的 UPDATE policy 等於讓每個
  // 人都能改自己的 role / is_admin —— RLS 沒辦法只鎖某幾個欄位。
  async function choose(value) {
    if (value === lang) return
    setLang(value)
    const { error } = await supabase.rpc('set_my_language', { p_language: value })
    if (error) showToast(error.message, { tone: 'error' })
  }

  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_language')}</h3>
      <div className="settings-theme-options">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`settings-theme-option${lang === opt.value ? ' settings-theme-option--active' : ''}`}
            onClick={() => choose(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="settings-hint">{t('settings_language_hint')}</p>
    </Card>
  )
}

// 安裝說明本身放在 /install 這個獨立網址，這裡只是入口 —— 那頁要能直接貼到
// Slack 給全公司，網址得是乾淨的一頁，不能藏在個人設定的某個折疊區塊裡。
function InstallSection() {
  const { t } = useLanguage()
  return (
    <Card className="settings-section">
      <h3 className="settings-section__title">{t('settings_install_title')}</h3>
      <p className="settings-install-body">{t('settings_install_body')}</p>
      <Link to="/install" className="settings-install-link">{t('settings_install_link')}</Link>
    </Card>
  )
}

function Settings({ userProfile }) {
  const { t } = useLanguage()
  return (
    <div className="settings-page">
      <PageHeader title={t('nav_settings')} />

      <ProfileSection userProfile={userProfile} />
      <InstallSection />
      <AppearanceSection />
      <LanguageSection />
      <ChangePasswordSection />
    </div>
  )
}

export default Settings
