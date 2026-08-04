import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Dialog, Select, Textarea, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
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

function calcHours(start, end) {
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return 0
  let total = endMin - startMin
  const lunchStart = 12 * 60
  const lunchEnd = 13 * 60
  const overlapStart = Math.max(startMin, lunchStart)
  const overlapEnd = Math.min(endMin, lunchEnd)
  if (overlapEnd > overlapStart) total -= (overlapEnd - overlapStart)
  return Math.max(0, total / 60)
}

function countWorkdays(startDate, endDate) {
  let count = 0
  const start = new Date(startDate)
  const end = new Date(endDate)
  const current = new Date(start)
  while (current <= end) {
    const day = current.getDay()
    if (day !== 0 && day !== 6) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

function initials(name) {
  return name ? name.trim().slice(0, 1).toUpperCase() : '?'
}

function LeaveForm({ userProfile }) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const fileInputRef = useRef(null)

  const [leaveTypes, setLeaveTypes] = useState([])
  const [annualLeave, setAnnualLeave] = useState(null)
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
      .select(`*, leave_type:leave_types(name, color)`)
      .eq('requester_id', userProfile.id)
      .eq('status', 'approved')
      .gte('start_date', `${year}-01-01`)
      .lte('start_date', `${year}-12-31`)

    const statsMap = {}
    for (const leave of data || []) {
      const typeName = leave.leave_type?.name || '其他'
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
  }

  async function handleFileSelected(file) {
    if (!file) return
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      showToast(`檔案超過 ${MAX_ATTACHMENT_MB}MB，請重新選擇`, { tone: 'error' })
      return
    }
    setUploading(true)
    const path = `${userProfile.id}/${Date.now()}-${file.name}`
    const { error } = await supabase.storage.from('leave-attachments').upload(path, file)
    if (error) {
      showToast('附件上傳失敗：' + error.message, { tone: 'error' })
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
      showToast('請填寫所有欄位', { tone: 'error' }); return
    }
    if (form.end_date < form.start_date) {
      showToast('結束日期不能早於開始日期', { tone: 'error' }); return
    }
    if (!isMultiDay && form.end_time <= form.start_time) {
      showToast('結束時間不能早於或等於開始時間', { tone: 'error' }); return
    }
    if (!isMultiDay && hours === 0) {
      showToast('請假時數不能為 0', { tone: 'error' }); return
    }
    if (!userProfile.default_flow_id) {
      showToast('您尚未被指定審核流程，請聯繫管理員設定', { tone: 'error' }); return
    }

    setLoading(true)

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
      showToast('送出失敗：' + error.message, { tone: 'error' })
      setLoading(false)
      return
    }

    const { data: steps } = await supabase
      .from('approval_flow_steps')
      .select('id')
      .eq('flow_id', userProfile.default_flow_id)

    if (!steps || steps.length === 0) {
      await supabase.from('leave_requests').update({ status: 'approved' }).eq('id', data.id)
    } else {
      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'new_request', request_id: data.id }
      })
    }

    setLoading(false)

    const leaveTypeName = leaveTypes.find(lt => lt.id === form.leave_type_id)?.name || ''
    const dateLabel = isMultiDay
      ? `${form.start_date} ～ ${form.end_date}`
      : `${form.start_date} ${form.start_time} ～ ${form.end_time}`
    const hoursLabel = isMultiDay ? `${countWorkdays(form.start_date, form.end_date)} 天` : `${hours} 小時`

    setSuccessInfo({ leaveTypeName, dateLabel, hoursLabel })
  }

  const balanceRows = leaveTypes.map(lt => {
    const isAnnual = lt.name.includes('特休')
    if (isAnnual) {
      const usedHours = (annualLeave?.used || 0) * 8
      const totalHours = (annualLeave?.entitled || 0) * 8
      return { id: lt.id, name: lt.name, color: lt.color, used: usedHours, total: totalHours }
    }
    const stat = leaveStats.find(s => s.name === lt.name)
    return { id: lt.id, name: lt.name, color: lt.color, used: stat?.totalHours || 0, total: lt.annual_quota_hours ?? null }
  })

  return (
    <>
    <div className="leave-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) navigate(-1) }}>
      <div className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-modal-title">
        <div className="leave-modal__header">
          <h2 className="leave-modal__title" id="leave-modal-title">新增請假申請</h2>
          <button type="button" className="leave-modal__close" onClick={() => navigate(-1)} aria-label="關閉">✕</button>
        </div>

        <div className="leave-modal__body">
          <form className="leave-modal__form" onSubmit={handleSubmit} id="leave-form">
            {flowSteps.length > 0 && (
              <div className="leave-modal__field">
                <span className="leave-modal__field-label leave-modal__field-label--center">審核流程</span>
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
              <div className="leave-form-warning">⚠️ 您尚未被指定審核流程，請聯繫管理員設定後再送出假單。</div>
            )}

            <Select
              label="假別"
              required
              value={form.leave_type_id}
              onChange={e => setForm(prev => ({ ...prev, leave_type_id: e.target.value }))}
            >
              <option value="">請選擇假別...</option>
              {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </Select>

            <div className="leave-modal__row">
              <div className="leave-modal__datetime">
                <span className="leave-modal__field-label">開始時間 *</span>
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
                <span className="leave-modal__field-label">結束時間 *</span>
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
                🕐 請假時數：{hours} 小時
                {form.start_time < '13:00' && form.end_time > '12:00' && (
                  <span className="leave-form-hours__note">（已扣除午休 1 小時）</span>
                )}
              </div>
            )}
            {!isMultiDay && hours === 0 && form.end_time <= form.start_time && (
              <div className="leave-form-error-banner">⚠️ 結束時間不能早於或等於開始時間</div>
            )}
            {isMultiDay && <div className="leave-form-hours">📅 跨天請假（整天）</div>}

            <Textarea
              label="請假原因"
              required
              rows={4}
              value={form.reason}
              onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))}
              placeholder="請詳細說明請假原因..."
            />

            <Select
              label="職務代理人（選填）"
              value={form.proxy_user_id}
              onChange={e => setForm(prev => ({ ...prev, proxy_user_id: e.target.value }))}
            >
              <option value="">請選擇職務代理人...</option>
              {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </Select>

            <div className="leave-modal__field">
              <span className="leave-modal__field-label leave-modal__field-label--center">
                附件上傳（選填，JPG／PNG／PDF）
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
                  <p>上傳中...</p>
                ) : attachment ? (
                  <div className="leave-modal__attachment">
                    <span>📎 {attachment.name}</span>
                    <button type="button" onClick={e => { e.stopPropagation(); setAttachment(null) }} aria-label="移除附件">✕</button>
                  </div>
                ) : (
                  <>
                    <div className="leave-modal__dropzone-icon">⬆</div>
                    <p>點擊或拖拽文件至此處上傳</p>
                    <p className="leave-modal__dropzone-hint">支援 JPG、PNG、PDF（最大 {MAX_ATTACHMENT_MB}MB）</p>
                  </>
                )}
              </div>
            </div>
          </form>

          <aside className="leave-modal__sidebar">
            <div className="leave-modal__sidebar-title">
              假期剩餘額度 <span className="leave-modal__sidebar-subtitle">（已使用時數／總時數）</span>
            </div>
            <div className="leave-modal__balance-list">
              {balanceRows.map(row => (
                <div key={row.id} className="leave-modal__balance-row">
                  <span className="leave-modal__balance-dot" style={{ backgroundColor: row.color || 'var(--sys-color-primary)' }} />
                  <span className="leave-modal__balance-name">{row.name}</span>
                  <span className="leave-modal__balance-value">
                    {row.used}/{row.total ?? '—'} 小時
                  </span>
                </div>
              ))}
            </div>

            <div className="leave-modal__notice">
              <div className="leave-modal__notice-title">⚠ 請假須知</div>
              <ul>
                <li>特休請於 3 日前提出申請</li>
                <li>病假超過 2 日需附醫生證明</li>
                <li>請假期間請指定代理人</li>
              </ul>
            </div>
          </aside>
        </div>

        <div className="leave-modal__footer">
          <Button variant="text" onClick={() => navigate(-1)}>取消</Button>
          <Button type="submit" form="leave-form" loading={loading} disabled={!userProfile?.default_flow_id}>
            {loading ? '送出中...' : '提交申請'}
          </Button>
        </div>
      </div>
    </div>

    {successInfo && (
      <Dialog
        title="假單已送出"
        labelledBy="leave-success-title"
        actions={(
          <>
            <Button variant="outlined" onClick={() => navigate('/')}>返回首頁</Button>
            <Button onClick={() => navigate('/leave/my')}>查看申請進度</Button>
          </>
        )}
      >
        <div className="leave-success-rows">
          <div><strong>假別：</strong>{successInfo.leaveTypeName}</div>
          <div><strong>申請日期/時間：</strong>{successInfo.dateLabel}</div>
          <div><strong>申請時數：</strong>{successInfo.hoursLabel}</div>
          <div><strong>審核流程：</strong>{flowSteps.length > 0 ? flowSteps.map(s => s.approver?.full_name).join(' → ') : '無須審核'}</div>
        </div>
      </Dialog>
    )}
    </>
  )
}

export default LeaveForm
