import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, EmptyState, Select, Textarea, TextField } from '../components/ui'
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

function formatDuration(totalHours) {
  if (totalHours === 0) return '0'
  const days = Math.floor(totalHours / 8)
  const hours = totalHours % 8
  if (days > 0 && hours > 0) return `${days} 天 ${hours} 小時`
  if (days > 0) return `${days} 天`
  return `${hours} 小時`
}

function LeaveForm({ userProfile }) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [leaveTypes, setLeaveTypes] = useState([])
  const [annualLeave, setAnnualLeave] = useState(null)
  const [flowSteps, setFlowSteps] = useState([])
  const [colleagues, setColleagues] = useState([])
  const [leaveStats, setLeaveStats] = useState([])
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
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

    if (!data) return

    const statsMap = {}
    for (const leave of data) {
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
      const remainingDays = entitledDays - usedDays
      setAnnualLeave({
        entitled: entitledDays,
        used: usedDays,
        remaining: remainingDays,
        serviceYears: summary.service_years || 0,
        serviceMonths: summary.service_months || 0,
        serviceDays: summary.service_days || 0
      })
    }
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
        status: 'pending',
        current_step: 1
      })
      .select()
      .single()

    if (error) {
      showToast('送出失敗，請稍後再試', { tone: 'error' })
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

    setSuccess(true)
    setLoading(false)
  }

  if (success) return (
    <Card className="leave-form-success">
      <EmptyState
        icon="✅"
        title="假單已送出！"
        description="已通知審核人，請等候審核結果。"
        action={(
          <div className="leave-form-success__actions">
            <Button onClick={() => {
              setSuccess(false)
              setForm({ leave_type_id: '', start_date: '', end_date: '', start_time: '09:00', end_time: '18:00', proxy_user_id: '', reason: '' })
              fetchLeaveStats()
            }}>再請一張</Button>
            <Button variant="tonal" onClick={() => navigate('/leave/my')}>查看我的假單</Button>
          </div>
        )}
      />
    </Card>
  )

  return (
    <div className="leave-form-page">
      <h2 className="leave-form-title">申請請假</h2>

      <Card className="leave-form-stats">
        <div className="leave-form-stats__heading">📊 {new Date().getFullYear()} 年請假統計</div>
        {annualLeave && (
          <div className="leave-form-stats__summary">
            <div>年資：<strong>
              {annualLeave.serviceYears > 0 ? `${annualLeave.serviceYears}年` : ''}
              {annualLeave.serviceMonths > 0 ? `${annualLeave.serviceMonths}個月` : ''}
              {annualLeave.serviceDays > 0 ? `${annualLeave.serviceDays}天` : ''}
              {annualLeave.serviceYears === 0 && annualLeave.serviceMonths === 0 && annualLeave.serviceDays === 0 ? '未滿1天' : ''}
            </strong></div>
            <div>今年特休：<strong>{annualLeave.entitled} 天</strong></div>
            <div>已使用：<strong>{annualLeave.used} 天</strong></div>
            <div className={annualLeave.remaining <= 0 ? 'leave-form-stats__remaining--low' : 'leave-form-stats__remaining'}>
              剩餘：<strong>{annualLeave.remaining} 天</strong>
            </div>
          </div>
        )}
        {leaveStats.length === 0 ? (
          <p className="leave-form-stats__empty">今年尚無請假記錄</p>
        ) : (
          <div className="leave-form-stats__grid">
            {leaveStats.map(stat => (
              <div key={stat.name} className="leave-form-stats__tile" style={{ borderColor: stat.color, color: stat.color }}>
                <div className="leave-form-stats__tile-label" style={{ color: stat.color }}>{stat.name}</div>
                <div className="leave-form-stats__tile-value">{formatDuration(stat.totalHours)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="leave-form-card">
        <form onSubmit={handleSubmit}>
          <TextField label="申請人" value={userProfile?.full_name || ''} disabled />

          {flowSteps.length > 0 && (
            <div className="leave-form-flow">
              <span className="leave-form-flow__label">審核流程</span>
              <div className="leave-form-flow__steps">
                {flowSteps.map((step, i) => (
                  <span key={step.step_order} className="leave-form-flow__step">
                    {i > 0 && <span className="leave-form-flow__arrow">→</span>}
                    <Chip tone="info">第{step.step_order}關：{step.approver?.full_name}</Chip>
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
            <option value="">請選擇假別</option>
            {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
          </Select>

          <div className="leave-form-row">
            <TextField
              label="開始日期"
              required
              type="date"
              value={form.start_date}
              onChange={e => setForm(prev => ({ ...prev, start_date: e.target.value }))}
            />
            <TextField
              label="結束日期"
              required
              type="date"
              value={form.end_date}
              min={form.start_date}
              onChange={e => setForm(prev => ({ ...prev, end_date: e.target.value }))}
            />
          </div>

          {!isMultiDay && form.start_date && (
            <div className="leave-form-time">
              <span className="leave-form-flow__label">請假時段</span>
              <div className="leave-form-time__row">
                <Select value={form.start_time} onChange={e => setForm(prev => ({ ...prev, start_time: e.target.value }))}>
                  {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
                <span className="leave-form-time__sep">～</span>
                <Select value={form.end_time} onChange={e => setForm(prev => ({ ...prev, end_time: e.target.value }))}>
                  {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
              </div>
              {hours > 0 && (
                <div className="leave-form-hours">
                  🕐 請假時數：{hours} 小時
                  {form.start_time < '13:00' && form.end_time > '12:00' && (
                    <span className="leave-form-hours__note">（已扣除午休 1 小時）</span>
                  )}
                </div>
              )}
              {hours === 0 && form.end_time <= form.start_time && (
                <div className="leave-form-error-banner">⚠️ 結束時間不能早於或等於開始時間</div>
              )}
            </div>
          )}

          {isMultiDay && <div className="leave-form-hours">📅 跨天請假（整天）</div>}

          <Select
            label="工作代理人"
            helper="請假期間由此人代理您的工作事務"
            value={form.proxy_user_id}
            onChange={e => setForm(prev => ({ ...prev, proxy_user_id: e.target.value }))}
          >
            <option value="">請選擇代理人（選填）</option>
            {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </Select>

          <Textarea
            label="請假原因"
            required
            rows={4}
            value={form.reason}
            onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))}
            placeholder="請簡述請假原因"
          />

          <Button type="submit" block loading={loading} disabled={!userProfile?.default_flow_id} style={{ marginTop: 'var(--space-100)' }}>
            {loading ? '送出中...' : '送出申請'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

export default LeaveForm
