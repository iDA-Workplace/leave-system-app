import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button, Card, PageHeader, Select, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import { callMassage } from '../../lib/massage'

/**
 * 管理後台 → 員工福利設定。
 *
 * 目前只有「按摩預約負責人」一項（使用者確認：全公司固定一位）。
 * 負責人只決定「給管理者的通知發給誰」；操作權限仍是管理員與 HR 都可以。
 * 只能選在職的管理員或 HR —— 收到通知卻沒有權限處理，等於沒通知。
 */
function BenefitsSettings() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [state, setState] = useState({ loading: true, managers: [], ownerId: '' })
  const [selected, setSelected] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data: managers }, { data: settings }] = await Promise.all([
        supabase.from('users').select('id, full_name, email')
          .eq('is_active', true).or('is_admin.eq.true,is_finance.eq.true').order('full_name'),
        supabase.from('massage_settings').select('owner_id').maybeSingle(),
      ])
      if (!cancelled) {
        setState({ loading: false, managers: managers || [], ownerId: settings?.owner_id || '' })
        setSelected(null)
      }
    })()
    return () => { cancelled = true }
  }, [tick])

  const value = selected ?? state.ownerId

  async function save() {
    setSaving(true)
    const res = await callMassage('massage_set_owner', { p_user_id: value || null })
    setSaving(false)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else showToast(t('benefits_owner_saved'))
    setTick(n => n + 1)
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
    </div>
  )
}

export default BenefitsSettings
