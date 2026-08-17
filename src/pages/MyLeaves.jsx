import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, EmptyState, PageHeader, Select, Skeleton, Tabs } from '../components/ui'
import { useToast } from '../context/ToastContext'
import {
  buildBalanceRows, fetchEntitlementOverrides, checkQuota, leaveRequestHours,
  leaveTypeName, errorText, HOURS_PER_DAY,
} from '../lib/leaveEntitlements'
import { useLanguage } from '../context/LanguageContext'
import './MyLeaves.css'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'boss']

const STATUS_TONES = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  returned: 'neutral',
  withdrawn: 'info',
}

function MyLeaves({ userProfile }) {
  const isApprover = APPROVER_ROLES.includes(userProfile?.role)
  const { showToast } = useToast()
  const { t, lang } = useLanguage()

  // 請假紀錄清單（自己的假單）
  const [leaves, setLeaves] = useState([])
  const [leavesLoading, setLeavesLoading] = useState(true)
  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)

  // 假期明細
  const [leaveTypes, setLeaveTypes] = useState([])
  const [annualLeave, setAnnualLeave] = useState(null)
  const [entitlementOverrides, setEntitlementOverrides] = useState({})
  const [leaveStats, setLeaveStats] = useState([])
  const [balanceLoading, setBalanceLoading] = useState(true)

  // 待審核（團隊）計數 — 主管／老闆專用（實際審核已移到首頁）
  const [pendingRequests, setPendingRequests] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)

  // 審核紀錄清單 — 主管／老闆專用
  const [approvalHistory, setApprovalHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyTab, setHistoryTab] = useState('mine')

  // 請假紀錄清單／審核紀錄清單共用的年度/月份篩選＋分頁
  const currentYear = new Date().getFullYear()
  const [filterYear, setFilterYear] = useState(currentYear)
  const [filterMonth, setFilterMonth] = useState(0) // 0 = 全部月份
  const [historyPage, setHistoryPage] = useState(1)
  const PAGE_SIZE = 5

  useEffect(() => {
    fetchMyLeaves()
    fetchBalance()
    if (isApprover) {
      fetchPendingRequests()
      fetchApprovalHistory()
    }
  }, [userProfile])

  useEffect(() => { setHistoryPage(1) }, [historyTab, filterYear, filterMonth])

  async function fetchMyLeaves() {
    setLeavesLoading(true)
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        leave_type:leave_types(*),
        flow:approval_flows(name),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name),
        approvals:leave_approvals(
          *,
          approver:users!leave_approvals_approver_id_fkey(full_name)
        )
      `)
      .eq('requester_id', userProfile.id)
      .order('created_at', { ascending: false })

    setLeaves(data || [])
    setLeavesLoading(false)
  }

  async function fetchBalance() {
    setBalanceLoading(true)
    const year = new Date().getFullYear()

    const { data: types } = await supabase.from('leave_types').select('*').eq('is_active', true)
    setLeaveTypes(types || [])

    const { data: approvedLeaves } = await supabase
      .from('leave_requests')
      .select(`*, leave_type:leave_types(*)`)
      .eq('requester_id', userProfile.id)
      .eq('status', 'approved')
      .gte('start_date', `${year}-01-01`)
      .lte('start_date', `${year}-12-31`)

    const statsMap = {}
    for (const leave of approvedLeaves || []) {
      const typeName = leave.leave_type?.name || t('common_other')
      const typeColor = leave.leave_type?.color || 'var(--sys-color-primary)'
      if (!statsMap[typeName]) statsMap[typeName] = { name: typeName, color: typeColor, totalHours: 0 }
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
      setAnnualLeave({ entitled: summary.entitled_days || 0, used: summary.used_days || 0 })
    }
    setEntitlementOverrides(await fetchEntitlementOverrides(userProfile.id))
    setBalanceLoading(false)
  }

  async function fetchPendingRequests() {
    setPendingLoading(true)

    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    const allSteps = flowSteps || []
    if (allSteps.length === 0) {
      setPendingRequests([])
      setPendingLoading(false)
      return
    }

    // Only the count is needed here (the actionable list now lives on the
    // homepage), so this fetches minimal columns.
    const { data } = await supabase
      .from('leave_requests')
      .select('id, flow_id, current_step')
      .eq('status', 'pending')

    const filtered = (data || []).filter(req =>
      allSteps.some(step => step.flow_id === req.flow_id && step.step_order === req.current_step)
    )

    setPendingRequests(filtered)
    setPendingLoading(false)
  }

  async function fetchApprovalHistory() {
    setHistoryLoading(true)
    const { data } = await supabase
      .from('leave_approvals')
      .select(`
        *,
        request:leave_requests(
          start_date, end_date, start_time, end_time, hours,
          leave_type:leave_types(*),
          proxy:users!leave_requests_proxy_user_id_fkey(full_name),
          requester:users!leave_requests_requester_id_fkey(full_name)
        )
      `)
      .eq('approver_id', userProfile.id)
      .order('created_at', { ascending: false })
    setApprovalHistory(data || [])
    setHistoryLoading(false)
  }

  async function confirmWithdraw() {
    setWithdrawing(true)
    await supabase.from('leave_requests').update({ status: 'withdrawn' }).eq('id', withdrawTarget.id)
    setWithdrawing(false)
    setWithdrawTarget(null)
    showToast(t('home_withdrawn_toast'))
    fetchMyLeaves()
  }

  async function handleResubmit(leave) {
    // 重新送出等於開一張新假單，所以跟「請假申請」走同一套額度檢查。
    // 少了這裡，被退回的假單就成了繞過額度限制的後門。
    const leaveType = leaveTypes.find(lt => lt.id === leave.leave_type_id)
    if (leaveType) {
      try {
        const quota = await checkQuota({
          userId: userProfile.id,
          leaveType,
          requestedHours: leaveRequestHours(leave),
          lang,
        })
        if (!quota.ok) { showToast(t(quota.i18nKey, quota.i18nParams), { tone: 'error' }); return }
      } catch (err) {
        showToast(errorText(err, t), { tone: 'error' }); return
      }
    }

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        requester_id: userProfile.id,
        leave_type_id: leave.leave_type_id,
        flow_id: leave.flow_id,
        start_date: leave.start_date,
        end_date: leave.end_date,
        start_time: leave.start_time,
        end_time: leave.end_time,
        hours: leave.hours,
        proxy_user_id: leave.proxy_user_id,
        reason: leave.reason,
        status: 'pending',
        current_step: 1
      })
      .select()
      .single()

    if (!error) {
      await supabase.functions.invoke('send-slack-notification', { body: { type: 'new_request', request_id: data.id } })
      fetchMyLeaves()
      showToast(t('myleaves_resubmitted'))
    }
  }

  const pendingOwnCount = leaves.filter(l => l.status === 'pending').length

  const balanceRows = buildBalanceRows({ leaveTypes, leaveStats, annualLeave, overrides: entitlementOverrides })

  return (
    <div>
      <PageHeader title={t('nav_leave_management')} actions={<Link to="/leave/new"><Button>{t('myleaves_new_request')}</Button></Link>} />

      <div className="leave-mgmt-stats">
        <Card className="leave-mgmt-stat">
          <div className="leave-mgmt-stat__label">{isApprover ? t('myleaves_stat_pending_personal') : t('myleaves_stat_pending')}</div>
          <div className="leave-mgmt-stat__value">{leavesLoading ? '—' : pendingOwnCount}</div>
        </Card>
        {isApprover && (
          <Link to="/#pending-team-approvals" className="leave-mgmt-stat-link">
            <Card className="leave-mgmt-stat">
              <div className="leave-mgmt-stat__label">{t('myleaves_stat_team')}</div>
              <div className="leave-mgmt-stat__value">{pendingLoading ? '—' : pendingRequests.length}</div>
              <div className="leave-mgmt-stat__hint">{t('myleaves_stat_team_hint')}</div>
            </Card>
          </Link>
        )}
      </div>

      <Card className="leave-mgmt-section">
        <PageHeader title={t('myleaves_balance_title')} />
        {balanceLoading ? <Skeleton height="120px" /> : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>{t('field_leave_type')}</th><th>{t('myleaves_validity')}</th><th>{t('myleaves_available_hours')}</th><th>{t('myleaves_used_hours')}</th></tr></thead>
              <tbody>
                {balanceRows.map(row => (
                  <tr key={row.id}>
                    <td><Chip tone="info" style={{ background: (row.color || 'var(--sys-color-primary)') + '22', color: row.color || 'var(--sys-color-primary)' }}>{leaveTypeName(row, lang)}</Chip></td>
                    <td>{t('myleaves_current_year')}</td>
                    <td>{row.total != null ? t('common_hours', { n: row.total }) : t('myleaves_by_law')}</td>
                    <td>{t('common_hours', { n: row.used })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="leave-mgmt-section">
        {isApprover ? (
          <Tabs tabs={[
            { key: 'mine', label: t('myleaves_tab_mine'), active: historyTab === 'mine', onClick: () => setHistoryTab('mine') },
            { key: 'approved', label: t('myleaves_tab_approved'), active: historyTab === 'approved', onClick: () => setHistoryTab('approved') },
          ]} />
        ) : (
          <PageHeader title={t('myleaves_tab_mine')} />
        )}

        <div className="leave-mgmt-filters">
          <Select label={t('common_year')} value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}>
            {[currentYear, currentYear - 1, currentYear - 2].map(y => <option key={y} value={y}>{t('common_year_option', { y })}</option>)}
          </Select>
          <Select label={t('common_month')} value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}>
            <option value={0}>{t('common_all_months')}</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{t(`month_${m}`)}</option>)}
          </Select>
        </div>

        {(!isApprover || historyTab === 'mine') && (() => {
          const filtered = filterByYearMonth(leaves, filterYear, filterMonth, l => l.start_date)
          const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
          const pageRows = paginate(filtered, historyPage, PAGE_SIZE)
          return leavesLoading ? (
            <Skeleton height="120px" />
          ) : filtered.length === 0 ? (
            <EmptyState title={t('myleaves_empty_leaves')} />
          ) : (
            <>
              <div className="ui-table-wrap">
                <table className="ui-table">
                  <thead><tr><th>{t('field_leave_type')}</th><th>{t('field_leave_dates')}</th><th>{t('field_time')}</th><th>{t('field_hours')}</th><th>{t('field_approval_status')}</th><th>{t('common_actions')}</th></tr></thead>
                  <tbody>
                    {pageRows.map(leave => {
                      const tone = STATUS_TONES[leave.status] || STATUS_TONES.pending
                      const isMultiDay = leave.end_date > leave.start_date
                      return (
                        <tr key={leave.id}>
                          <td><Chip tone="info" style={{ background: (leave.leave_type?.color || 'var(--sys-color-primary)') + '22', color: leave.leave_type?.color || 'var(--sys-color-primary)' }}>{leaveTypeName(leave.leave_type, lang)}</Chip></td>
                          <td>{isMultiDay ? `${leave.start_date} ~ ${leave.end_date}` : leave.start_date}</td>
                          <td>{isMultiDay ? t('common_all_day') : (leave.start_time && leave.end_time ? `${leave.start_time} ~ ${leave.end_time}` : '—')}</td>
                          <td>{hoursFor(leave, t)}</td>
                          <td><Chip tone={tone}>{t(`status_${leave.status}`)}</Chip></td>
                          <td>
                            {leave.status === 'pending' && (
                              <Button variant="tonal" size="sm" onClick={() => setWithdrawTarget(leave)}>{t('myleaves_withdraw')}</Button>
                            )}
                            {(leave.status === 'returned' || leave.status === 'withdrawn') && (
                              <Button size="sm" onClick={() => handleResubmit(leave)}>{t('myleaves_resubmit')}</Button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="leave-mgmt-pagination">
                <Button size="sm" variant="outlined" disabled={historyPage <= 1} onClick={() => setHistoryPage(p => p - 1)}>{t('common_prev_page')}</Button>
                <span className="leave-mgmt-pagination__label">{t('common_page_indicator', { page: historyPage, total: totalPages })}</span>
                <Button size="sm" variant="outlined" disabled={historyPage >= totalPages} onClick={() => setHistoryPage(p => p + 1)}>{t('common_next_page')}</Button>
              </div>
            </>
          )
        })()}

        {isApprover && historyTab === 'approved' && (() => {
          const filtered = filterByYearMonth(approvalHistory, filterYear, filterMonth, a => a.request?.start_date)
          const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
          const pageRows = paginate(filtered, historyPage, PAGE_SIZE)
          return historyLoading ? (
            <Skeleton height="120px" />
          ) : filtered.length === 0 ? (
            <EmptyState title={t('myleaves_empty_approvals')} />
          ) : (
            <>
              <div className="ui-table-wrap">
                <table className="ui-table">
                  <thead><tr><th>{t('field_requester')}</th><th>{t('field_leave_dates')}</th><th>{t('field_time')}</th><th>{t('field_hours')}</th><th>{t('field_proxy')}</th><th>{t('myleaves_approval_result')}</th></tr></thead>
                  <tbody>
                    {pageRows.map(a => {
                      const req = a.request
                      const isMultiDay = req?.end_date > req?.start_date
                      return (
                        <tr key={a.id}>
                          <td>{req?.requester?.full_name}</td>
                          <td>{isMultiDay ? `${req?.start_date} ~ ${req?.end_date}` : req?.start_date}</td>
                          <td>{isMultiDay ? t('common_all_day') : (req?.start_time && req?.end_time ? `${req.start_time} ~ ${req.end_time}` : '—')}</td>
                          <td>{req ? hoursFor(req, t) : '—'}</td>
                          <td>{req?.proxy?.full_name || '—'}</td>
                          <td><Chip tone={a.action === 'approved' ? 'success' : 'error'}>{a.action === 'approved' ? t('myleaves_action_approved') : t('myleaves_action_rejected')}</Chip></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="leave-mgmt-pagination">
                <Button size="sm" variant="outlined" disabled={historyPage <= 1} onClick={() => setHistoryPage(p => p - 1)}>{t('common_prev_page')}</Button>
                <span className="leave-mgmt-pagination__label">{t('common_page_indicator', { page: historyPage, total: totalPages })}</span>
                <Button size="sm" variant="outlined" disabled={historyPage >= totalPages} onClick={() => setHistoryPage(p => p + 1)}>{t('common_next_page')}</Button>
              </div>
            </>
          )
        })()}
      </Card>

      {withdrawTarget && (
        <ConfirmDialog
          title={t('home_withdraw_title')}
          description={t('home_withdraw_desc')}
          confirmLabel={t('home_withdraw_confirm')}
          danger
          loading={withdrawing}
          onConfirm={confirmWithdraw}
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

function hoursFor(item, t) {
  if (item.hours) return t('common_hours', { n: item.hours })
  const days = calendarDayCount(item.start_date, item.end_date)
  return t('common_hours', { n: days * HOURS_PER_DAY })
}

function filterByYearMonth(rows, year, month, getDate) {
  return rows.filter(r => {
    const d = getDate(r)
    if (!d) return false
    const [y, m] = d.split('-')
    if (Number(y) !== year) return false
    if (month !== 0 && Number(m) !== month) return false
    return true
  })
}

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize
  return rows.slice(start, start + pageSize)
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

export default MyLeaves
