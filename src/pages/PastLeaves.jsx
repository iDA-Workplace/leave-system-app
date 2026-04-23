import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function PastLeaves() {
  const [leaves, setLeaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  useEffect(() => {
    fetchPastLeaves()
  }, [selectedMonth])

  async function fetchPastLeaves() {
    setLoading(true)
    const [year, month] = selectedMonth.split('-')
    const startOfMonth = `${year}-${month}-01`
    const endOfMonth = new Date(year, month, 0).toISOString().split('T')[0]
    const today = new Date().toISOString().split('T')[0]

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(name, color),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name)
      `)
      .eq('status', 'approved')
      .gte('start_date', startOfMonth)
      .lte('start_date', endOfMonth)
      .lt('end_date', today)
      .order('start_date', { ascending: false })

    setLeaves(data || [])
    setLoading(false)
  }

  // 產生過去12個月的選項
  const monthOptions = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
    monthOptions.push({ value, label })
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ margin: 0, color: '#1f2937', fontSize: '22px' }}>過往假期記錄</h2>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          style={{
            padding: '8px 12px', border: '1px solid #e5e7eb',
            borderRadius: '8px', fontSize: '14px',
            backgroundColor: 'white', cursor: 'pointer'
          }}
        >
          {monthOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p style={{ color: '#6b7280' }}>載入中...</p>
      ) : leaves.length === 0 ? (
        <div style={{
          backgroundColor: 'white', borderRadius: '12px', padding: '48px',
          textAlign: 'center', color: '#6b7280',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
        }}>
          這個月沒有請假記錄
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {leaves.map(leave => (
            <div key={leave.id} style={{
              backgroundColor: 'white', borderRadius: '12px', padding: '16px 20px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex',
              alignItems: 'center', gap: '16px',
              borderLeft: `4px solid ${leave.leave_type?.color || '#4F46E5'}`
            }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%',
                backgroundColor: (leave.leave_type?.color || '#4F46E5') + '20',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 'bold', color: leave.leave_type?.color || '#4F46E5',
                fontSize: '16px', flexShrink: 0
              }}>
                {leave.requester?.full_name?.charAt(0)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                  {leave.requester?.full_name}
                </div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  {leave.leave_type?.name}｜{leave.start_date} ～ {leave.end_date}
                  {leave.hours && ` ｜ ${leave.hours} 小時`}
                  {leave.proxy?.full_name && ` ｜ 代理：${leave.proxy.full_name}`}
                </div>
              </div>
              <div style={{
                backgroundColor: '#F3F4F6', color: '#6B7280',
                padding: '4px 12px', borderRadius: '20px',
                fontSize: '12px', fontWeight: '500'
              }}>
                已結束
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PastLeaves