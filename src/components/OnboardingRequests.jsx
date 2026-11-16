import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'
import { Button, Card, ConfirmDialog, Dialog, Select, TextField } from './ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'

const ASSIGNABLE_ROLES = ['employee', 'supervisor', 'boss']

async function loadPending() {
  const { data } = await supabase.from('onboarding_requests')
    .select('*').eq('status', 'pending').order('submitted_at')
  return data || []
}

/**
 * 員工帳號管理 →「待開通」（2026-11）。
 *
 * 新人加入 Slack 後自己填的資料（姓名、email、職稱、部門，Slack User ID 自動記下）會出現在這裡。
 * 管理員或 HR 補上入職日期、審核流程、直屬主管後按「開通」：manage-users 建立登入帳號
 * （預設密碼）、寫好資料、用 Slack 私訊新人登入方式。填錯或不需要開通的可以「移除」。
 */
export default function OnboardingRequests({ departments, flows, users, onActivated }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [requests, setRequests] = useState([])
  const [form, setForm] = useState(null)        // 開通中的那筆（含要補的欄位）
  const [removing, setRemoving] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    loadPending().then(rows => { if (alive) setRequests(rows) })
    return () => { alive = false }
  }, [])

  const fetchRequests = () => loadPending().then(setRequests)

  function openActivate(r) {
    setForm({
      request_id: r.id, slack_user_id: r.slack_user_id,
      full_name: r.full_name || '', email: r.email || '', job_title: r.job_title || '',
      department: r.department || '', role: 'employee', default_flow_id: '', manager_id: '', hire_date: '',
    })
  }

  function errorText(data, error) {
    const code = data?.error || error?.message || ''
    if (['already_handled', 'slack_taken', 'not_allowed', 'not_found'].includes(code)) return t(`onboard_err_${code}`)
    if (code.startsWith('partial:')) return t('onboard_err_partial', { msg: code.slice(8) })
    return code
  }

  async function handleActivate() {
    if (!form.full_name.trim() || !form.email.trim() || !form.hire_date) {
      showToast(t('onboard_err_required'), { tone: 'error' }); return
    }
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', { action: 'onboard_approve', ...form })
    setSaving(false)
    if (error || data?.error) {
      showToast(t('onboard_err', { msg: errorText(data, error) }), { tone: 'error' })
      if (data?.error?.startsWith?.('partial:')) { setForm(null); fetchRequests(); onActivated?.() }
      return
    }
    showToast(data?.notified
      ? t('onboard_done_notified', { name: form.full_name })
      : t('onboard_done_not_notified', { name: form.full_name }), { tone: data?.notified ? undefined : 'error' })
    setForm(null)
    fetchRequests()
    onActivated?.()
  }

  async function handleRemove() {
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', { action: 'onboard_remove', request_id: removing.id })
    setSaving(false)
    if (error || data?.error) { showToast(t('onboard_err', { msg: errorText(data, error) }), { tone: 'error' }); return }
    showToast(t('onboard_removed', { name: removing.full_name }))
    setRemoving(null)
    fetchRequests()
  }

  if (requests.length === 0) return null

  // 新人選的部門一定要在選單裡（理論上本來就是從現有部門選的）
  const deptOptions = form?.department && !departments.includes(form.department)
    ? [...departments, form.department] : departments
  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <>
      <Card className="onboarding-card">
        <h3 className="onboarding-card__title">{t('onboard_title', { n: requests.length })}</h3>
        <p className="admin-hint">{t('onboard_hint')}</p>
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{t('adminusers_col_name')}</th><th>Email</th><th>{t('adminusers_col_department')}</th>
                <th>{t('adminusers_col_title')}</th><th>Slack ID</th><th>{t('onboard_col_submitted')}</th><th>{t('common_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id}>
                  <td>{r.full_name}</td>
                  <td>{r.email}</td>
                  <td>{r.department || '—'}</td>
                  <td>{r.job_title || '—'}</td>
                  <td>{r.slack_user_id}</td>
                  <td className="tabular">{new Date(r.submitted_at).toLocaleDateString()}</td>
                  <td className="admin-cell-actions" style={{ whiteSpace: 'nowrap' }}>
                    <Button size="sm" onClick={() => openActivate(r)}>{t('onboard_activate')}</Button>{' '}
                    <Button size="sm" variant="text" onClick={() => setRemoving(r)}>{t('onboard_remove')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {form && (
        <Dialog
          title={t('onboard_dialog_title', { name: form.full_name })}
          labelledBy="onboard-dialog-title"
          onClose={() => setForm(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setForm(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleActivate}>{t('onboard_activate')}</Button>
            </>
          )}
        >
          <p className="admin-form-card__hint">{t('onboard_dialog_hint')}</p>
          <div className="admin-form-grid">
            <TextField label={t('adminusers_col_name')} required value={form.full_name} onChange={set('full_name')} />
            <TextField label={t('settings_email')} required value={form.email} onChange={set('email')} />
            <TextField label={t('onboard_hire_date')} type="date" required value={form.hire_date} onChange={set('hire_date')} />
            <Select label={t('adminusers_col_role')} required value={form.role} onChange={set('role')}>
              {ASSIGNABLE_ROLES.map(value => <option key={value} value={value}>{t(`role_${value}`)}</option>)}
            </Select>
            <Select label={t('adminusers_col_flow')} value={form.default_flow_id} onChange={set('default_flow_id')}>
              <option value="">{t('adminusers_select_flow')}</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <Select label={t('adminusers_col_manager')} value={form.manager_id} onChange={set('manager_id')}>
              <option value="">{t('adminusers_unassigned')}</option>
              {users.filter(u => u.is_active).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
            <Select label={t('adminusers_col_department')} value={form.department} onChange={set('department')}>
              <option value="">{t('adminusers_select_department')}</option>
              {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </Select>
            <TextField label={t('adminusers_col_title')} value={form.job_title} onChange={set('job_title')} />
            <TextField label="Slack User ID" value={form.slack_user_id} disabled />
          </div>
        </Dialog>
      )}

      {removing && (
        <ConfirmDialog
          title={t('onboard_remove')}
          description={t('onboard_remove_confirm', { name: removing.full_name })}
          confirmLabel={t('onboard_remove')}
          loading={saving}
          onConfirm={handleRemove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  )
}
