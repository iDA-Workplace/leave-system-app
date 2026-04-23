import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { format, startOfWeek, addDays } from 'date-fns'
import { zhTW } from 'date-fns/locale'

function Home() {
  const [weekLeaves, setWeekLeaves] = useState([])
  const [loading, setLoading] = useState(true)

  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')
  const weekStart = startOfWeek(today, { weekStartsOn: 1 })
  const weekEnd = addDays(weekStart, 4)
  const weekEndStr = format(weekEnd, 'yyyy-MM-dd')

  useEffect(() => {
    fetchWeekLeaves()
  }, [])

  async function fetchWeekLeaves() {
    const { data, error } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(name, color),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name)
      `)
      .eq('status', 'approved')
      .lte('start_date', weekEndStr)
      .gte('end_date', todayStr)
      .order('start_date')

    if (!error) setWeekLeaves(data || [])
    setLoading(false)
  }

  return (
    <div>
      <h2 style={{ marginBottom: '8px', color: '#1f2937', fontSize: '22px' }}>本週請假總覽</h2>
      <p style={{ color: '#6b7280', marginBottom: '24px', fontSize: '14px' }}>
        {format(today, 'yyyy/MM/dd', { locale: zhTW })} ～ {format(weekEnd, 'yyyy/MM/dd', { locale: zhTW })}
      </p>

      {loading ? (
        <p style={{ color: '#6b7280' }}>載入中...</p>
      ) : weekLeaves.length === 0 ? (
        <div style={{
          backgroundColor: 'white', borderRadius: '12px', padding: '48px',
          textAlign: 'center', color: '#6b7280',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
        }}>
          本週沒有人請假 🎉
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {weekLeaves.map(leave => (
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
                  {leave.proxy?.full_name && ` ｜ 代理：${leave.proxy.full_name}`}
                </div>
              </div>
              <div style={{
                backgroundColor: (leave.leave_type?.color || '#4F46E5') + '15',
                color: leave.leave_type?.color || '#4F46E5',
                padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '500'
              }}>
                請假中
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default Home