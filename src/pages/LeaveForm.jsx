import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Dialog, Select, Textarea, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import {
  buildBalanceRows, fetchEntitlementOverrides, checkQuota, calcHours, countWorkdays,
  leaveTypeName, errorText,
} from '../lib/leaveEntitlements'
import { useLanguage } from '../context/LanguageContext'
import './LeaveForm.css'

const TIME_OPTIONS = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 30) break
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    TIME_OPTIONS.push(`${hh}:${mm}`)
  }
}

const MAX_ATTACHMENT_MB = 5
const ATTACHMENT_ACCEPT = '.jpg,.jpeg,.png,.pdf'

// calcHours / countWorkdays 已搬到 lib/leaveEntitlements.js 共用 ——
// 送出時的額度檢查與 Slack 版送單都要用同一套算法。

function initials(name) {
  return name ? name.trim().slice(0, 1).toUpperCase() : '?'
}

function LeaveForm({ userProfile }) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { t, lang } = useLanguage()
  const fileInputRef = useRef(null)

  const [leaveTypes, setLeaveTypes] = useState([])
  const [annualLeave, setAnnualLeave] = useState(null)
  const [entitlementOverrides, setEntitlementOverrides] = useState({})
  const [flowSteps, setFlowSteps] = useState([])
  const [colleagues, setColleagues] = useState([])
  const [leaveStats, setLeaveStats] = useState([])
  const [loading, setLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [attachment, setAttachment] = useState(null) // { name, url }
  const [successInfo, setSuccessInfo] = useState(null)
  const [form, setForm] = useState({
    leave_type_id: '',
    start_date: '',
    end_date: '',
    start_time: '09:00',
    end_time: '18:00',
    proxy_user_id: '',
    reason: ''
  })

  const isMultiDay = form.start_date && form.end_date && form.end_date > form.start_date
  const hours = isMultiDay ? null : calcHours(form.start_time, form.end_time)

  useEffect(() => {
    fetchLeaveTypes()
    fetchColleagues()
    fetchLeaveStats()
    if (userProfile?.default_flow_id) fetchFlowSteps(userProfile.default_flow_id)
  }, [userProfile])

  async function fetchLeaveTypes() {
    const { data } = await supabase.from('leave_types').select('*').eq('is_active', true)
    setLeaveTypes(data || [])
  }

  async function fetchFlowSteps(flowId) {
    const { data } = await supabase
      .from('approval_flow_steps')
      .select('step_order, approver:users!approval_flow_steps_approver_id_fkey(full_name)')
      .eq('flow_id', flowId)
      .order('step_order')
    setFlowSteps(data || [])
  }

  async function fetchColleagues() {
    const { data } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('is_active', true)
      .neq('id', userProfile.id)
      .order('full_name')
    setColleagues(data || [])
  }

  async function fetchLeaveStats() {
    const year = new Date().getFullYear()

    const { data } = await supabase
      .from('leave_requests')
      .select(`*, leave_type:leave_types(*)`)
      .eq('requester_id', userProfile.id)
      .eq('status', 'approved')
      .gte('start_date', `${year}-01-01`)
      .lte('start_date', `${year}-12-31`)

    const statsMap = {}
    for (const leave of data || []) {
      const typeName = leave.leave_type?.name || t('common_other')
      const typeColor = leave.leave_type?.color || 'var(--sys-color-primary)'
      if (!statsMap[typeName]) {
        statsMap[typeName] = { name: typeName, color: typeColor, totalHours: 0 }
      }
      if (leave.hours) {
        statsMap[typeName].totalHours += Number(leave.hours)
      } else {
        const workdays = countWorkdays(leave.start_date, leave.end_date)
        statsMap[typeName].totalHours += workdays * 8
      }
    }
    setLeaveStats(Object.values(statsMap))

    const { data: summary } = await supabase
      .from('annual_leave_summary')
      .select('*')
      .eq('user_id', userProfile.id)
      .single()

    if (summary) {
      const usedDays = summary.used_days || 0
      const entitledDays = summary.entitled_days || 0
      setAnnualLeave({ entitled: entitledDays, used: usedDays })
    }
    setEntitlementOverrides(await fetchEntitlementOverrides(userProfile.id))
  }

  async function handleFileSelected(file) {
    if (!file) return
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      showToast(t('leaveform_err_file_size', { mb: MAX_ATTACHMENT_MB }), { tone: 'error' })
      return
    }
    setUploading(true)
    const path = `${userProfile.id}/${Date.now()}-${file.name}`
    const { error } = await supabase.storage.from('leave-attachments').upload(path, file)
    if (error) {
      showToast(t('leaveform_err_upload', { msg: error.message }), { tone: 'error' })
      setUploading(false)
      return
    }
    const { data } = supabase.storage.from('leave-attachments').getPublicUrl(path)
    setAttachment({ name: file.name, url: data.publicUrl })
    setUploading(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragActive(false)
    handleFileSelected(e.dataTransfer.files?.[0])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.leave_type_id || !form.start_date || !form.end_date || !form.reason) {
      showToast(t('leaveform_err_required'), { tone: 'error' }); return
    }
    if (form.end_date < form.start_date) {
      showToast(t('leaveform_err_date_order'), { tone: 'error' }); return
    }
    if (!isMultiDay && form.end_time <= form.start_time) {
      showToast(t('leaveform_time_order_error'), { tone: 'error' }); return
    }
    if (!isMultiDay && hours === 0) {
      showToast(t('leaveform_err_zero_hours'), { tone: 'error' }); return
    }
    if (!userProfile.default_flow_id) {
      showToast(t('leaveform_err_no_flow'), { tone: 'error' }); return
    }

    setLoading(true)

    // 額度檢查。刻意放在 insert 之前而且擋死 —— 沒有額度就是不能送出。
    // 計算時把「審核中」的假單也算進去，否則同一個人可以連送好幾張各自都
    // 剛好卡在額度內的假單，等全部核准就超額。
    const selectedType = leaveTypes.find(lt => lt.id === form.leave_type_id)
    const requestedHours = isMultiDay
      ? countWorkdays(form.start_date, form.end_date) * 8
      : hours
    if (selectedType) {
      try {
        const quota = await checkQuota({
          userId: userProfile.id,
          leaveType: selectedType,
          requestedHours,
          lang,
        })
        if (!quota.ok) {
          showToast(t(quota.i18nKey, quota.i18nParams), { tone: 'error' })
          setLoading(false)
          return
        }
      } catch (err) {
        showToast(errorText(err, t), { tone: 'error' })
        setLoading(false)
        return
      }
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        requester_id: userProfile.id,
        leave_type_id: form.leave_type_id,
        flow_id: userProfile.default_flow_id,
        start_date: form.start_date,
        end_date: form.end_date,
        start_time: isMultiDay ? '09:00' : form.start_time,
        end_time: isMultiDay ? '18:00' : form.end_time,
        hours: isMultiDay ? null : hours,
        proxy_user_id: form.proxy_user_id || null,
        reason: form.reason,
        attachment_url: attachment?.url || null,
        attachment_name: attachment?.name || null,
        status: 'pending',
        current_step: 1
      })
      .select()
      .single()

    if (error) {
      showToast(t('leaveform_err_submit', { msg: error.message }), { tone: 'error' })
      setLoading(false)
      return
    }

    const { data: steps } = await supabase
      .from('approval_flow_steps')
      .select('id')
      .eq('flow_id', userProfile.default_flow_id)

    if (!steps || steps.length === 0) {
      // 沒有簽核關卡＝不需審核（目前只有老闆是這種設定）。這裡一樣要送出
      // 「已核准」通知，否則這種員工當天臨時請假時，頻道上不會有任何人知道，
      // 職務代理人也收不到通知。
      await supabase.from('leave_requests').update({ status: 'approved' }).eq('id', data.id)
      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'approved', request_id: data.id }
      })
    } else {
      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'new_request', request_id: data.id }
      })
    }

    setLoading(false)

    const typeLabel = leaveTypeName(leaveTypes.find(lt => lt.id === form.leave_type_id), lang)
    const dateLabel = isMultiDay
      ? `${form.start_date} ~ ${form.end_date}`
      : `${form.start_date} ${form.start_time} ~ ${form.end_time}`
    const hoursLabel = isMultiDay
      ? t('common_days', { n: countWorkdays(form.start_date, form.end_date) })
      : t('common_hours', { n: hours })

    setSuccessInfo({ typeLabel, dateLabel, hoursLabel })
  }

  const balanceRows = buildBalanceRows({ leaveTypes, leaveStats, annualLeave, overrides: entitlementOverrides })

  return (
    <>
    <div className="leave-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) navigate(-1) }}>
      <div className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-modal-title">
        <div className="leave-modal__header">
          <h2 className="leave-modal__title" id="leave-modal-title">{t('leaveform_title')}</h2>
          <button type="button" className="leave-modal__close" onClick={() => navigate(-1)} aria-label={t('common_close')}>✕</button>
        </div>

        <div className="leave-modal__body">
          <form className="leave-modal__form" onSubmit={handleSubmit} id="leave-form">
            {flowSteps.length > 0 && (
              <div className="leave-modal__field">
                <span className="leave-modal__field-label leave-modal__field-label--center">{t('leaveform_flow')}</span>
                <div className="leave-modal__flow-pills">
                  {flowSteps.map((step, i) => (
                    <span key={step.step_order} className="leave-modal__flow-pill-wrap">
                      {i > 0 && <span className="leave-modal__flow-arrow">→</span>}
                      <span className="leave-modal__flow-pill">
                        <span className="leave-modal__flow-avatar">{initials(step.approver?.full_name)}</span>
                        {step.approver?.full_name}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!userProfile?.default_flow_id && (
              <div className="leave-form-warning">{t('leaveform_no_flow_warning')}</div>
            )}

            <Select
              label={t('field_leave_type')}
              required
              value={form.leave_type_id}
              onChange={e => setForm(prev => ({ ...prev, leave_type_id: e.target.value }))}
            >
              <option value="">{t('leaveform_select_type')}</option>
              {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{leaveTypeName(lt, lang)}</option>)}
            </Select>

            <div className="leave-modal__row">
              <div className="leave-modal__datetime">
                <span className="leave-modal__field-label">{t('leaveform_start')} *</span>
                <div className="leave-modal__datetime-row">
                  <input
                    type="date"
                    className="ui-field__control"
                    value={form.start_date}
                    onChange={e => setForm(prev => ({ ...prev, start_date: e.target.value }))}
                    required
                  />
                  <select
                    className="ui-field__control"
                    value={form.start_time}
                    disabled={isMultiDay}
                    onChange={e => setForm(prev => ({ ...prev, start_time: e.target.value }))}
                  >
                    {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div className="leave-modal__datetime">
                <span className="leave-modal__field-label">{t('leaveform_end')} *</span>
                <div className="leave-modal__datetime-row">
                  <input
                    type="date"
                    className="ui-field__control"
                    value={form.end_date}
                    min={form.start_date}
                    onChange={e => setForm(prev => ({ ...prev, end_date: e.target.value }))}
                    required
                  />
                  <select
                    className="ui-field__control"
                    value={form.end_time}
                    disabled={isMultiDay}
                    onChange={e => setForm(prev => ({ ...prev, end_time: e.target.value }))}
                  >
                    {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {!isMultiDay && hours > 0 && (
              <div className="leave-form-hours">
                {t('leaveform_hours_note', { n: hours })}
                {form.start_time < '13:00' && form.end_time > '12:00' && (
                  <span className="leave-form-hours__note">{t('leaveform_lunch_note')}</span>
                )}
              </div>
            )}
            {!isMultiDay && hours === 0 && form.end_time <= form.start_time && (
              <div className="leave-form-error-banner">⚠️ {t('leaveform_time_order_error')}</div>
            )}
            {isMultiDay && <div className="leave-form-hours">{t('leaveform_multiday')}</div>}

            <Textarea
              label={t('field_reason')}
              required
              rows={4}
              value={form.reason}
              onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))}
              placeholder={t('leaveform_reason_placeholder')}
            />

            <Select
              label={t('leaveform_proxy_optional')}
              value={form.proxy_user_id}
              onChange={e => setForm(prev => ({ ...prev, proxy_user_id: e.target.value }))}
            >
              <option value="">{t('leaveform_select_proxy')}</option>
              {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </Select>

            <div className="leave-modal__field">
              <span className="leave-modal__field-label leave-modal__field-label--center">
                {t('leaveform_attachment_label')}
              </span>
              <div
                className={`leave-modal__dropzone${dragActive ? ' leave-modal__dropzone--active' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  className="leave-modal__dropzone-input"
                  onChange={e => handleFileSelected(e.target.files?.[0])}
                />
                {uploading ? (
                  <p>{t('leaveform_uploading')}</p>
                ) : attachment ? (
                  <div className="leave-modal__attachment">
                    <span>📎 {attachment.name}</span>
                    <button type="button" onClick={e => { e.stopPropagation(); setAttachment(null) }} aria-label={t('leaveform_remove_attachment')}>✕</button>
                  </div>
                ) : (
                  <>
                    <div className="leave-modal__dropzone-icon">⬆</div>
                    <p>{t('leaveform_dropzone')}</p>
                    <p className="leave-modal__dropzone-hint">{t('leaveform_dropzone_hint', { mb: MAX_ATTACHMENT_MB })}</p>
                  </>
                )}
              </div>
            </div>
          </form>

          <aside className="leave-modal__sidebar">
            <div className="leave-modal__sidebar-title">
              {t('leaveform_balance_title')} <span className="leave-modal__sidebar-subtitle">{t('leaveform_balance_subtitle')}</span>
            </div>
            <div className="leave-modal__balance-list">
              {balanceRows.map(row => (
                <div key={row.id} className="leave-modal__balance-row">
                  <span className="leave-modal__balance-dot" style={{ backgroundColor: row.color || 'var(--sys-color-primary)' }} />
                  <span className="leave-modal__balance-name">{leaveTypeName(row, lang)}</span>
                  <span className="leave-modal__balance-value">
                    {t('common_hours', { n: `${row.used}/${row.total ?? '—'}` })}
                  </span>
                </div>
              ))}
            </div>

            <div className="leave-modal__notice">
              <div className="leave-modal__notice-title">{t('leaveform_notice_title')}</div>
              <ul>
                <li>{t('leaveform_notice_1')}</li>
                <li>{t('leaveform_notice_2')}</li>
                <li>{t('leaveform_notice_3')}</li>
              </ul>
            </div>
          </aside>
        </div>

        <div className="leave-modal__footer">
          <Button variant="text" onClick={() => navigate(-1)}>{t('common_cancel')}</Button>
          <Button type="submit" form="leave-form" loading={loading} disabled={!userProfile?.default_flow_id}>
            {loading ? t('leaveform_submitting') : t('leaveform_submit')}
          </Button>
        </div>
      </div>
    </div>

    {successInfo && (
      <Dialog
        title={t('leaveform_success_title')}
        labelledBy="leave-success-title"
        actions={(
          <>
            <Button variant="outlined" onClick={() => navigate('/')}>{t('leaveform_back_home')}</Button>
            <Button onClick={() => navigate('/leave/my')}>{t('leaveform_view_progress')}</Button>
          </>
        )}
      >
        <div className="leave-success-rows">
          <div><strong>{t('field_leave_type')}{t('common_colon')}</strong>{successInfo.typeLabel}</div>
          <div><strong>{t('leaveform_success_datetime')}{t('common_colon')}</strong>{successInfo.dateLabel}</div>
          <div><strong>{t('leaveform_success_hours')}{t('common_colon')}</strong>{successInfo.hoursLabel}</div>
          <div><strong>{t('leaveform_flow')}{t('common_colon')}</strong>{flowSteps.length > 0 ? flowSteps.map(s => s.approver?.full_name).join(' → ') : t('leaveform_success_no_flow')}</div>
        </div>
      </Dialog>
    )}
    </>
  )
}

export default LeaveForm
