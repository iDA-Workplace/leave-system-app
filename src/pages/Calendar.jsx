import { useState, useEffect } from 'react'
import { Calendar, momentLocalizer, Navigate } from 'react-big-calendar'
import moment from 'moment'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import { supabase } from '../lib/supabase'

moment.locale('zh-tw')
const localizer = momentLocalizer(moment)

function CustomToolbar({ date, view, onNavigate, onView }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button onClick={() => onNavigate(Navigate.TODAY)} style={toolbarBtn}>今天</button>
        <button onClick={() => onNavigate(Navigate.PREVIOUS)} style={toolbarBtn}>
          {view === 'month' ? '上個月' : '上一週'}
        </button>
        <button onClick={() => onNavigate(Navigate.NEXT)} style={toolbarBtn}>
          {view === 'month' ? '下個月' : '下一週'}
        </button>
        <span style={{ fontWeight: '600', color: '#1f2937', fontSize: '16px' }}>
          {view === 'month'
            ? moment(date).format('YYYY 年 MM 月')
            : `${moment(date).startOf('isoWeek').format('MM/DD')} ～ ${moment(date).endOf('isoWeek').format('MM/DD')}`
          }
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => onView('month')}
          style={{ ...toolbarBtn, backgroundColor: view === 'month' ? '#4F46E5' : '#f3f4f6', color: view === 'month' ? 'white' : '#374151' }}
        >
          月
        </button>
        <button
          onClick={() => onView('week')}
          style={{ ...toolbarBtn, backgroundColor: view === 'week' ? '#4F46E5' : '#f3f4f6', color: view === 'week' ? 'white' : '#374151' }}
        >
          週
        </button>
      </div>
    </div>
  )
}

const toolbarBtn = {
  padding: '6px 14px',
  backgroundColor: '#f3f4f6',
  color: '#374151',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: '500'
}

function LeaveCalendar() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetchLeaves()
  }, [])

  async function fetchLeaves() {
    const { data, error } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name),
        leave_type:leave_types(name, color),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name)
      `)
      .eq('status', 'approved')
      .order('start_date')

    const mappedEvents = (data || []).map(leave => {
      const isAllDay = !leave.hours || leave.hours >= 8 || leave.end_date > leave.start_date

      let start, end
      if (isAllDay) {
        const [sy, sm, sd] = leave.start_date.split('-').map(Number)
        const [ey, em, ed] = leave.end_date.split('-').map(Number)
        start = new Date(sy, sm - 1, sd, 0, 0, 0)
        end = new Date(ey, em - 1, ed, 23, 59, 59)
      } else {
        const [sy, sm, sd] = leave.start_date.split('-').map(Number)
        const [sh, smin] = (leave.start_time || '09:00').split(':').map(Number)
        const [eh, emin] = (leave.end_time || '18:00').split(':').map(Number)
        start = new Date(sy, sm - 1, sd, sh, smin, 0)
        end = new Date(sy, sm - 1, sd, eh, emin, 0)
      }

      return {
        id: leave.id,
        title: leave.requester?.full_name + ' (' + leave.leave_type?.name + ')',
        start,
        end,
        allDay: isAllDay,
        color: leave.leave_type?.color || '#4F46E5',
        resource: leave
      }
    })

    setEvents(mappedEvents)
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
    const weekStart = moment().startOf('isoWeek').toDate()
    const weekEnd = moment().startOf('isoWeek').add(4, 'days').toDate()
    const isThisWeek = date >= weekStart && date <= weekEnd
    if (isThisWeek) {
      return { style: { backgroundColor: '#EEF2FF' } }
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
    noEventsInRange: '這段時間沒有人請假',
    allDay: '整天',
    showMore: total => `+${total} 更多`
  }

  return (
    <div>
      <h2 style={{ marginBottom: '24px', color: '#1f2937', fontSize: '22px' }}>請假行事曆</h2>

      {loading ? <p style={{ color: '#6b7280' }}>載入中...</p> : (
        <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ marginBottom: '12px', display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '3px', backgroundColor: '#EEF2FF', border: '1px solid #c7d2fe' }}></div>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>本週</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '3px', backgroundColor: '#4F46E5' }}></div>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>整天假</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '12px', height: '4px', borderRadius: '2px', backgroundColor: '#4F46E5' }}></div>
              <span style={{ fontSize: '13px', color: '#6b7280' }}>半天/時段假</span>
            </div>
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
            components={{ toolbar: CustomToolbar }}
            popup
          />

          {selected && (
            <div style={{
              marginTop: '20px', padding: '16px 20px',
              backgroundColor: '#f9fafb', borderRadius: '10px',
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
                {selected.start_time && selected.hours < 8 && (
                  <div>時段：{selected.start_time} ～ {selected.end_time}（{selected.hours} 小時）</div>
                )}
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