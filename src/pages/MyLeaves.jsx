import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './MyLeaves.css'

const statusMap = {
  pending: { label: '審核中', tone: 'warning' },
  approved: { label: '已核准', tone: 'success' },
  rejected: { label: '已拒絕', tone: 'error' },
  returned: { label: '已退回', tone: 'neutral' },
  withdrawn: { label: '已收回', tone: 'info' }
}

function MyLeaves({ userProfile }) {
  const [leaves, setLeaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const { showToast } = useToast()

  useEffect(() => {
    fetchMyLeaves()
  }, [])

  async function fetchMyLeaves() {
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        leave_type:leave_types(name, color),
        flow:approval_flows(name),
        approvals:leave_approvals(
          *,
          approver:users!leave_approvals_approver_id_fkey(full_name)
        )
      `)
      .eq('requester_id', userProfile.id)
      .order('created_at', { ascending: false })

    setLeaves(data || [])
    setLoading(false)
  }

  async function confirmWithdraw() {
    setWithdrawing(true)
    await supabase
      .from('leave_requests')
      .update({ status: 'withdrawn' })
      .eq('id', withdrawTarget.id)
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
      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'new_request', request_id: data.id }
      })
      fetchMyLeaves()
      showToast('已重新送出！')
    }
  }

  if (loading) return (
    <div>
      <PageHeader title="我的假單" />
      <div className="my-leaves-list">
        <Skeleton height="88px" />
        <Skeleton height="88px" />
        <Skeleton height="88px" />
      </div>
    </div>
  )

  return (
    <div>
      <PageHeader title="我的假單" />

      {leaves.length === 0 ? (
        <Card><EmptyState title="尚無請假記錄" /></Card>
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
                    </div>
                    <div className="my-leave-card__timestamp">
                      申請時間：{new Date(leave.created_at).toLocaleString('zh-TW')}
                    </div>
                  </div>
                  <div className="my-leave-card__actions">
                    <Chip tone={status.tone}>{status.label}</Chip>
                    {leave.status === 'pending' && (
                      <Button variant="tonal" size="sm" onClick={e => { e.stopPropagation(); setWithdrawTarget(leave) }}>
                        收回假單
                      </Button>
                    )}
                    {(leave.status === 'returned' || leave.status === 'withdrawn') && (
                      <Button size="sm" onClick={e => { e.stopPropagation(); handleResubmit(leave) }}>
                        重新送出
                      </Button>
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
                            <Chip tone={approval.action === 'approved' ? 'success' : 'error'}>
                              {approval.action === 'approved' ? '核准' : '拒絕'}
                            </Chip>
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
      )}

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

export default MyLeaves
