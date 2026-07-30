import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, Skeleton, Textarea } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './Home.css'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'admin', 'boss']
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function StatCard({ icon, title, value, valueTone, unit, caption, progress }) {
  return (
    <Card className="dash-stat-card">
      <div className="dash-stat-card__header">
        <span className="dash-stat-card__title">{title}</span>
        <span className="dash-stat-card__icon">{icon}</span>
      </div>
      <div className="dash-stat-card__value-row">
        <span className={`dash-stat-card__value${valueTone ? ` dash-stat-card__value--${valueTone}` : ''}`}>{value}</span>
        {unit && <span className="dash-stat-card__unit">{unit}</span>}
      </div>
      <div className="dash-stat-card__progress-track">
        <div className="dash-stat-card__progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
      </div>
      {caption && <div className="dash-stat-card__caption">{caption}</div>}
    </Card>
  )
}

function Home({ userProfile }) {
  const isApprover = APPROVER_ROLES.includes(userProfile?.role)
  const { showToast } = useToast()

  const [annualLeave, setAnnualLeave] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  const [myPendingCount, setMyPendingCount] = useState(0)
  const [approvalQueue, setApprovalQueue] = useState([])
  const [approvalLoading, setApprovalLoading] = useState(true)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actingId, setActingId] = useState(null)

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [monthLeaveDates, setMonthLeaveDates] = useState(new Set())
  const [calendarLoading, setCalendarLoading] = useState(true)

  useEffect(() => { fetchEntitlement() }, [userProfile])
  useEffect(() => {
    if (isApprover) fetchApprovalQueue()
    else fetchMyPendingCount()
  }, [userProfile])
  useEffect(() => { fetchMonthLeaveDates() }, [calendarMonth])

  async function fetchEntitlement() {
    if (!userProfile?.id) return
    const { data } = await supabase
      .from('annual_leave_summary')
      .select('*')
      .eq('user_id', userProfile.id)
      .single()
    if (data) {
      setAnnualLeave({
        entitled: data.entitled_days || 0,
        used: data.used_days || 0,
        remaining: (data.entitled_days || 0) - (data.used_days || 0),
      })
    }
    setStatsLoading(false)
  }

  async function fetchMyPendingCount() {
    const { count } = await supabase
      .from('leave_requests')
      .select('id', { count: 'exact', head: true })
      .eq('requester_id', userProfile.id)
      .eq('status', 'pending')
    setMyPendingCount(count || 0)
  }

  async function fetchApprovalQueue() {
    setApprovalLoading(true)
    const today = new Date().toISOString().split('T')[0]

    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    const { data: delegateFor } = await supabase
      .from('approval_delegates')
      .select('original_approver_id')
      .eq('delegate_user_id', userProfile.id)
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)

    const originalApproverIds = delegateFor?.map(d => d.original_approver_id) || []
    let delegateSteps = []
    if (originalApproverIds.length > 0) {
      const { data } = await supabase
        .from('approval_flow_steps')
        .select('flow_id, step_order')
        .in('approver_id', originalApproverIds)
      delegateSteps = data || []
    }

    const allSteps = [...(flowSteps || []), ...delegateSteps]
    if (allSteps.length === 0) { setApprovalQueue([]); setApprovalLoading(false); return }

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(name, color),
        flow:approval_flows(name, steps:approval_flow_steps(*))
      `)
      .eq('status', 'pending')
      .order('start_date')

    const filtered = (data || []).filter(req =>
      allSteps.some(step => step.flow_id === req.flow_id && step.step_order === req.current_step)
    )

    setApprovalQueue(filtered)
    setApprovalLoading(false)
  }

  async function fetchMonthLeaveDates() {
    setCalendarLoading(true)
    const monthStart = toISODate(calendarMonth)
    const monthEndDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0)
    const monthEnd = toISODate(monthEndDate)

    const { data } = await supabase
      .from('leave_requests')
      .select('start_date, end_date')
      .eq('status', 'approved')
      .lte('start_date', monthEnd)
      .gte('end_date', monthStart)

    const dates = new Set()
    for (const leave of data || []) {
      const start = new Date(Math.max(new Date(leave.start_date), new Date(monthStart)))
      const end = new Date(Math.min(new Date(leave.end_date), new Date(monthEnd)))
      const cur = new Date(start)
      while (cur <= end) {
        dates.add(toISODate(cur))
        cur.setDate(cur.getDate() + 1)
      }
    }
    setMonthLeaveDates(dates)
    setCalendarLoading(false)
  }

  async function handleApprove(request) {
    setActingId(request.id)
    await supabase.from('leave_approvals').insert({
      request_id: request.id,
      approver_id: userProfile.id,
      step_order: request.current_step,
      action: 'approved',
    })

    const maxStep = Math.max(...request.flow.steps.map(s => s.step_order))
    if (request.current_step >= maxStep) {
      await supabase.from('leave_requests').update({ status: 'approved' }).eq('id', request.id)
    } else {
      await supabase.from('leave_requests').update({ current_step: request.current_step + 1 }).eq('id', request.id)
    }
    await supabase.functions.invoke('send-slack-notification', {
      body: { type: request.current_step >= maxStep ? 'approved' : 'new_request', request_id: request.id }
    })

    showToast(`已核准 ${request.requester?.full_name} 的請假`)
    setActingId(null)
    fetchApprovalQueue()
  }

  async function handleConfirmReject() {
    if (!rejectReason.trim()) { showToast('請填寫拒絕原因', { tone: 'error' }); return }
    setActingId(rejectTarget.id)
    await supabase.from('leave_approvals').insert({
      request_id: rejectTarget.id,
      approver_id: userProfile.id,
      step_order: rejectTarget.current_step,
      action: 'rejected',
      comment: rejectReason.trim(),
    })
    await supabase.from('leave_requests').update({ status: 'rejected' }).eq('id', rejectTarget.id)
    await supabase.functions.invoke('send-slack-notification', { body: { type: 'rejected', request_id: rejectTarget.id } })

    showToast(`已拒絕 ${rejectTarget.requester?.full_name} 的請假`)
    setActingId(null)
    setRejectTarget(null)
    setRejectReason('')
    fetchApprovalQueue()
  }

  const now = new Date()
  const todayLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${WEEKDAY_LABELS[now.getDay()]}`
  const pendingSentence = isApprover && approvalQueue.length > 0
    ? `您目前有 ${approvalQueue.length} 筆待審核假單。`
    : ''

  const monthGrid = []
  {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1)
    const startOffset = firstOfMonth.getDay()
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate()
    const todayISO = toISODate(now)
    for (let i = 0; i < startOffset; i++) monthGrid.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), d)
      const iso = toISODate(dateObj)
      monthGrid.push({ day: d, iso, isToday: iso === todayISO, hasLeave: monthLeaveDates.has(iso) })
    }
  }

  return (
    <div className="dash">
      <div className="dash-welcome">
        <h1 className="dash-welcome__title">歡迎回來，{userProfile?.full_name?.split(' ')[0] || userProfile?.full_name}</h1>
        <p className="dash-welcome__subtitle">今日是 {todayLabel}。{pendingSentence}</p>
      </div>

      <div className="dash-stats-grid">
        {statsLoading ? <Skeleton height="150px" /> : (
          <StatCard
            icon="📊"
            title="特休假餘額"
            value={annualLeave?.remaining ?? '—'}
            valueTone={annualLeave?.remaining < 0 ? 'negative' : undefined}
            unit={annualLeave ? `天 / 總計 ${annualLeave.entitled} 天` : ''}
            caption={annualLeave ? `已使用 ${annualLeave.used} 天` : '尚無資料'}
            progress={annualLeave?.entitled ? (annualLeave.used / annualLeave.entitled) * 100 : 0}
          />
        )}

        {isApprover ? (
          approvalLoading ? <Skeleton height="150px" /> : (
            <StatCard
              icon="📋"
              title="審核中"
              value={approvalQueue.length}
              unit="件申請"
              caption="需要您的審核"
              progress={Math.min(100, approvalQueue.length * 25)}
            />
          )
        ) : (
          <StatCard
            icon="📋"
            title="我的申請"
            value={myPendingCount}
            unit="件審核中"
            caption="等待審核結果"
            progress={Math.min(100, myPendingCount * 25)}
          />
        )}
      </div>

      {isApprover && (
        <Card className="dash-approval-card">
          <div className="dash-card-header">
            <span className="dash-card-header__title">📋 待審核假單</span>
            <Link to="/approval" className="dash-card-header__link">查看全部</Link>
          </div>
          {approvalLoading ? (
            <Skeleton height="120px" />
          ) : approvalQueue.length === 0 ? (
            <p className="dash-empty-hint">目前沒有待審核的假單 🎉</p>
          ) : (
            <div className="ui-table-wrap">
              <table className="ui-table dash-approval-table">
                <thead>
                  <tr><th>員工姓名</th><th>假別</th><th>請假日期</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {approvalQueue.slice(0, 5).map(req => (
                    <tr key={req.id}>
                      <td>
                        <div className="dash-approval-table__name">
                          <span className="dash-approval-table__avatar">{req.requester?.full_name?.charAt(0)}</span>
                          {req.requester?.full_name}
                        </div>
                      </td>
                      <td><Chip tone="info" style={{ background: (req.leave_type?.color || 'var(--sys-color-primary)') + '22', color: req.leave_type?.color || 'var(--sys-color-primary)' }}>{req.leave_type?.name}</Chip></td>
                      <td>{req.start_date}</td>
                      <td>
                        <div className="dash-approval-table__actions">
                          <Button size="sm" variant="danger-outlined" disabled={actingId === req.id} onClick={() => setRejectTarget(req)} aria-label="拒絕">✕</Button>
                          <Button size="sm" variant="danger" disabled={actingId === req.id} onClick={() => handleApprove(req)} aria-label="核准">✓</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card className="dash-calendar-card">
        <div className="dash-card-header">
          <span className="dash-card-header__title">📅 請假行事曆</span>
          <div className="dash-calendar-nav">
            <button type="button" onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="上個月">‹</button>
            <span>{calendarMonth.getFullYear()}年 {calendarMonth.getMonth() + 1}月</span>
            <button type="button" onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="下個月">›</button>
          </div>
        </div>
        {calendarLoading ? <Skeleton height="260px" /> : (
          <div className="dash-mini-calendar">
            {WEEKDAY_LABELS.map(w => <div key={w} className="dash-mini-calendar__weekday">{w}</div>)}
            {monthGrid.map((cell, i) => (
              <div key={i} className="dash-mini-calendar__cell">
                {cell && (
                  <span className={`dash-mini-calendar__date${cell.isToday ? ' dash-mini-calendar__date--today' : ''}${cell.hasLeave ? ' dash-mini-calendar__date--leave' : ''}`}>
                    {cell.day}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {rejectTarget && (
        <ConfirmDialog
          title={`拒絕 ${rejectTarget.requester?.full_name} 的請假`}
          description={(
            <Textarea
              label="拒絕原因"
              required
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder="請填寫拒絕原因"
            />
          )}
          confirmLabel="拒絕"
          danger
          loading={actingId === rejectTarget.id}
          onConfirm={handleConfirmReject}
          onCancel={() => { setRejectTarget(null); setRejectReason('') }}
        />
      )}
    </div>
  )
}

export default Home
