import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { format, startOfWeek, addDays } from 'date-fns'
import { zhTW } from 'date-fns/locale'

function Home({ userProfile }) {
  const [weekLeaves, setWeekLeaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [hiddenIds, setHiddenIds] = useState(() => {
    const key = `hiddenLeaveIds_${userProfile?.id}`
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : []
  })
  const [showHidden, setShowHidden] = useState(false)

  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')
  const weekStart = startOfWeek(today, { weekStartsOn: 1 })
  const weekEnd = addDays(weekStart, 4)
  const weekEndStr = format(weekEnd, 'yyyy-MM-dd')

  useEffect(() => {
    fetchWeekLeaves()
  }, [])

  useEffect(() => {
    const key = `hiddenLeaveIds_${userProfile?.id}`
    localStorage.setItem(key, JSON.stringify(hiddenIds))
  }, [hiddenIds])

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

  function toggleHide(id) {
    setHiddenIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    )
  }

  const visibleLeaves = weekLeaves.filter(l => !hiddenIds.includes(l.id))
  const hiddenLeaves = weekLeaves.filter(l => hiddenIds.includes(l.id))

  function LeaveCard({ leave, isHidden }) {
    return (
      <div style={{
        backgroundColor: 'white', borderRadius: '12px', padding: '16px 20px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex',
        alignItems: 'center', gap: '16px',
        borderLeft: `4px solid ${leave.leave_type?.color || '#4F46E5'}`,
        opacity: isHidden ? 0.5 : 1
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
        <button
          onClick={() => toggleHide(leave.id)}
          style={{
            padding: '4px 12px',
            backgroundColor: isHidden ? '#EEF2FF' : '#F3F4F6',
            color: isHidden ? '#4F46E5' : '#6B7280',
            border: 'none', borderRadius: '6px',
            fontSize: '12px', cursor: 'pointer'
          }}
        >
          {isHidden ? '顯示' : '隱藏'}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <h2 style={{ margin: 0, color: '#1f2937', fontSize: '22px' }}>本週請假總覽</h2>
        {hiddenLeaves.length > 0 && (
          <button
            onClick={() => setShowHidden(!showHidden)}
            style={{
              padding: '6px 14px', backgroundColor: 'white',
              color: '#6b7280', border: '1px solid #e5e7eb',
              borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
            }}
          >
            {showHidden ? '隱藏已隱藏的項目' : `顯示已隱藏（${hiddenLeaves.length}）`}
          </button>
        )}
      </div>
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
          {visibleLeaves.map(leave => (
            <LeaveCard key={leave.id} leave={leave} isHidden={false} />
          ))}
          {visibleLeaves.length === 0 && hiddenLeaves.length > 0 && (
            <div style={{
              backgroundColor: 'white', borderRadius: '12px', padding: '24px',
              textAlign: 'center', color: '#6b7280',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
            }}>
              所有假單都已隱藏，點右上角「顯示已隱藏」查看
            </div>
          )}
          {showHidden && hiddenLeaves.length > 0 && (
            <div>
              <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '8px', marginTop: '4px' }}>已隱藏的項目</div>
              {hiddenLeaves.map(leave => (
                <LeaveCard key={leave.id} leave={leave} isHidden={true} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default Home