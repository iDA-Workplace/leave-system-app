import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, EmptyState, PageHeader, Skeleton, Tabs, Textarea } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './MyLeaves.css'
import './ApprovalList.css'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'boss']

const statusMap = {
  pending: { label: '審核中', tone: 'warning' },
  approved: { label: '已核准', tone: 'success' },
  rejected: { label: '已拒絕', tone: 'error' },
  returned: { label: '已退回', tone: 'neutral' },
  withdrawn: { label: '已收回', tone: 'info' }
}

function urgencyDays(startDate) {
  const start = new Date(startDate + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((start - today) / 86400000)
}

function MyLeaves({ userProfile }) {
  const isApprover = APPROVER_ROLES.includes(userProfile?.role)
  const { showToast } = useToast()

  // 請假紀錄清單（自己的假單）
  const [leaves, setLeaves] = useState([])
  const [leavesLoading, setLeavesLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)

  // 假期明細
  const [leaveTypes, setLeaveTypes] = useState([])
  const [annualLeave, setAnnualLeave] = useState(null)
  const [leaveStats, setLeaveStats] = useState([])
  const [balanceLoading, setBalanceLoading] = useState(true)

  // 待審核（團隊）— 主管／老闆專用
  const [pendingRequests, setPendingRequests] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [approvalSelected, setApprovalSelected] = useState(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 審核紀錄清單 — 主管／老闆專用
  const [approvalHistory, setApprovalHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyTab, setHistoryTab] = useState('mine')

  useEffect(() => {
    fetchMyLeaves()
    fetchBalance()
    if (isApprover) {
      fetchPendingRequests()
      fetchApprovalHistory()
    }
  }, [userProfile])

  async function fetchMyLeaves() {
    setLeavesLoading(true)
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        leave_type:leave_types(name, color),
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
      .select(`*, leave_type:leave_types(name, color)`)
      .eq('requester_id', userProfile.id)
      .eq('status', 'approved')
      .gte('start_date', `${year}-01-01`)
      .lte('start_date', `${year}-12-31`)

    const statsMap = {}
    for (const leave of approvedLeaves || []) {
      const typeName = leave.leave_type?.name || '其他'
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
    setBalanceLoading(false)
  }

  async function fetchPendingRequests() {
    setPendingLoading(true)
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
    if (allSteps.length === 0) {
      setPendingRequests([])
      setPendingLoading(false)
      return
    }

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name, email),
        leave_type:leave_types(name, color),
        flow:approval_flows(
          name,
          steps:approval_flow_steps(*, approver:users!approval_flow_steps_approver_id_fkey(full_name))
        ),
        approvals:leave_approvals(*, approver:users!leave_approvals_approver_id_fkey(full_name))
      `)
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
          leave_type:leave_types(name, color),
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
    showToast('假單已收回')
    fetchMyLeaves()
  }

  async function handleResubmit(leave) {
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
      showToast('已重新送出！')
    }
  }

  async function handleAction(request, action) {
    if (action === 'rejected' && !comment.trim()) {
      showToast('請填寫拒絕原因', { tone: 'error' })
      return
    }

    setSubmitting(true)

    const today = new Date().toISOString().split('T')[0]
    const currentStep = request.flow.steps.find(s => s.step_order === request.current_step)

    const { data: delegate } = await supabase
      .from('approval_delegates')
      .select('original_approver_id')
      .eq('delegate_user_id', userProfile.id)
      .eq('original_approver_id', currentStep?.approver_id)
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)
      .single()

    await supabase.from('leave_approvals').insert({
      request_id: request.id,
      approver_id: userProfile.id,
      original_approver_id: delegate ? currentStep?.approver_id : null,
      step_order: request.current_step,
      action,
      comment: comment.trim() || null
    })

    if (action === 'rejected') {
      await supabase.from('leave_requests').update({ status: 'rejected' }).eq('id', request.id)
      await supabase.functions.invoke('send-slack-notification', { body: { type: 'rejected', request_id: request.id } })
    } else {
      const maxStep = Math.max(...request.flow.steps.map(s => s.step_order))
      if (request.current_step >= maxStep) {
        await supabase.from('leave_requests').update({ status: 'approved' }).eq('id', request.id)
        await supabase.functions.invoke('send-slack-notification', { body: { type: 'approved', request_id: request.id } })
      } else {
        await supabase.from('leave_requests').update({ current_step: request.current_step + 1 }).eq('id', request.id)
        await supabase.functions.invoke('send-slack-notification', { body: { type: 'new_request', request_id: request.id } })
      }
    }

    setComment('')
    setApprovalSelected(null)
    setSubmitting(false)
    fetchPendingRequests()
    fetchApprovalHistory()
  }

  const pendingOwnCount = leaves.filter(l => l.status === 'pending').length

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
    <div>
      <PageHeader title="假單管理" actions={<Link to="/leave/new"><Button>+ 請假申請</Button></Link>} />

      <div className="leave-mgmt-stats">
        <Card className="leave-mgmt-stat">
          <div className="leave-mgmt-stat__label">審核中{isApprover ? '（個人）' : ''}</div>
          <div className="leave-mgmt-stat__value">{leavesLoading ? '—' : pendingOwnCount}</div>
        </Card>
        {isApprover && (
          <Card className="leave-mgmt-stat">
            <div className="leave-mgmt-stat__label">待審核（團隊）</div>
            <div className="leave-mgmt-stat__value">{pendingLoading ? '—' : pendingRequests.length}</div>
          </Card>
        )}
      </div>

      <Card className="leave-mgmt-section">
        <PageHeader title="假期明細" />
        {balanceLoading ? <Skeleton height="120px" /> : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>假別</th><th>使用效期</th><th>當年度可使用時數</th><th>已使用時數</th></tr></thead>
              <tbody>
                {balanceRows.map(row => (
                  <tr key={row.id}>
                    <td><Chip tone="info" style={{ background: (row.color || 'var(--sys-color-primary)') + '22', color: row.color || 'var(--sys-color-primary)' }}>{row.name}</Chip></td>
                    <td>當年度</td>
                    <td>{row.total != null ? `${row.total} 小時` : '依勞基法'}</td>
                    <td>{row.used} 小時</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isApprover && (
        <Card className="leave-mgmt-section">
          <PageHeader title="待審核假單（團隊）" />
          {pendingLoading ? (
            <Skeleton height="96px" />
          ) : pendingRequests.length === 0 ? (
            <EmptyState icon="✓" title="目前沒有待審核的假單" />
          ) : (
            <div className="approval-list">
              {pendingRequests.map(request => {
                const days = urgencyDays(request.start_date)
                const isUrgent = days >= 0 && days < 3
                const isOpen = approvalSelected?.id === request.id
                return (
                  <Card key={request.id} style={{ borderLeft: `4px solid ${request.leave_type?.color || 'var(--sys-color-primary)'}` }}>
                    <div className="approval-card__row">
                      <div>
                        <div className="approval-card__name">
                          {request.requester?.full_name}
                          {isUrgent && <Chip tone="error" className="approval-card__urgency">🔥 {days === 0 ? '今天開始' : `${days} 天後開始`}</Chip>}
                        </div>
                        <div className="approval-card__meta">{request.leave_type?.name}｜{request.start_date} ～ {request.end_date}</div>
                        <div className="approval-card__reason">原因：{request.reason}</div>
                      </div>
                      <Button onClick={() => { setApprovalSelected(isOpen ? null : request); setComment('') }}>審核</Button>
                    </div>
                    {isOpen && (
                      <div className="approval-card__panel">
                        <Textarea
                          label="備註／拒絕原因（拒絕時必填）"
                          value={comment}
                          onChange={e => setComment(e.target.value)}
                          rows={3}
                          placeholder="請輸入備註，若要拒絕請填寫原因"
                        />
                        <div className="approval-card__panel-actions">
                          <Button variant="filled" style={{ background: 'var(--sys-color-success)' }} disabled={submitting} onClick={() => handleAction(request, 'approved')}>✓ 核准</Button>
                          <Button variant="danger" disabled={submitting} onClick={() => handleAction(request, 'rejected')}>✗ 拒絕</Button>
                          <Button variant="text" onClick={() => { setApprovalSelected(null); setComment('') }}>取消</Button>
                        </div>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          )}
        </Card>
      )}

      <Card className="leave-mgmt-section">
        {isApprover ? (
          <Tabs tabs={[
            { key: 'mine', label: '請假紀錄清單', active: historyTab === 'mine', onClick: () => setHistoryTab('mine') },
            { key: 'approved', label: '審核紀錄清單', active: historyTab === 'approved', onClick: () => setHistoryTab('approved') },
          ]} />
        ) : (
          <PageHeader title="請假紀錄清單" />
        )}

        {(!isApprover || historyTab === 'mine') && (
          leavesLoading ? (
            <div className="my-leaves-list"><Skeleton height="88px" /><Skeleton height="88px" /></div>
          ) : leaves.length === 0 ? (
            <EmptyState title="尚無請假記錄" />
          ) : (
            <div className="my-leaves-list">
              {leaves.map(leave => {
                const status = statusMap[leave.status] || statusMap.pending
                const isOpen = selected?.id === leave.id
                return (
                  <Card
                    key={leave.id}
                    className="my-leave-card"
                    style={{ borderLeft: `4px solid ${leave.leave_type?.color || 'var(--sys-color-primary)'}`, cursor: 'pointer' }}
                    onClick={() => setSelected(isOpen ? null : leave)}
                  >
                    <div className="my-leave-card__row">
                      <div>
                        <div className="my-leave-card__type">{leave.leave_type?.name}</div>
                        <div className="my-leave-card__meta">
                          {leave.start_date} ～ {leave.end_date}
                          {leave.hours && ` ｜ ${leave.hours} 小時`}
                          {leave.proxy?.full_name && ` ｜ 代理人：${leave.proxy.full_name}`}
                        </div>
                        <div className="my-leave-card__timestamp">申請時間：{new Date(leave.created_at).toLocaleString('zh-TW')}</div>
                      </div>
                      <div className="my-leave-card__actions">
                        <Chip tone={status.tone}>{status.label}</Chip>
                        {leave.status === 'pending' && (
                          <Button variant="tonal" size="sm" onClick={e => { e.stopPropagation(); setWithdrawTarget(leave) }}>收回假單</Button>
                        )}
                        {(leave.status === 'returned' || leave.status === 'withdrawn') && (
                          <Button size="sm" onClick={e => { e.stopPropagation(); handleResubmit(leave) }}>重新送出</Button>
                        )}
                      </div>
                    </div>

                    {isOpen && (
                      <div className="my-leave-card__detail">
                        <div className="my-leave-card__detail-row">
                          <span className="my-leave-card__detail-label">請假原因：</span>
                          <span>{leave.reason}</span>
                        </div>
                        {leave.start_time && (
                          <div className="my-leave-card__detail-row">
                            <span className="my-leave-card__detail-label">請假時段：</span>
                            <span>{leave.start_time} ～ {leave.end_time}</span>
                          </div>
                        )}
                        {(leave.status === 'returned' || leave.status === 'withdrawn') && leave.returned_reason && (
                          <div className="my-leave-card__detail-row">
                            <span className="my-leave-card__detail-label">退回原因：</span>
                            <span className="my-leave-card__detail-error">{leave.returned_reason}</span>
                          </div>
                        )}
                        {leave.approvals?.length > 0 && (
                          <div className="my-leave-card__approvals">
                            <div className="my-leave-card__detail-label">審核記錄：</div>
                            {leave.approvals.map(approval => (
                              <div key={approval.id} className="my-leave-card__approval-row">
                                <Chip tone={approval.action === 'approved' ? 'success' : 'error'}>{approval.action === 'approved' ? '核准' : '拒絕'}</Chip>
                                <span>{approval.approver?.full_name}</span>
                                {approval.comment && <span className="my-leave-card__detail-label">：{approval.comment}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          )
        )}

        {isApprover && historyTab === 'approved' && (
          historyLoading ? (
            <Skeleton height="96px" />
          ) : approvalHistory.length === 0 ? (
            <EmptyState title="尚無審核紀錄" />
          ) : (
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr><th>請假人</th><th>請假日期/時間</th><th>時數</th><th>職務代理人</th><th>審核結果</th></tr></thead>
                <tbody>
                  {approvalHistory.map(a => (
                    <tr key={a.id}>
                      <td>{a.request?.requester?.full_name}</td>
                      <td>{a.request?.start_date} ～ {a.request?.end_date}</td>
                      <td>{a.request?.hours ? `${a.request.hours} 小時` : '—'}</td>
                      <td>{a.request?.proxy?.full_name || '—'}</td>
                      <td><Chip tone={a.action === 'approved' ? 'success' : 'error'}>{a.action === 'approved' ? '核准' : '拒絕'}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>

      {withdrawTarget && (
        <ConfirmDialog
          title="收回假單"
          description="確定要收回這張假單嗎？收回後需要重新送出。"
          confirmLabel="收回"
          danger
          loading={withdrawing}
          onConfirm={confirmWithdraw}
          onCancel={() => setWithdrawTarget(null)}
        />
      )}
    </div>
  )
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
