import { useState, useEffect } from 'react'
import { Calendar, momentLocalizer } from 'react-big-calendar'
import moment from 'moment'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import { supabase } from '../lib/supabase'

moment.locale('zh-tw')
const localizer = momentLocalizer(moment)

function LeaveCalendar() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetchLeaves()
  }, [])

  async function fetchLeaves() {
    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(name, color),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name)
      `)
      .eq('status', 'approved')
      .order('start_date')

    const events = (data || []).map(leave => ({
      id: leave.id,
      title: leave.requester?.full_name + ' (' + leave.leave_type?.name + ')',
      start: new Date(leave.start_date + 'T00:00:00'),
      end: new Date(leave.end_date + 'T23:59:59'),
      color: leave.leave_type?.color || '#4F46E5',
      resource: leave
    }))

    setEvents(events)
    setLoading(false)
  }

  const eventStyleGetter = (event) => ({
    style: {
      backgroundColor: event.color,
      borderRadius: '6px',
      border: 'none',
      color: 'white',
      fontSize: '12px',
      padding: '2px 6px'
    }
  })

  const dayPropGetter = (date) => {
    const today = new Date()
    const weekStart = moment().startOf('isoWeek').toDate()
    const weekEnd = moment().endOf('isoWeek').subtract(2, 'days').toDate()
    const isThisWeek = date >= weekStart && date <= weekEnd

    if (isThisWeek) {
      return {
        style: { backgroundColor: '#EEF2FF' }
      }
    }
    return {}
  }

  const messages = {
    today: '今天',
    previous: '上個月',
    next: '下個月',
    month: '月',
    week: '週',
    day: '日',
    agenda: '議程',
    date: '日期',
    time: '時間',
    event: '假單',
    noEventsInRange: '這段時間沒有人請假'
  }

  return (
    <div>
      <h2 style={{ marginBottom: '24px', color: '#1f2937', fontSize: '22px' }}>請假行事曆</h2>

      {loading ? <p style={{ color: '#6b7280' }}>載入中...</p> : (
        <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '3px', backgroundColor: '#EEF2FF', border: '1px solid #c7d2fe' }}></div>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>本週</span>
          </div>

          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            style={{ height: 600 }}
            eventPropGetter={eventStyleGetter}
            dayPropGetter={dayPropGetter}
            messages={messages}
            views={['month', 'week']}
            defaultView="month"
            onSelectEvent={event => setSelected(event.resource)}
            popup
          />

          {/* 點擊假單顯示詳情 */}
          {selected && (
            <div style={{
              marginTop: '20px',
              padding: '16px 20px',
              backgroundColor: '#f9fafb',
              borderRadius: '10px',
              border: '1px solid #e5e7eb'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: '600', color: '#1f2937', fontSize: '16px' }}>
                  {selected.requester?.full_name}
                </div>
                <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '18px' }}>✕</button>
              </div>
              <div style={{ fontSize: '14px', color: '#6b7280', display: 'grid', gap: '4px' }}>
                <div>假別：{selected.leave_type?.name}</div>
                <div>日期：{selected.start_date} ～ {selected.end_date}</div>
                {selected.hours && <div>時數：{selected.hours} 小時</div>}
                {selected.proxy?.full_name && <div>工作代理人：{selected.proxy.full_name}</div>}
                <div>原因：{selected.reason}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default LeaveCalendar