import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import { fmtDateTime, slotEndAt, slotRange } from '../../lib/massage'

/**
 * 某一期的完整紀錄（管理員與 HR 才看得到；資料庫層也只開放給這兩種人讀）。
 *
 * 報名資料表只有「現在的狀態」，所以「原本的時段」「怎麼遞補上的」「是誰
 * 標的出席」這些經過，都是從異動紀錄（massage_events）還原出來的。
 */

const EVENT_SELECT = `
  id, created_at, event, slot_no, details, signup_id, user_id, actor_id,
  user:users!massage_events_user_id_fkey(full_name),
  actor:users!massage_events_actor_id_fkey(full_name)
`

/** 把一期的報名資料 + 異動紀錄整理成「每人一列」 */
function buildRoster(session, signups, events) {
  const bySignup = {}
  for (const e of events) {
    if (!e.signup_id) continue
    ;(bySignup[e.signup_id] ||= []).push(e)
  }
  const rows = signups.map(s => {
    const evs = bySignup[s.id] || []
    const first = evs.find(e => e.event === 'signed_up')
    const draw = evs.find(e => e.event === 'draw_result')
    const accepted = evs.find(e => e.event === 'accepted')
    const assigned = evs.find(e => e.event === 'assigned')
    const added = [...evs].reverse().find(e => e.event === 'added')
    const released = [...evs].reverse().find(e => e.event === 'released')
    const withdrewCount = evs.filter(e => e.event === 'withdrew').length
    const moves = evs.filter(e => e.event === 'moved')
    const lastAttendance = [...evs].reverse().find(e => e.event === 'attendance' || e.event === 'no_show')
    const offers = evs.filter(e => e.event === 'offered').length
    return {
      s,
      firstSignedUpAt: first?.created_at || s.signed_up_at,
      withdrewCount,
      rank: draw?.details?.rank ?? s.draw_rank,
      drawResult: draw?.details?.result ?? null,
      originalSlot: draw ? draw.slot_no : null,
      avoidedLeave: !!draw?.details?.avoided_leave,
      promotedBy: accepted ? 'self' : assigned ? 'manager' : null,
      promotedActor: assigned?.actor?.full_name || null,
      added: !!added,
      addedActor: added?.actor?.full_name || null,
      released,
      moves,
      offers,
      attendanceBy: lastAttendance
        ? (lastAttendance.event === 'no_show' || lastAttendance.details?.by === 'manager' ? 'manager' : 'self')
        : null,
      attendanceActor: lastAttendance?.actor?.full_name || null,
    }
  })
  rows.sort((a, b) => {
    const ra = a.rank ?? Infinity
    const rb = b.rank ?? Infinity
    return ra - rb || new Date(a.firstSignedUpAt) - new Date(b.firstSignedUpAt)
  })
  return rows
}

function buildStats(session, rows) {
  const now = new Date()
  const count = f => rows.filter(f).length
  return [
    ['massage_stat_signed_up', rows.length],
    ['massage_stat_withdrew_before', count(r => r.s.released_at && r.rank == null)],
    ['massage_stat_selected', count(r => r.drawResult === 'selected')],
    ['massage_stat_waitlisted', count(r => r.drawResult === 'waitlist')],
    ['massage_stat_promoted', count(r => r.promotedBy)],
    ['massage_stat_added', count(r => r.added)],
    ['massage_stat_cancelled_after', count(r => r.released?.details?.reason === 'cancel' && !r.released.details.late)],
    ['massage_stat_cancelled_late', count(r => r.released?.details?.late)],
    ['massage_stat_yielded', count(r => r.released?.details?.reason === 'yield')],
    ['massage_stat_attended', count(r => r.s.attendance === 'attended')],
    ['massage_stat_no_show', count(r => r.s.attendance === 'no_show')],
    ['massage_stat_unmarked', count(r => !r.s.released_at && r.s.slot_no && !r.s.attendance && now >= slotEndAt(session, r.s.slot_no))],
  ]
}

