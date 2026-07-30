import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, EmptyState, PageHeader, Skeleton, Textarea } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './ApprovalList.css'

function urgencyDays(startDate) {
  const start = new Date(startDate + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((start - today) / 86400000)
}

function ApprovalList({ userProfile }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  useEffect(() => {
    fetchPendingRequests()
  }, [])

  async function fetchPendingRequests() {
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
      setRequests([])
      setLoading(false)
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
          steps:approval_flow_steps(
            *,
            approver:users!approval_flow_steps_approver_id_fkey(full_name)
          )
        ),
        approvals:leave_approvals(
          *,
          approver:users!leave_approvals_approver_id_fkey(full_name)
        )
      `)
      .eq('status', 'pending')

    const filtered = (data || []).filter(req => {
      return allSteps.some(
        step => step.flow_id === req.flow_id && step.step_order === req.current_step
      )
    })

    setRequests(filtered)
    setLoading(false)
  }

  async function handleAction(request, action) {
    if (action === 'rejected' && !comment.trim()) {
      showToast('請填寫拒絕原因', { tone: 'error' })
      return
    }

    setSubmitting(true)

    const today = new Date().toISOString().split('T')[0]
    const currentStep = request.flow.steps.find(
      s => s.step_order === request.current_step
    )

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
      await supabase
        .from('leave_requests')
        .update({ status: 'rejected' })
        .eq('id', request.id)

      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'rejected', request_id: request.id }
      })
    } else {
      const maxStep = Math.max(...request.flow.steps.map(s => s.step_order))

      if (request.current_step >= maxStep) {
        await supabase
          .from('leave_requests')
          .update({ status: 'approved' })
          .eq('id', request.id)

        await supabase.functions.invoke('send-slack-notification', {
          body: { type: 'approved', request_id: request.id }
        })
      } else {
        await supabase
          .from('leave_requests')
          .update({ current_step: request.current_step + 1 })
          .eq('id', request.id)

        await supabase.functions.invoke('send-slack-notification', {
          body: { type: 'new_request', request_id: request.id }
        })
      }
    }

    setComment('')
    setSelected(null)
    setSubmitting(false)
    fetchPendingRequests()
  }

  if (loading) return (
    <div>
      <PageHeader title="待審核假單" />
      <div className="approval-list">
        <Skeleton height="96px" />
        <Skeleton height="96px" />
      </div>
    </div>
  )

  return (
    <div>
      <PageHeader
        title="待審核假單"
        badge={requests.length > 0 && <Chip tone="error">{requests.length}</Chip>}
      />

      {requests.length === 0 ? (
        <Card><EmptyState icon="✓" title="目前沒有待審核的假單" /></Card>
      ) : (
        <div className="approval-list">
          {requests.map(request => {
            const days = urgencyDays(request.start_date)
            const isUrgent = days >= 0 && days < 3
            const isOpen = selected?.id === request.id
            return (
              <Card key={request.id} style={{ borderLeft: `4px solid ${request.leave_type?.color || 'var(--sys-color-primary)'}` }}>
                <div className="approval-card__row">
                  <div>
                    <div className="approval-card__name">
                      {request.requester?.full_name}
                      {isUrgent && <Chip tone="error" className="approval-card__urgency">🔥 {days === 0 ? '今天開始' : `${days} 天後開始`}</Chip>}
                    </div>
                    <div className="approval-card__meta">
                      {request.leave_type?.name}｜{request.start_date} ～ {request.end_date}
                    </div>
                    <div className="approval-card__reason">原因：{request.reason}</div>
                    <div className="approval-card__timestamp">申請時間：{new Date(request.created_at).toLocaleString('zh-TW')}</div>
                  </div>
                  <Button onClick={() => { setSelected(isOpen ? null : request); setComment('') }}>
                    審核
                  </Button>
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
                      <Button variant="filled" style={{ background: 'var(--sys-color-success)' }} disabled={submitting} onClick={() => handleAction(request, 'approved')}>
                        ✓ 核准
                      </Button>
                      <Button variant="danger" disabled={submitting} onClick={() => handleAction(request, 'rejected')}>
                        ✗ 拒絕
                      </Button>
                      <Button variant="text" onClick={() => { setSelected(null); setComment('') }}>取消</Button>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ApprovalList
