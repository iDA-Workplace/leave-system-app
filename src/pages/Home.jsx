import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, Skeleton, Textarea } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { fetchAnnualLeaveDays, leaveTypeName } from '../lib/leaveEntitlements'
import { useLanguage } from '../context/LanguageContext'
import './Home.css'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'boss']
const STATUS_TONES = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  returned: 'neutral',
  withdrawn: 'info',
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

function FlowChips({ steps, currentStep, isApproved }) {
  if (!steps || steps.length === 0) return null
  return (
    <div className="dash-flow-chips">
      {steps.map((s, i) => {
        const tone = isApproved || s.step_order < currentStep ? 'passed' : s.step_order === currentStep ? 'current' : 'upcoming'
        return (
          <span key={s.step_order} className="dash-flow-chips__item">
            {i > 0 && <span className="dash-flow-chips__arrow">→</span>}
            <span className={`dash-flow-chips__name dash-flow-chips__name--${tone}`}>{s.approver?.full_name}</span>
          </span>
        )
      })}
    </div>
  )
}

function Home({ userProfile }) {
  const isApprover = APPROVER_ROLES.includes(userProfile?.role)
  const { showToast } = useToast()
  const { t, lang } = useLanguage()

  const [annualLeave, setAnnualLeave] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  const [reviewParticipant, setReviewParticipant] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(true)

  const [approvalQueue, setApprovalQueue] = useState([])
  const [myRequests, setMyRequests] = useState([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [myRequestsLoading, setMyRequestsLoading] = useState(true)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const [actingId, setActingId] = useState(null)
  const [approvalPage, setApprovalPage] = useState(1)
  const APPROVAL_PAGE_SIZE = 5
  const location = useLocation()

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [monthLeaveDates, setMonthLeaveDates] = useState(new Set())
  const [selectedDate, setSelectedDate] = useState(() => toISODate(new Date()))
  const [selectedDateColleagues, setSelectedDateColleagues] = useState([])
  const [expandedColleagueIds, setExpandedColleagueIds] = useState(() => new Set())
  const [calendarLoading, setCalendarLoading] = useState(true)

  useEffect(() => { fetchEntitlement() }, [userProfile])
  useEffect(() => { fetchReviewParticipant() }, [userProfile])
  useEffect(() => {
    fetchMyRequests()
    if (isApprover) fetchApprovalQueue()
  }, [userProfile])
  useEffect(() => { fetchMonthLeaveDates() }, [calendarMonth])
  useEffect(() => { fetchColleaguesForDate(selectedDate) }, [selectedDate])
  useEffect(() => {
    if (location.hash === '#pending-team-approvals' && !queueLoading) {
      document.getElementById('pending-team-approvals')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [location.hash, queueLoading])
  useEffect(() => { setApprovalPage(1) }, [approvalQueue.length])

  async function fetchEntitlement() {
    if (!userProfile?.id) return
    // Resolves 財務's per-employee 特休 override, falling back to the
    // seniority-based annual_leave_summary when there isn't one.
    const days = await fetchAnnualLeaveDays(userProfile.id)
    if (days) setAnnualLeave(days)
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

    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    const allSteps = flowSteps || []
    if (allSteps.length === 0) { setApprovalQueue([]); setQueueLoading(false); return }

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(*),
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
    setMyRequestsLoading(true)
    const now = new Date()
    const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1))
    const monthEnd = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0))
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        leave_type:leave_types(*),
        flow:approval_flows(steps:approval_flow_steps(step_order, approver:users!approval_flow_steps_approver_id_fkey(full_name)))
      `)
      .eq('requester_id', userProfile.id)
      .lte('start_date', monthEnd)
      .gte('end_date', monthStart)
      .order('created_at', { ascending: false })
    setMyRequests(data || [])
    setMyRequestsLoading(false)
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

  async function fetchColleaguesForDate(dateISO) {
    setExpandedColleagueIds(new Set())
    const { data } = await supabase
      .from('leave_requests')
      .select('requester:users!leave_requests_requester_id_fkey(id, full_name)')
      .eq('status', 'approved')
      .lte('start_date', dateISO)
      .gte('end_date', dateISO)

    // One row per approved request, but one person can hold several requests
    // covering the same day (a long multi-day leave plus a separate part-day
    // one, say), and this widget answers "who is away", not "how many
    // requests exist". Without collapsing per person they showed up once per
    // request -- which also produced duplicate React keys and made expanding
    // one avatar expand every copy of that person.
    const byId = new Map()
    for (const row of data || []) {
      if (row.requester && !byId.has(row.requester.id)) byId.set(row.requester.id, row.requester)
    }
    setSelectedDateColleagues([...byId.values()])
  }

  function toggleColleagueExpanded(id) {
    setExpandedColleagueIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleApprove(request) {
    setActingId(request.id)
    const { error: insertError } = await supabase.from('leave_approvals').insert({
      request_id: request.id,
      approver_id: userProfile.id,
      step_order: request.current_step,
      action: 'approved',
    })
    if (insertError) {
      showToast(t('error_insert_approval', { msg: insertError.message }), { tone: 'error' })
      setActingId(null)
      return
    }

    const maxStep = Math.max(...request.flow.steps.map(s => s.step_order))
    const updateResult = request.current_step >= maxStep
      ? await supabase.from('leave_requests').update({ status: 'approved' }).eq('id', request.id).select()
      : await supabase.from('leave_requests').update({ current_step: request.current_step + 1 }).eq('id', request.id).select()

    if (updateResult.error) {
      showToast(t('error_update_request', { msg: updateResult.error.message }), { tone: 'error' })
      setActingId(null)
      return
    }
    if (!updateResult.data || updateResult.data.length === 0) {
      showToast(t('error_update_request_rls'), { tone: 'error' })
      setActingId(null)
      return
    }

    await supabase.functions.invoke('send-slack-notification', {
      body: { type: request.current_step >= maxStep ? 'approved' : 'new_request', request_id: request.id }
    })

    showToast(t('home_approved_toast', { name: request.requester?.full_name }))
    setActingId(null)
    fetchApprovalQueue()
  }

  async function handleConfirmReject() {
    if (!rejectReason.trim()) { showToast(t('home_reject_reason_required'), { tone: 'error' }); return }
    setActingId(rejectTarget.id)
    const { error: insertError } = await supabase.from('leave_approvals').insert({
      request_id: rejectTarget.id,
      approver_id: userProfile.id,
      step_order: rejectTarget.current_step,
      action: 'rejected',
      comment: rejectReason.trim(),
    })
    if (insertError) {
      showToast(t('error_insert_approval', { msg: insertError.message }), { tone: 'error' })
      setActingId(null)
      return
    }
    const { error: updateError, data: updateData } = await supabase.from('leave_requests').update({ status: 'rejected' }).eq('id', rejectTarget.id).select()
    if (updateError) {
      showToast(t('error_update_request', { msg: updateError.message }), { tone: 'error' })
      setActingId(null)
      return
    }
    if (!updateData || updateData.length === 0) {
      showToast(t('error_update_request_rls'), { tone: 'error' })
      setActingId(null)
      return
    }
    await supabase.functions.invoke('send-slack-notification', { body: { type: 'rejected', request_id: rejectTarget.id } })

    showToast(t('home_rejected_toast', { name: rejectTarget.requester?.full_name }))
    setActingId(null)
    setRejectTarget(null)
    setRejectReason('')
    fetchApprovalQueue()
  }

  async function handleConfirmWithdraw() {
    await supabase.from('leave_requests').update({ status: 'withdrawn' }).eq('id', withdrawTarget.id)
    showToast(t('home_withdrawn_toast'))
    setWithdrawTarget(null)
    fetchMyRequests()
  }

  const now = new Date()
  const weekdayLabels = Array.from({ length: 7 }, (_, i) => t(`weekday_short_${i}`))
  const todayLabel = t('home_today_date', {
    year: now.getFullYear(),
    month: t(`month_${now.getMonth() + 1}`),
    day: now.getDate(),
    weekday: t(`weekday_long_${now.getDay()}`),
  })
  const pendingSentence = isApprover && approvalQueue.length > 0
    ? t('home_pending_sentence', { n: approvalQueue.length })
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

  const canSelfAssess = userProfile?.role !== 'boss'
  const reviewActive = reviewParticipant?.review?.status === 'active'
  // supervisor_submitted 只有在簽核鏈「最後一關」送出時才會變 true，所以它
  // 就等於「整個評分流程已完成、結果已經可以看了」。
  const reviewScored = reviewParticipant?.supervisor_submitted === true
  const reviewDeadline = reviewParticipant?.review
    ? (reviewParticipant.review.self_assessment_deadline || reviewParticipant.review.evaluation_deadline || reviewParticipant.review.end_date)
    : null

  return (
    <div className="dash">
      <div className="dash-welcome">
        <h1 className="dash-welcome__title">
          {t('home_welcome', { name: userProfile?.full_name || '' })}
          {!isApprover && userProfile?.role === 'employee' && <span className="dash-welcome__role"> {t('home_role_employee')}</span>}
        </h1>
        <p className="dash-welcome__subtitle">{t('home_today_is', { date: todayLabel })}{pendingSentence}</p>
      </div>

      <div className="dash-top-grid">
        {statsLoading ? <Skeleton height="150px" /> : (
          <StatCard
            icon="📊"
            title={t('home_annual_leave_balance')}
            value={annualLeave?.remaining ?? '—'}
            valueTone={annualLeave?.remaining < 0 ? 'negative' : undefined}
            unit={annualLeave ? t('home_annual_unit', { total: annualLeave.entitled }) : ''}
            caption={annualLeave ? t('home_annual_used', { used: annualLeave.used }) : t('common_no_data')}
            progress={annualLeave?.entitled ? (annualLeave.used / annualLeave.entitled) * 100 : 0}
          />
        )}

        {reviewLoading ? <Skeleton height="150px" /> : (
          <Card className="dash-review-card">
            <div className="dash-card-header">
              <span className="dash-card-header__title">📈 {reviewActive ? reviewParticipant.review.title : t('home_review_reminder')}</span>
              {reviewActive && <span className="dash-review-card__status-badge">{t('home_review_in_progress')}</span>}
            </div>
            {!reviewActive ? (
              <p className="dash-empty-hint">{t('home_review_not_in_period')}</p>
            ) : (
              <>
                <div className="dash-review-card__grid">
                  {canSelfAssess && (
                    <div className="dash-review-card__tile">
                      {/* 評分跑完後這格改講整體流程狀態。分數刻意不放在首頁
                          （首頁常被同事看到／投影），要看分數得點進考核管理。 */}
                      <div className="dash-review-card__tile-label">
                        {reviewScored ? `✅ ${t('home_review_status')}` : `📝 ${t('home_review_self_progress')}`}
                      </div>
                      <div className="dash-review-card__tile-value">
                        {reviewScored
                          ? t('home_review_completed')
                          : reviewParticipant.self_submitted ? t('home_review_submitted') : t('home_review_not_submitted')}
                      </div>
                      <div className="dash-stat-card__progress-track">
                        <div className="dash-stat-card__progress-fill" style={{ width: reviewScored || reviewParticipant.self_submitted ? '100%' : '6%' }} />
                      </div>
                    </div>
                  )}
                  {reviewDeadline && (
                    <div className="dash-review-card__tile">
                      <div className="dash-review-card__tile-label">📅 {t('home_review_deadline')}</div>
                      <div className="dash-review-card__tile-value">{reviewDeadline}</div>
                    </div>
                  )}
                </div>
                <div className="dash-review-card__footer">
                  {/* 評分完成後自評表單早就不能再改了，還掛「填寫考核表單」會誤導，
                      所以整個換掉，直接把人帶到過往考核紀錄那一頁。 */}
                  {canSelfAssess && (
                    reviewScored
                      ? <Link to="/review?tab=past" className="dash-card-header__link">{t('home_review_view_result')} →</Link>
                      : <Link to="/review" className="dash-card-header__link">{t('home_review_fill_assessment')} →</Link>
                  )}
                  {isApprover && <Link to="/review/team" className="dash-card-header__link">{t('home_review_give_evaluation')} →</Link>}
                </div>
              </>
            )}
          </Card>
        )}
      </div>

      <Card className="dash-approval-card">
        <div className="dash-card-header">
          <span className="dash-card-header__title">🕐 {t('home_my_requests')}</span>
          <Link to="/leave/my" className="dash-card-header__link">{t('home_view_history')}</Link>
        </div>
        {myRequestsLoading ? (
          <Skeleton height="120px" />
        ) : myRequests.length === 0 ? (
          <p className="dash-empty-hint">{t('home_no_leave_records')}</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table dash-approval-table">
              <thead>
                <tr><th>{t('field_leave_type')}</th><th>{t('field_leave_dates')}</th><th>{t('field_time')}</th><th>{t('field_hours')}</th><th>{t('field_approval_status')}</th><th>{t('common_actions')}</th></tr>
              </thead>
              <tbody>
                {myRequests.map(req => {
                  const tone = STATUS_TONES[req.status] || STATUS_TONES.pending
                  const isMultiDay = req.end_date > req.start_date
                  return (
                    <tr key={req.id}>
                      <td><Chip tone="info" style={{ background: (req.leave_type?.color || 'var(--sys-color-primary)') + '22', color: req.leave_type?.color || 'var(--sys-color-primary)' }}>{leaveTypeName(req.leave_type, lang)}</Chip></td>
                      <td>{isMultiDay ? `${req.start_date} ~ ${req.end_date}` : req.start_date}</td>
                      <td>{isMultiDay ? t('common_all_day') : (req.start_time && req.end_time ? `${req.start_time} ~ ${req.end_time}` : '—')}</td>
                      <td>{req.hours ? t('common_hours', { n: req.hours }) : (isMultiDay ? t('common_days', { n: calendarDayCount(req.start_date, req.end_date) }) : '—')}</td>
                      <td>
                        <div className="dash-status-cell">
                          <Chip tone={tone}>{t(`status_${req.status}`)}</Chip>
                          {req.status === 'pending' && (
                            <FlowChips
                              steps={req.flow?.steps?.slice().sort((a, b) => a.step_order - b.step_order)}
                              currentStep={req.current_step}
                              isApproved={req.status === 'approved'}
                            />
                          )}
                        </div>
                      </td>
                      <td>
                        {req.status === 'pending' ? (
                          <button type="button" className="dash-withdraw-link" onClick={() => setWithdrawTarget(req)}>{t('home_withdraw')}</button>
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

      {isApprover && (
        <Card className="dash-approval-card" id="pending-team-approvals">
          <div className="dash-card-header">
            <span className="dash-card-header__title">📋 {t('home_pending_approvals')}</span>
            <Link to="/leave/my" className="dash-card-header__link">{t('home_view_history')}</Link>
          </div>
          {queueLoading ? (
            <Skeleton height="120px" />
          ) : approvalQueue.length === 0 ? (
            <p className="dash-empty-hint">{t('home_no_pending')}</p>
          ) : (() => {
            const totalPages = Math.max(1, Math.ceil(approvalQueue.length / APPROVAL_PAGE_SIZE))
            const safePage = Math.min(approvalPage, totalPages)
            const pageRows = approvalQueue.slice((safePage - 1) * APPROVAL_PAGE_SIZE, safePage * APPROVAL_PAGE_SIZE)
            return (
              <>
                <div className="ui-table-wrap">
                  <table className="ui-table dash-approval-table">
                    <thead>
                      <tr><th>{t('home_employee_name')}</th><th>{t('field_leave_type')}</th><th>{t('field_leave_dates')}</th><th>{t('common_actions')}</th></tr>
                    </thead>
                    <tbody>
                      {pageRows.map(req => (
                        <tr key={req.id}>
                          <td>
                            <div className="dash-approval-table__name">
                              <span className="dash-approval-table__avatar" style={{ background: avatarColor(req.requester_id) }}>{initials(req.requester?.full_name)}</span>
                              {req.requester?.full_name}
                            </div>
                          </td>
                          <td><Chip tone="info" style={{ background: (req.leave_type?.color || 'var(--sys-color-primary)') + '22', color: req.leave_type?.color || 'var(--sys-color-primary)' }}>{leaveTypeName(req.leave_type, lang)}</Chip></td>
                          <td>{req.start_date}</td>
                          <td>
                            <div className="dash-approval-table__actions">
                              <Button size="sm" variant="danger-outlined" disabled={actingId === req.id} onClick={() => setRejectTarget(req)} aria-label={t('home_reject')}>✕</Button>
                              <Button size="sm" variant="danger" disabled={actingId === req.id} onClick={() => handleApprove(req)} aria-label={t('home_approve')}>✓</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="leave-mgmt-pagination">
                  <Button size="sm" variant="outlined" disabled={safePage <= 1} onClick={() => setApprovalPage(p => p - 1)}>{t('common_prev_page')}</Button>
                  <span className="leave-mgmt-pagination__label">{t('common_page_indicator', { page: safePage, total: totalPages })}</span>
                  <Button size="sm" variant="outlined" disabled={safePage >= totalPages} onClick={() => setApprovalPage(p => p + 1)}>{t('common_next_page')}</Button>
                </div>
              </>
            )
          })()}
        </Card>
      )}

      <div className="dash-bottom-grid">
        <div className="dash-bottom-grid__main">
          <Card className="dash-calendar-card">
            <div className="dash-card-header">
              <span className="dash-card-header__title">📅 {t('home_leave_calendar')}</span>
              <div className="dash-calendar-nav">
                <button type="button" onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label={t('home_prev_month')}>‹</button>
                <span>{t('home_calendar_month', { year: calendarMonth.getFullYear(), month: t(`month_${calendarMonth.getMonth() + 1}`) })}</span>
                <button type="button" onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label={t('home_next_month')}>›</button>
              </div>
            </div>
            {calendarLoading ? <Skeleton height="260px" /> : (
              <div className="dash-mini-calendar">
                {weekdayLabels.map((w, i) => <div key={i} className="dash-mini-calendar__weekday">{w}</div>)}
                {monthGrid.map((cell, i) => (
                  <div key={i} className="dash-mini-calendar__cell">
                    {cell && (
                      <button
                        type="button"
                        className={`dash-mini-calendar__date${cell.isToday ? ' dash-mini-calendar__date--today' : ''}${cell.hasLeave ? ' dash-mini-calendar__date--leave' : ''}${cell.iso === selectedDate ? ' dash-mini-calendar__date--selected' : ''}`}
                        onClick={() => setSelectedDate(cell.iso)}
                      >
                        {cell.day}
                        {cell.hasLeave && <span className="dash-mini-calendar__dot" />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="dash-bottom-grid__side">
          <Card className="dash-colleagues-card">
            <div className="dash-card-header">
              <span className="dash-card-header__title">🧑‍🤝‍🧑 {t('home_colleagues_on_leave_today')}</span>
            </div>
            {calendarLoading ? <Skeleton height="120px" /> : (
              <div className="dash-today-colleagues dash-today-colleagues--vertical">
                <span className="dash-today-colleagues__label">{selectedDate}</span>
                {selectedDateColleagues.length === 0 ? (
                  <span className="dash-today-colleagues__empty">{t('home_nobody_on_leave')}</span>
                ) : (
                  <div className="dash-today-colleagues__avatars">
                    {selectedDateColleagues.slice(0, 4).map(c => {
                      const isExpanded = expandedColleagueIds.has(c.id)
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`dash-today-colleagues__avatar${isExpanded ? ' dash-today-colleagues__avatar--expanded' : ''}`}
                          style={{ background: avatarColor(c.id) }}
                          onClick={() => toggleColleagueExpanded(c.id)}
                          aria-pressed={isExpanded}
                          aria-label={c.full_name}
                        >
                          {isExpanded ? c.full_name : initials(c.full_name)}
                        </button>
                      )
                    })}
                    {selectedDateColleagues.length > 4 && (
                      <span className="dash-today-colleagues__avatar dash-today-colleagues__avatar--more">+{selectedDateColleagues.length - 4}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {rejectTarget && (
        <ConfirmDialog
          title={t('home_reject_title', { name: rejectTarget.requester?.full_name })}
          description={(
            <Textarea
              label={t('home_reject_reason')}
              required
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder={t('home_reject_reason_placeholder')}
            />
          )}
          confirmLabel={t('home_reject')}
          danger
          loading={actingId === rejectTarget.id}
          onConfirm={handleConfirmReject}
          onCancel={() => { setRejectTarget(null); setRejectReason('') }}
        />
      )}

      {withdrawTarget && (
        <ConfirmDialog
          title={t('home_withdraw_title')}
          description={t('home_withdraw_desc')}
          confirmLabel={t('home_withdraw_confirm')}
          danger
          onConfirm={handleConfirmWithdraw}
          onCancel={() => setWithdrawTarget(null)}
        />
      )}
    </div>
  )
}

function calendarDayCount(startDate, endDate) {
  const start = new Date(startDate)
  const end = new Date(endDate)
  return Math.round((end - start) / 86400000) + 1
}

export default Home
