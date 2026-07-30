import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { format, startOfWeek, addDays } from 'date-fns'
import { zhTW } from 'date-fns/locale'
import { Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui'
import './Home.css'

function Home({ userProfile }) {
  const [weekLeaves, setWeekLeaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [hiddenIds, setHiddenIds] = useState([])
  const [showHidden, setShowHidden] = useState(false)

  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')
  const weekStart = startOfWeek(today, { weekStartsOn: 1 })
  const weekEnd = addDays(weekStart, 4)
  const weekEndStr = format(weekEnd, 'yyyy-MM-dd')

  useEffect(() => {
    fetchWeekLeaves()
    fetchHiddenIds()
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

  async function fetchHiddenIds() {
    const { data } = await supabase
      .from('user_preferences')
      .select('hidden_leave_ids')
      .eq('user_id', userProfile.id)
      .single()

    if (data) setHiddenIds(data.hidden_leave_ids || [])
  }

  async function toggleHide(id) {
    const newHiddenIds = hiddenIds.includes(id)
      ? hiddenIds.filter(i => i !== id)
      : [...hiddenIds, id]

    setHiddenIds(newHiddenIds)

    await supabase
      .from('user_preferences')
      .upsert({
        user_id: userProfile.id,
        hidden_leave_ids: newHiddenIds,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
  }

  const visibleLeaves = weekLeaves.filter(l => !hiddenIds.includes(l.id))
  const hiddenLeaves = weekLeaves.filter(l => hiddenIds.includes(l.id))

  function LeaveCard({ leave, isHidden }) {
    const color = leave.leave_type?.color || 'var(--sys-color-primary)'
    return (
      <Card className="home-leave-card" style={{ borderLeft: `4px solid ${color}`, opacity: isHidden ? 0.6 : 1 }}>
        <div className="home-leave-card__avatar" style={{ backgroundColor: color + '26', color }}>
          {leave.requester?.full_name?.charAt(0)}
        </div>
        <div className="home-leave-card__body">
          <div className="home-leave-card__name">{leave.requester?.full_name}</div>
          <div className="home-leave-card__meta">
            {leave.leave_type?.name}｜{leave.start_date} ～ {leave.end_date}
            {leave.proxy?.full_name && ` ｜ 代理：${leave.proxy.full_name}`}
          </div>
        </div>
        <Button variant={isHidden ? 'tonal' : 'outlined'} size="sm" onClick={() => toggleHide(leave.id)}>
          {isHidden ? '顯示' : '隱藏'}
        </Button>
      </Card>
    )
  }

  return (
    <div>
      <PageHeader
        title="本週請假總覽"
        actions={hiddenLeaves.length > 0 && (
          <Button variant="outlined" size="sm" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? '隱藏已隱藏的項目' : `顯示已隱藏（${hiddenLeaves.length}）`}
          </Button>
        )}
      />
      <p className="home-date-range">
        {format(today, 'yyyy/MM/dd', { locale: zhTW })} ～ {format(weekEnd, 'yyyy/MM/dd', { locale: zhTW })}
      </p>

      {loading ? (
        <div className="home-leave-list">
          <Skeleton height="72px" />
          <Skeleton height="72px" />
        </div>
      ) : weekLeaves.length === 0 ? (
        <Card>
          <EmptyState icon="🎉" title="本週沒有人請假" />
        </Card>
      ) : (
        <div className="home-leave-list">
          {visibleLeaves.map(leave => (
            <LeaveCard key={leave.id} leave={leave} isHidden={false} />
          ))}
          {visibleLeaves.length === 0 && hiddenLeaves.length > 0 && (
            <Card>
              <EmptyState title="所有假單都已隱藏" description="點右上角「顯示已隱藏」查看" />
            </Card>
          )}
          {showHidden && hiddenLeaves.length > 0 && (
            <div>
              <div className="home-hidden-label">已隱藏的項目</div>
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
