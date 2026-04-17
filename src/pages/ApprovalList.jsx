import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function ApprovalList({ userProfile }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchPendingRequests()
  }, [])

  async function fetchPendingRequests() {
    const today = new Date().toISOString().split('T')[0]

    // 找出這位主管負責審核的假單（含代理）
    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    // 找出這位主管是代理人的情況
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

    // 篩選出輪到這位主管審核的假單
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
      alert('請填寫拒絕原因')
      return
    }

    setSubmitting(true)

    // 找出原始審核人（可能是代理）
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

    // 寫入審核記錄
    await supabase.from('leave_approvals').insert({
      request_id: request.id,
      approver_id: userProfile.id,
      original_approver_id: delegate ? currentStep?.approver_id : null,
      step_order: request.current_step,
      action,
      comment: comment.trim() || null
    })

    if (action === 'rejected') {
      // 直接拒絕
      await supabase
        .from('leave_requests')
        .update({ status: 'rejected' })
        .eq('id', request.id)

      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'rejected', request_id: request.id }
      })
    } else {
      // 檢查是否還有下一關
      const maxStep = Math.max(...request.flow.steps.map(s => s.step_order))

      if (request.current_step >= maxStep) {
        // 最後一關，核准
        await supabase
          .from('leave_requests')
          .update({ status: 'approved' })
          .eq('id', request.id)

        await supabase.functions.invoke('send-slack-notification', {
          body: { type: 'approved', request_id: request.id }
        })
      } else {
        // 進到下一關
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

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <h2 style={{ marginBottom: '24px', color: '#1f2937', fontSize: '22px' }}>
        待審核假單
        {requests.length > 0 && (
          <span style={{
            marginLeft: '10px',
            backgroundColor: '#EF4444',
            color: 'white',
            borderRadius: '20px',
            padding: '2px 10px',
            fontSize: '14px'
          }}>
            {requests.length}
          </span>
        )}
      </h2>

      {requests.length === 0 ? (
        <div style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: '48px',
          textAlign: 'center',
          color: '#6b7280',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
        }}>
          目前沒有待審核的假單 ✓
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {requests.map(request => (
            <div key={request.id} style={{
              backgroundColor: 'white',
              borderRadius: '12px',
              padding: '20px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              borderLeft: `4px solid ${request.leave_type?.color || '#4F46E5'}`
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', fontSize: '16px', marginBottom: '6px' }}>
                    {request.requester?.full_name}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '4px' }}>
                    {request.leave_type?.name}｜{request.start_date} ～ {request.end_date}
                  </div>
                  <div style={{ fontSize: '13px', color: '#374151', marginBottom: '4px' }}>
                    原因：{request.reason}
                  </div>
                  <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                    申請時間：{new Date(request.created_at).toLocaleString('zh-TW')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setSelected(selected?.id === request.id ? null : request)
                      setComment('')
                    }}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: '#4F46E5',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    審核
                  </button>
                </div>
              </div>

              {/* 審核面板 */}
              {selected?.id === request.id && (
                <div style={{
                  marginTop: '16px',
                  paddingTop: '16px',
                  borderTop: '1px solid #f3f4f6'
                }}>
                  <div style={{ marginBottom: '12px' }}>
                    <label style={{
                      display: 'block',
                      marginBottom: '6px',
                      fontSize: '14px',
                      fontWeight: '500',
                      color: '#374151'
                    }}>
                      備註／拒絕原因（拒絕時必填）
                    </label>
                    <textarea
                      value={comment}
                      onChange={e => setComment(e.target.value)}
                      rows={3}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        border: '1px solid #e5e7eb',
                        borderRadius: '8px',
                        fontSize: '14px',
                        boxSizing: 'border-box',
                        resize: 'vertical'
                      }}
                      placeholder="請輸入備註，若要拒絕請填寫原因"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleAction(request, 'approved')}
                      disabled={submitting}
                      style={{
                        padding: '10px 24px',
                        backgroundColor: submitting ? '#6ee7b7' : '#10B981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                        fontWeight: '500'
                      }}
                    >
                      ✓ 核准
                    </button>
                    <button
                      onClick={() => handleAction(request, 'rejected')}
                      disabled={submitting}
                      style={{
                        padding: '10px 24px',
                        backgroundColor: submitting ? '#fca5a5' : '#EF4444',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                        fontWeight: '500'
                      }}
                    >
                      ✗ 拒絕
                    </button>
                    <button
                      onClick={() => { setSelected(null); setComment('') }}
                      style={{
                        padding: '10px 16px',
                        backgroundColor: '#f3f4f6',
                        color: '#374151',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '14px'
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default ApprovalList