/** 一筆異動紀錄 → 一句人看得懂的話 */
function describe(e, session, t, lang) {
  const name = e.user?.full_name || t('massage_ev_someone')
  const actor = e.actor?.full_name || t('massage_ev_system')
  const d = e.details || {}
  const slotText = n => (n ? t('massage_ev_slot', { n, from: slotRange(session, n).from }) : '')
  switch (e.event) {
    case 'signed_up':
      return d.reactivated
        ? t('massage_ev_signed_up_again', { name, time: fmtDateTime(d.previous_signed_up_at, lang) })
        : t('massage_ev_signed_up', { name })
    case 'withdrew': return t('massage_ev_withdrew', { name })
    case 'drawn':
      return d.was_lottery
        ? t('massage_ev_drawn_lottery', { total: d.total, selected: d.selected, waitlist: d.waitlist })
        : t('massage_ev_drawn_no_lottery', { total: d.total })
    case 'released':
      if (d.reason === 'yield') return t('massage_ev_yielded', { name, slot: slotText(e.slot_no) })
      if (!e.slot_no) return t('massage_ev_left_waitlist', { name })
      return t(d.late ? 'massage_ev_released_late' : 'massage_ev_released', { name, slot: slotText(e.slot_no) })
    case 'yield_answered': return t('massage_ev_yield_kept', { name })
    case 'offered': return t('massage_ev_offered', { name, slot: slotText(e.slot_no) })
    case 'offer_expired': return t('massage_ev_offer_expired', { name, slot: slotText(e.slot_no) })
    case 'offer_lost':
      return t(d.reason === 'slot_over' ? 'massage_ev_offer_lost_over' : 'massage_ev_offer_lost_taken', { name, slot: slotText(e.slot_no) })
    case 'offer_superseded': return t('massage_ev_offer_superseded', { name, slot: slotText(e.slot_no) })
    case 'accepted': return t('massage_ev_accepted', { name, slot: slotText(e.slot_no) })
    case 'assigned':
      return t(d.slot_conflict ? 'massage_ev_assigned_conflict' : 'massage_ev_assigned', { name, actor, slot: slotText(e.slot_no) })
    case 'moved': return t('massage_ev_moved', { name, from: d.from, to: d.to })
    case 'hidden': return t('massage_ev_hidden', { actor })
    case 'unhidden': return t('massage_ev_unhidden', { actor })
    case 'added':
      return t(d.slot_conflict ? 'massage_ev_added_conflict' : 'massage_ev_added', { name, actor, slot: slotText(e.slot_no) })
    case 'no_show': return t('massage_ev_no_show', { name, actor, slot: slotText(e.slot_no) })
    case 'attendance':
      if (d.by === 'self') return t('massage_ev_done_self', { name })
      if (d.status === 'attended') return t('massage_ev_marked_attended', { name, actor })
      if (d.status === 'no_show') return t('massage_ev_marked_no_show', { name, actor })
      return t('massage_ev_marked_cleared', { name, actor })
    default: return e.event
  }
}

const TIMELINE_PAGE_SIZE = 10

