import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Card, Chip, EmptyState, PageHeader, Select, Skeleton } from '../components/ui'
import './PastLeaves.css'

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
      <PageHeader
        title="過往假期記錄"
        actions={(
          <Select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} style={{ minWidth: '160px' }}>
            {monthOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </Select>
        )}
      />

      {loading ? (
        <div className="past-leaves-list">
          <Skeleton height="72px" />
          <Skeleton height="72px" />
        </div>
      ) : leaves.length === 0 ? (
        <Card><EmptyState title="這個月沒有請假記錄" /></Card>
      ) : (
        <div className="past-leaves-list">
          {leaves.map(leave => (
            <Card key={leave.id} className="past-leave-card" style={{ borderLeft: `4px solid ${leave.leave_type?.color || 'var(--sys-color-primary)'}` }}>
              <div className="past-leave-card__avatar" style={{ backgroundColor: (leave.leave_type?.color || 'var(--sys-color-primary)') + '26', color: leave.leave_type?.color || 'var(--sys-color-primary)' }}>
                {leave.requester?.full_name?.charAt(0)}
              </div>
              <div className="past-leave-card__body">
                <div className="past-leave-card__name">{leave.requester?.full_name}</div>
                <div className="past-leave-card__meta">
                  {leave.leave_type?.name}｜{leave.start_date} ～ {leave.end_date}
                  {leave.hours && ` ｜ ${leave.hours} 小時`}
                  {leave.proxy?.full_name && ` ｜ 代理：${leave.proxy.full_name}`}
                </div>
              </div>
              <Chip tone="neutral">已結束</Chip>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

export default PastLeaves
