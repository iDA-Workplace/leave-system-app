import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, Skeleton, Textarea } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './Home.css'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'admin', 'boss']
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const STATUS_MAP = {
  pending: { label: '審核中', tone: 'warning' },
  approved: { label: '已核准', tone: 'success' },
  rejected: { label: '已拒絕', tone: 'error' },
  returned: { label: '已退回', tone: 'neutral' },
  withdrawn: { label: '已收回', tone: 'info' },
}
const AVATAR_PALETTE = ['var(--sys-color-primary)', 'var(--sys-color-tertiary)', 'var(--sys-color-secondary)', 'var(--sys-color-success)']

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function initials(name) {
  return name ? name.trim().charAt(0).toUpperCase() : '?'
}

function avatarColor(id) {
  let hash = 0
  for (const ch of String(id || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
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

function FlowChips({ steps }) {
  if (!steps || steps.length === 0) return null
  return (
    <div className="dash-flow-chips">
      {steps.map((s, i) => (
        <span key={s.step_order} className="dash-flow-chips__item">
          {i > 0 && <span className="dash-flow-chips__arrow">→</span>}
          <span className="dash-flow-chips__name">{s.approver?.full_name}</span>
        </span>
      ))}
    </div>
  )
}

function Home({ userProfile }) {
  const isApprover = APPROVER_ROLES.includes(userProfile?.role)
  const { showToast } = useToast()

  const [annualLeave, setAnnualLeave] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  const [reviewParticipant, setReviewParticipant] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(true)

  const [approvalQueue, setApprovalQueue] = useState([])
  const [myRequests, setMyRequests] = useState([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const [actingId, setActingId] = useState(null)

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [monthLeaveDates, setMonthLeaveDates] = useState(new Set())
  const [todayColleagues, setTodayColleagues] = useState([])
  const [calendarLoading, setCalendarLoading] = useState(true)

  useEffect(() => { fetchEntitlement() }, [userProfile])
  useEffect(() => { fetchReviewParticipant() }, [userProfile])
  useEffect(() => {
    if (isApprover) fetchApprovalQueue()
    else fetchMyRequests()
  }, [userProfile])
  useEffect(() => { fetchMonthLeaveDates() }, [calendarMonth])
  useEffect(() => { fetchTodayColleagues() }, [userProfile])

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

  async function fetchReviewParticipant() {
    if (!userProfile?.id) return
    const { data } = await supabase
      .from('annual_review_participants')
      .select('*, review:annual_reviews(*)')
      .eq('user_id', userProfile.id)
      .order('id', { ascending: false })
    const active = (data || []).find(p => p.review?.status === 'active')
    setReviewParticipant(active || null)
    setReviewLoading(false)
  }

  async function fetchApprovalQueue() {
    setQueueLoading(true)
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
    if (allSteps.length === 0) { setApprovalQueue([]); setQueueLoading(false); return }

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
    setQueueLoading(false)
  }

  async function fetchMyRequests() {
    setQueueLoading(true)
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        leave_type:leave_types(name, color),
        flow:approval_flows(steps:approval_flow_steps(step_order, approver:users!approval_flow_steps_approver_id_fkey(full_name)))
      `)
      .eq('requester_id', userProfile.id)
      .order('created_at', { ascending: false })
      .limit(5)
    setMyRequests(data || [])
    setQueueLoading(false)
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

  async function fetchTodayColleagues() {
    const today = toISODate(new Date())
    const { data } = await supabase
      .from('leave_requests')
      .select('requester:users!leave_requests_requester_id_fkey(id, full_name)')
      .eq('status', 'approved')
      .lte('start_date', today)
      .gte('end_date', today)
    setTodayColleagues((data || []).map(d => d.requester).filter(Boolean))
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

  async function handleConfirmWithdraw() {
    await supabase.from('leave_requests').update({ status: 'withdrawn' }).eq('id', withdrawTarget.id)
    showToast('假單已收回')
    setWithdrawTarget(null)
    fetchMyRequests()
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

  const reviewDeadline = reviewParticipant?.review
    ? (reviewParticipant.review.self_assessment_deadline || reviewParticipant.review.evaluation_deadline || reviewParticipant.review.end_date)
    : null

  return (
    <div className="dash">
      <div className="dash-welcome">
        <h1 className="dash-welcome__title">
          歡迎回來，{userProfile?.full_name}
          {!isApprover && userProfile?.role === 'employee' && <span className="dash-welcome__role"> (一般員工)</span>}
        </h1>
        <p className="dash-welcome__subtitle">今日是 {todayLabel}。{pendingSentence}</p>
      </div>

      {statsLoading ? <Skeleton height="150px" /> : (
        <StatCard
          icon="📊"
          title="特休假餘額 (Annual)"
          value={annualLeave?.remaining ?? '—'}
          valueTone={annualLeave?.remaining < 0 ? 'negative' : undefined}
          unit={annualLeave ? `天 / 總計 ${annualLeave.entitled} 天` : ''}
          caption={annualLeave ? `已使用 ${annualLeave.used} 天` : '尚無資料'}
          progress={annualLeave?.entitled ? (annualLeave.used / annualLeave.entitled) * 100 : 0}
        />
      )}

      {reviewLoading ? <Skeleton height="180px" /> : reviewParticipant && (
        <Card className="dash-review-card">
          <div className="dash-card-header">
            <span className="dash-card-header__title">📈 {reviewParticipant.review.title}</span>
            <span className="dash-review-card__status-badge">
              {reviewParticipant.review.status === 'active' ? '進行中' : '已結束'}
            </span>
          </div>
          <div className="dash-review-card__grid">
            <div className="dash-review-card__tile">
              <div className="dash-review-card__tile-label">📝 自評進度</div>
              <div className="dash-review-card__tile-value">{reviewParticipant.self_submitted ? '已提交' : '待提交'}</div>
              <div className="dash-stat-card__progress-track">
                <div className="dash-stat-card__progress-fill" style={{ width: reviewParticipant.self_submitted ? '100%' : '6%' }} />
              </div>
            </div>
            {reviewDeadline && (
              <div className="dash-review-card__tile">
                <div className="dash-review-card__tile-label">📅 考核提交截止日</div>
                <div className="dash-review-card__tile-value">{reviewDeadline}</div>
              </div>
            )}
          </div>
          <div className="dash-review-card__footer">
            <Link to="/review" className="dash-card-header__link">查看詳細考核表 →</Link>
          </div>
        </Card>
      )}

      {isApprover ? (
        <Card className="dash-approval-card">
          <div className="dash-card-header">
            <span className="dash-card-header__title">📋 待審核假單</span>
            <Link to="/approval" className="dash-card-header__link">查看全部</Link>
          </div>
          {queueLoading ? (
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
                          <span className="dash-approval-table__avatar" style={{ background: avatarColor(req.requester_id) }}>{initials(req.requester?.full_name)}</span>
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
      ) : (
        <Card className="dash-approval-card">
          <div className="dash-card-header">
            <span className="dash-card-header__title">🕐 我的假單申請進度</span>
            <Link to="/leave/my" className="dash-card-header__link">查看歷史紀錄</Link>
          </div>
          {queueLoading ? (
            <Skeleton height="120px" />
          ) : myRequests.length === 0 ? (
            <p className="dash-empty-hint">尚無請假記錄</p>
          ) : (
            <div className="ui-table-wrap">
              <table className="ui-table dash-approval-table">
                <thead>
                  <tr><th>假別</th><th>請假日期</th><th>狀態</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {myRequests.map(req => {
                    const status = STATUS_MAP[req.status] || STATUS_MAP.pending
                    const days = countDaysLabel(req.start_date, req.end_date)
                    return (
                      <tr key={req.id}>
                        <td><Chip tone="info" style={{ background: (req.leave_type?.color || 'var(--sys-color-primary)') + '22', color: req.leave_type?.color || 'var(--sys-color-primary)' }}>{req.leave_type?.name}</Chip></td>
                        <td>{req.start_date}{days}</td>
                        <td>
                          <div className="dash-status-cell">
                            <Chip tone={status.tone}>{status.label}</Chip>
                            <FlowChips steps={req.flow?.steps?.slice().sort((a, b) => a.step_order - b.step_order)} />
                          </div>
                        </td>
                        <td>
                          {req.status === 'pending' ? (
                            <button type="button" className="dash-withdraw-link" onClick={() => setWithdrawTarget(req)}>撤回</button>
                          ) : '-'}
                        </td>
                      </tr>
                    )
                  })}
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
          <>
            <div className="dash-mini-calendar">
              {WEEKDAY_LABELS.map(w => <div key={w} className="dash-mini-calendar__weekday">{w}</div>)}
              {monthGrid.map((cell, i) => (
                <div key={i} className="dash-mini-calendar__cell">
                  {cell && (
                    <span className={`dash-mini-calendar__date${cell.isToday ? ' dash-mini-calendar__date--today' : ''}${cell.hasLeave ? ' dash-mini-calendar__date--leave' : ''}`}>
                      {cell.day}
                      {cell.hasLeave && <span className="dash-mini-calendar__dot" />}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {todayColleagues.length > 0 && (
              <div className="dash-today-colleagues">
                <span className="dash-today-colleagues__label">今日休假同仁：</span>
                <div className="dash-today-colleagues__avatars">
                  {todayColleagues.slice(0, 2).map(c => (
                    <span key={c.id} className="dash-today-colleagues__avatar" style={{ background: avatarColor(c.id) }} title={c.full_name}>
                      {initials(c.full_name)}
                    </span>
                  ))}
                  {todayColleagues.length > 2 && (
                    <span className="dash-today-colleagues__avatar dash-today-colleagues__avatar--more">+{todayColleagues.length - 2}</span>
                  )}
                </div>
              </div>
            )}
          </>
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

      {withdrawTarget && (
        <ConfirmDialog
          title="收回假單"
          description="確定要收回這張假單嗎？收回後需要重新送出。"
          confirmLabel="收回"
          danger
          onConfirm={handleConfirmWithdraw}
          onCancel={() => setWithdrawTarget(null)}
        />
      )}
    </div>
  )
}

function countDaysLabel(startDate, endDate) {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const days = Math.round((end - start) / 86400000) + 1
  return ` (${days}天)`
}

export default Home