function MassageRecords({ session, signups }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [events, setEvents] = useState(null)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('massage_events').select(EVENT_SELECT)
        .eq('session_id', session.id).order('id')
      if (!cancelled) setEvents(error ? [] : data || [])
    })()
    return () => { cancelled = true }
  }, [session.id, signups])

  const rows = useMemo(() => (events ? buildRoster(session, signups, events) : []), [session, signups, events])
  if (!events) return <Skeleton height="200px" />

  const drawn = events.find(e => e.event === 'drawn')
  const stats = buildStats(session, rows)
  // 每人的抽籤結果已經在名單裡，時間軸只放「發生了什麼事」，免得被 9～17 筆洗版
  const timeline = events.filter(e => e.event !== 'draw_result')
  // 畫面上：最新的在最前面，一頁 10 筆（不讓時間軸佔掉整個頁面）。匯出 Excel 仍是全部、照時間先後
  const totalPages = Math.max(1, Math.ceil(timeline.length / TIMELINE_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = [...timeline].reverse()
    .slice((currentPage - 1) * TIMELINE_PAGE_SIZE, currentPage * TIMELINE_PAGE_SIZE)

  const slotLabel = n => (n ? `${n}（${slotRange(session, n).from}）` : '—')
  const resultLabel = r => (r.drawResult ? t(`massage_result_${r.drawResult}`) : t('massage_result_none'))
  const attendanceLabel = r => {
    if (!r.s.attendance) return r.s.slot_no && !r.s.released_at ? t('massage_attendance_unmarked') : '—'
    const label = t(`massage_attendance_${r.s.attendance}`)
    // 誰標的：看最後一筆出席／沒到的紀錄；沒有這種紀錄時，是逾期取消自動記成沒到
    let by = null
    if (r.attendanceBy === 'self') by = t('massage_by_self')
    else if (r.attendanceBy === 'manager') by = r.attendanceActor || t('massage_by_manager')
    else if (r.released?.details?.late) by = t('massage_by_late_cancel')
    return by ? `${label}（${by}）` : label
  }
  const notes = r => {
    const out = []
    if (r.withdrewCount && !r.s.released_at) out.push([t('massage_note_resigned', { n: r.withdrewCount }), 'neutral'])
    if (r.promotedBy === 'self') out.push([t('massage_note_promoted_self'), 'success'])
    if (r.promotedBy === 'manager') out.push([t('massage_note_promoted_manager', { name: r.promotedActor || '' }), 'success'])
    if (r.added) out.push([t('massage_note_added', { name: r.addedActor || '' }), 'success'])
    if (r.moves.length) out.push([t('massage_note_moved', { n: r.moves.length }), 'info'])
    if (r.released?.details?.reason === 'yield') out.push([t('massage_note_yielded'), 'info'])
    else if (r.released?.details?.late) out.push([t('massage_note_cancelled_late', { time: fmtDateTime(r.released.created_at, lang) }), 'error'])
    else if (r.released) out.push([t('massage_note_cancelled', { time: fmtDateTime(r.released.created_at, lang) }), 'neutral'])
    // 沒到也會把時段放出來（released_at 有值），但那不是取消 —— 只有抽籤前的退出才看 released_at
    else if (r.s.released_at && r.rank == null) out.push([t('massage_note_withdrew', { time: fmtDateTime(r.s.released_at, lang) }), 'neutral'])
    if (r.avoidedLeave) out.push([t('massage_note_avoided_leave'), 'warning'])
    if (r.s.slot_conflict) out.push([t('massage_chip_leave_conflict'), 'warning'])
    if (r.offers && !r.promotedBy) out.push([t('massage_note_offered_n', { n: r.offers }), 'neutral'])
    return out
  }

  function exportExcel() {
    const roster = rows.map(r => ({
      [t('massage_col_rank')]: r.rank ?? '',
      [t('massage_col_name')]: r.s.user?.full_name || '',
      [t('massage_col_dept')]: r.s.user?.department || '',
      [t('massage_col_signed_at')]: fmtDateTime(r.firstSignedUpAt, lang),
      [t('massage_col_draw_result')]: resultLabel(r),
      [t('massage_col_original_slot')]: r.originalSlot ? slotLabel(r.originalSlot) : '',
      [t('massage_col_final_slot')]: r.s.released_at ? '' : (r.s.slot_no ? slotLabel(r.s.slot_no) : ''),
      [t('massage_col_notes')]: notes(r).map(([text]) => text).join('、'),
      [t('massage_col_attendance')]: attendanceLabel(r),
    }))
    const log = timeline.map(e => ({
      [t('massage_col_time')]: fmtDateTime(e.created_at, lang),
      [t('massage_col_actor')]: e.actor?.full_name || t('massage_ev_system'),
      [t('massage_col_what')]: describe(e, session, t, lang),
    }))
    const summary = stats.map(([key, n]) => ({ [t('massage_col_item')]: t(key), [t('massage_col_count_n')]: n }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(roster), t('massage_sheet_roster'))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(log), t('massage_sheet_log'))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), t('massage_sheet_stats'))
    XLSX.writeFile(wb, `${t('massage_export_filename', { title: session.title })}.xlsx`)
    showToast(t('massage_toast_exported'))
  }

  return (
    <>
      <div className="massage-toolbar">
        <p className="massage-hint">{t('massage_records_hint')}</p>
        <Button size="sm" variant="outlined" onClick={exportExcel}>{t('massage_export_excel')}</Button>
      </div>

      <Card>
        <h3 className="massage-card-title">{t('massage_records_draw_title')}</h3>
        {drawn ? (
          <dl className="massage-facts">
            <div><dt>{t('massage_drawn_at')}</dt><dd>{fmtDateTime(drawn.created_at, lang)}</dd></div>
            <div><dt>{t('massage_drawn_by')}</dt><dd>{drawn.actor?.full_name || '—'}</dd></div>
            <div><dt>{t('massage_drawn_mode')}</dt><dd>{drawn.details?.was_lottery ? t('massage_drawn_mode_lottery') : t('massage_drawn_mode_order')}</dd></div>
            <div><dt>{t('massage_drawn_counts')}</dt><dd>{t('massage_drawn_counts_value', { total: drawn.details?.total ?? 0, selected: drawn.details?.selected ?? 0, waitlist: drawn.details?.waitlist ?? 0 })}</dd></div>
            <div><dt>{t('massage_drawn_conflicts')}</dt><dd>{drawn.details?.slot_conflicts ?? 0}</dd></div>
            <div><dt>{t('massage_drawn_yield_asked')}</dt><dd>{drawn.details?.yield_asked ?? 0}</dd></div>
          </dl>
        ) : <p className="massage-hint">{t('massage_records_not_drawn')}</p>}
      </Card>

      <Card>
        <h3 className="massage-card-title">{t('massage_records_stats_title')}</h3>
        <div className="massage-stats">
          {stats.map(([key, n]) => (
            <div key={key} className="massage-stat">
              <div className="massage-stat__n">{n}</div>
              <div className="massage-stat__label">{t(key)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h3 className="massage-card-title">{t('massage_records_roster_title', { n: rows.length })}</h3>
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{t('massage_col_rank')}</th><th>{t('massage_col_name')}</th><th>{t('massage_col_signed_at')}</th>
                <th>{t('massage_col_draw_result')}</th><th>{t('massage_col_slot_change')}</th>
                <th>{t('massage_col_notes')}</th><th>{t('massage_col_attendance')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.s.id} className={r.s.released_at ? 'massage-row--released' : ''}>
                  <td>{r.rank ?? '—'}</td>
                  <td>{r.s.user?.full_name}</td>
                  <td>{fmtDateTime(r.firstSignedUpAt, lang)}</td>
                  <td>{resultLabel(r)}</td>
                  <td>
                    {r.originalSlot && r.originalSlot !== r.s.slot_no
                      ? `${slotLabel(r.originalSlot)} → ${r.s.released_at ? t('massage_slot_released') : slotLabel(r.s.slot_no)}`
                      : (r.s.released_at ? (r.originalSlot ? `${slotLabel(r.originalSlot)} → ${t('massage_slot_released')}` : '—') : slotLabel(r.s.slot_no))}
                  </td>
                  <td>
                    <div className="massage-chips">
                      {notes(r).map(([text, tone]) => <Chip key={text} tone={tone}>{text}</Chip>)}
                    </div>
                  </td>
                  <td>{attendanceLabel(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h3 className="massage-card-title">{t('massage_records_timeline_title', { n: timeline.length })}</h3>
        {timeline.length === 0 ? <p className="massage-hint">{t('massage_records_timeline_empty')}</p> : (
          <>
            <ol className="massage-timeline">
              {pageItems.map(e => (
                <li key={e.id}>
                  <span className="massage-timeline__time">{fmtDateTime(e.created_at, lang)}</span>
                  <span className="massage-timeline__what">{describe(e, session, t, lang)}</span>
                  <span className="massage-timeline__actor">{e.actor?.full_name || t('massage_ev_system')}</span>
                </li>
              ))}
            </ol>
            {totalPages > 1 && (
              <div className="massage-pagination">
                <Button size="sm" variant="outlined" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t('common_prev_page')}</Button>
                <span className="massage-muted">{t('common_page_indicator', { page: currentPage, total: totalPages })}</span>
                <Button size="sm" variant="outlined" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>{t('common_next_page')}</Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}

export default MassageRecords
