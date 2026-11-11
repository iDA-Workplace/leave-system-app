import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, PageHeader, Select, Skeleton, TextField } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import { callMassage } from '../../lib/massage'

/**
 * 管理後台 → 員工福利設定。
 *
 * 1. 按摩預約負責人（使用者確認：全公司固定一位）。
 *    負責人只決定「給管理者的通知發給誰」；操作權限仍是管理員與 HR 都可以。
 *    只能選在職的管理員或 HR —— 收到通知卻沒有權限處理，等於沒通知。
 * 2. 按摩通知測試模式（使用者決定：選項 B）。上線前在正式站測試時，按摩的 Slack 訊息
 *    不打擾任何同仁。實際的轉發在 massage-notify；這裡只存開關和測試頻道。
 */
function BenefitsSettings() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [state, setState] = useState({ loading: true, managers: [], ownerId: '', testMode: true, testChannel: '' })
  const [selected, setSelected] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tick, setTick] = useState(0)
  // 測試模式的表單（null = 還沒動過，顯示目前的設定）
  const [testDraft, setTestDraft] = useState(null)
  const [testSaving, setTestSaving] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data: managers }, { data: settings }] = await Promise.all([
        supabase.from('users').select('id, full_name, email')
          .eq('is_active', true).or('is_admin.eq.true,is_finance.eq.true').order('full_name'),
        supabase.from('massage_settings').select('owner_id, test_mode, test_channel').maybeSingle(),
      ])
      if (!cancelled) {
        setState({
          loading: false, managers: managers || [], ownerId: settings?.owner_id || '',
          testMode: settings?.test_mode !== false, testChannel: settings?.test_channel || '',
        })
        setSelected(null)
        setTestDraft(null)
      }
    })()
    return () => { cancelled = true }
  }, [tick])

  const value = selected ?? state.ownerId
  const draft = testDraft ?? { on: state.testMode, channel: state.testChannel }
  const testChanged = draft.on !== state.testMode || draft.channel.trim().toUpperCase() !== state.testChannel

  async function save() {
    setSaving(true)
    const res = await callMassage('massage_set_owner', { p_user_id: value || null })
    setSaving(false)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else showToast(t('benefits_owner_saved'))
    setTick(n => n + 1)
  }

  async function saveTest() {
    setConfirmOff(false)
    setTestSaving(true)
    const res = await callMassage('massage_set_test_mode', { p_on: draft.on, p_channel: draft.channel.trim() || null })
    setTestSaving(false)
    if (!res.ok) { showToast(t(res.errorKey), { tone: 'error' }); return }
    showToast(t(draft.on ? 'benefits_test_saved_on' : 'benefits_test_saved_off'))
    setTick(n => n + 1)
  }

  // 從「測試中」改成「正式運作」要再確認一次：關掉之後就會真的通知到同仁
  function onSaveTest() {
    if (state.testMode && !draft.on) setConfirmOff(true)
    else saveTest()
  }

  return (
    <div>
      <PageHeader title={t('benefits_settings_title')} />
      <Card>
        <h3 className="massage-card-title">{t('benefits_owner_title')}</h3>
        <p className="admin-hint">{t('benefits_owner_hint')}</p>
        {state.loading ? <Skeleton height="48px" /> : (
          <div className="admin-inline-form">
            <Select value={value} onChange={e => setSelected(e.target.value)} style={{ flex: 1 }} aria-label={t('benefits_owner_title')}>
              <option value="">{t('benefits_owner_none')}</option>
              {state.managers.map(u => <option key={u.id} value={u.id}>{u.full_name}（{u.email}）</option>)}
            </Select>
            <Button loading={saving} disabled={value === state.ownerId} onClick={save}>{t('common_save')}</Button>
          </div>
        )}
      </Card>

      <Card style={{ marginTop: 'var(--space-400, 16px)' }}>
        <h3 className="massage-card-title">
          {t('benefits_test_title')}{' '}
          {!state.loading && (
            <Chip tone={state.testMode ? 'warning' : 'success'}>{t(state.testMode ? 'benefits_test_on' : 'benefits_test_off')}</Chip>
          )}
        </h3>
        <p className="admin-hint">{t('benefits_test_hint')}</p>
        {state.loading ? <Skeleton height="96px" /> : (
          <>
            <label className="admin-checkbox-label">
              <input type="checkbox" checked={draft.on} onChange={e => setTestDraft({ ...draft, on: e.target.checked })} />
              {t('benefits_test_toggle')}
            </label>
            <div className="admin-inline-form">
              <div style={{ flex: 1 }}>
                <TextField
                  label={t('benefits_test_channel')}
                  value={draft.channel}
                  onChange={e => setTestDraft({ ...draft, channel: e.target.value })}
                  placeholder="C0123456789"
                />
              </div>
              <Button loading={testSaving} disabled={!testChanged} onClick={onSaveTest}>{t('common_save')}</Button>
            </div>
            <p className="admin-hint">{t('benefits_test_channel_hint')}</p>
          </>
        )}
      </Card>

      {confirmOff && (
        <ConfirmDialog
          title={t('benefits_test_confirm_off_title')}
          description={t('benefits_test_confirm_off_desc')}
          confirmLabel={t('benefits_test_confirm_off')}
          danger
          loading={testSaving}
          onConfirm={saveTest}
          onCancel={() => setConfirmOff(false)}
        />
      )}
    </div>
  )
}

export default BenefitsSettings
