import { useState, useEffect } from 'react'
import { Calendar, momentLocalizer, Navigate } from 'react-big-calendar'
import moment from 'moment'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import { supabase } from '../lib/supabase'
import { Button, Card, PageHeader, Skeleton } from '../components/ui'
import './Calendar.css'

moment.locale('zh-tw')
const localizer = momentLocalizer(moment)

function CustomToolbar({ date, view, onNavigate, onView }) {
  return (
    <div className="calendar-toolbar">
      <div className="calendar-toolbar__nav">
        <Button variant="tonal" size="sm" onClick={() => onNavigate(Navigate.TODAY)}>今天</Button>
        <Button variant="tonal" size="sm" onClick={() => onNavigate(Navigate.PREVIOUS)}>
          {view === 'month' ? '上個月' : '上一週'}
        </Button>
        <Button variant="tonal" size="sm" onClick={() => onNavigate(Navigate.NEXT)}>
          {view === 'month' ? '下個月' : '下一週'}
        </Button>
        <span className="calendar-toolbar__label">
          {view === 'month'
            ? moment(date).format('YYYY 年 MM 月')
            : `${moment(date).startOf('isoWeek').format('MM/DD')} ～ ${moment(date).endOf('isoWeek').format('MM/DD')}`
          }
        </span>
      </div>
      <div className="calendar-toolbar__views">
        <Button variant={view === 'month' ? 'filled' : 'tonal'} size="sm" onClick={() => onView('month')}>月</Button>
        <Button variant={view === 'week' ? 'filled' : 'tonal'} size="sm" onClick={() => onView('week')}>週</Button>
      </div>
    </div>
  )
}

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
      color: '#fff',
      fontSize: '12px',
      padding: '2px 6px'
    }
  })

  const dayPropGetter = (date) => {
    const weekStart = moment().startOf('isoWeek').toDate()
    const weekEnd = moment().startOf('isoWeek').add(4, 'days').toDate()
    const isThisWeek = date >= weekStart && date <= weekEnd
    if (isThisWeek) {
      return { className: 'calendar-day--this-week' }
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
      <PageHeader title="請假行事曆" />

      {loading ? <Skeleton height="600px" /> : (
        <Card className="calendar-card">
          <div className="calendar-legend">
            <div className="calendar-legend__item">
              <span className="calendar-legend__swatch calendar-legend__swatch--week" />
              <span>本週</span>
            </div>
            <div className="calendar-legend__item">
              <span className="calendar-legend__swatch calendar-legend__swatch--allday" />
              <span>整天假</span>
            </div>
            <div className="calendar-legend__item">
              <span className="calendar-legend__swatch calendar-legend__swatch--partial" />
              <span>半天/時段假</span>
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
            <div className="calendar-detail">
              <div className="calendar-detail__header">
                <div className="calendar-detail__name">{selected.requester?.full_name}</div>
                <button className="calendar-detail__close" onClick={() => setSelected(null)} aria-label="關閉">✕</button>
              </div>
              <div className="calendar-detail__body">
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
        </Card>
      )}
    </div>
  )
}

export default LeaveCalendar
