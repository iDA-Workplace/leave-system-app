import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const statusMap = {
  pending: { label: '審核中', color: '#F59E0B', bg: '#FEF3C7' },
  approved: { label: '已核准', color: '#10B981', bg: '#D1FAE5' },
  rejected: { label: '已拒絕', color: '#EF4444', bg: '#FEE2E2' },
  returned: { label: '已退回', color: '#6B7280', bg: '#F3F4F6' }
}

function MyLeaves({ userProfile }) {
  const [leaves, setLeaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

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

  async function handleResubmit(leave) {
    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        requester_id: userProfile.id,
        leave_type_id: leave.leave_type_id,
        flow_id: leave.flow_id,
        start_date: leave.start_date,
        end_date: leave.end_date,
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
      alert('已重新送出！')
    }
  }

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <h2 style={{ marginBottom: '24px', color: '#1f2937', fontSize: '22px' }}>我的假單</h2>

      {leaves.length === 0 ? (
        <div style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: '48px',
          textAlign: 'center',
          color: '#6b7280',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
        }}>
          尚無請假記錄
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {leaves.map(leave => {
            const status = statusMap[leave.status] || statusMap.pending
            return (
              <div
                key={leave.id}
                onClick={() => setSelected(selected?.id === leave.id ? null : leave)}
                style={{
                  backgroundColor: 'white',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                  cursor: 'pointer',
                  borderLeft: '4px solid ' + (leave.leave_type?.color || '#4F46E5')
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                      {leave.leave_type?.name}
                    </div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>
                      {leave.start_date} ～ {leave.end_date}
                    </div>
                    <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                      申請時間：{new Date(leave.created_at).toLocaleString('zh-TW')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                    <span style={{
                      backgroundColor: status.bg,
                      color: status.color,
                      padding: '4px 12px',
                      borderRadius: '20px',
                      fontSize: '12px',
                      fontWeight: '500'
                    }}>
                      {status.label}
                    </span>
                    {leave.status === 'returned' && (
                      <button
                        onClick={e => { e.stopPropagation(); handleResubmit(leave) }}
                        style={{
                          padding: '4px 12px',
                          backgroundColor: '#4F46E5',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          fontSize: '12px',
                          cursor: 'pointer'
                        }}
                      >
                        重新送出
                      </button>
                    )}
                  </div>
                </div>

                {selected?.id === leave.id && (
                  <div style={{
                    marginTop: '16px',
                    paddingTop: '16px',
                    borderTop: '1px solid #f3f4f6'
                  }}>
                    <div style={{ marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', color: '#6b7280' }}>請假原因：</span>
                      <span style={{ fontSize: '13px', color: '#374151' }}>{leave.reason}</span>
                    </div>
                    {leave.status === 'returned' && leave.returned_reason && (
                      <div style={{ marginBottom: '8px' }}>
                        <span style={{ fontSize: '13px', color: '#6b7280' }}>退回原因：</span>
                        <span style={{ fontSize: '13px', color: '#EF4444' }}>{leave.returned_reason}</span>
                      </div>
                    )}
                    {leave.approvals?.length > 0 && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '8px' }}>審核記錄：</div>
                        {leave.approvals.map(approval => (
                          <div key={approval.id} style={{
                            display: 'flex',
                            gap: '8px',
                            alignItems: 'flex-start',
                            marginBottom: '6px',
                            fontSize: '13px'
                          }}>
                            <span style={{
                              backgroundColor: approval.action === 'approved' ? '#D1FAE5' : '#FEE2E2',
                              color: approval.action === 'approved' ? '#10B981' : '#EF4444',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              flexShrink: 0
                            }}>
                              {approval.action === 'approved' ? '核准' : '拒絕'}
                            </span>
                            <span style={{ color: '#374151' }}>{approval.approver?.full_name}</span>
                            {approval.comment && (
                              <span style={{ color: '#6b7280' }}>：{approval.comment}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default MyLeaves