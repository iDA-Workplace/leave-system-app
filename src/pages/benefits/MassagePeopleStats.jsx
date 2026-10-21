import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { Button, Card, Skeleton, TextField } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import { fmtDate } from '../../lib/massage'

/**
 * 同仁的跨期紀錄（管理員與 HR）。
 *
 * 只算「已經抽籤」的期數 —— 還在報名中的那一期結果還沒出來，算進去會讓
 * 「沒抽中」之類的數字失真。
 *
 * 「連續沒抽中」：從最近一期往回數，這位同仁有報名、但抽籤當下是候補、
 * 而且後來也沒有遞補上的期數。中間只要有一期抽中或遞補上就歸零；
 * 沒報名的期數不算（不會因為沒報名而中斷，也不會累加）。
 *
 * 「管理員加入」：管理者直接把人加進空時段（massage_add_to_slot）。這期沒有
 * 自己報名的（added_at 有值、draw_rank 是 null），不算進「報名」次數。
 */
function buildPeople(sessions, signups) {
  const drawn = sessions.filter(s => s.drawn_at)
  const sessionById = Object.fromEntries(drawn.map(s => [s.id, s]))
  const byUser = {}
  for (const g of signups) {
    const s = sessionById[g.session_id]
    if (!s) continue
    const p = (byUser[g.user_id] ||= {
      userId: g.user_id, name: g.user?.full_name || '', dept: g.user?.department || '',
      signedUp: 0, selected: 0, waitlisted: 0, promoted: 0, added: 0, attended: 0, noShow: 0,
      cancelled: 0, cancelledLate: 0, yielded: 0, lastAttended: null, history: [],
    })
    const inDraw = g.draw_rank != null
    const wasSelected = inDraw && g.draw_rank <= s.slot_count
    const promoted = !!g.promoted_at
    const addedOnly = !!g.added_at && g.draw_rank == null
    if (!addedOnly) p.signedUp += 1
    if (g.added_at) p.added += 1
    if (wasSelected) p.selected += 1
    if (inDraw && !wasSelected) p.waitlisted += 1
    if (promoted) p.promoted += 1
    if (g.attendance === 'attended') {
      p.attended += 1
      if (!p.lastAttended || s.session_date > p.lastAttended) p.lastAttended = s.session_date
    }
    if (g.attendance === 'no_show') p.noShow += 1
    if (g.yield_answer === 'yielded') p.yielded += 1
    else if (g.released_at) p.cancelled += 1
    if (g.released_late) p.cancelledLate += 1
    if (inDraw) p.history.push({ date: s.session_date, lost: !wasSelected && !promoted })
  }
  for (const p of Object.values(byUser)) {
    p.history.sort((a, b) => (a.date < b.date ? 1 : -1))
    let streak = 0
    for (const h of p.history) { if (!h.lost) break; streak += 1 }
    p.streak = streak
  }
  return Object.values(byUser).sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name))
}

const COLUMNS = [
  ['name', 'massage_col_name'],
  ['dept', 'massage_col_dept'],
  ['signedUp', 'massage_people_signed_up'],
  ['selected', 'massage_people_selected'],
  ['waitlisted', 'massage_people_waitlisted'],
  ['promoted', 'massage_people_promoted'],
  ['added', 'massage_people_added'],
  ['attended', 'massage_people_attended'],
  ['noShow', 'massage_people_no_show'],
  ['cancelled', 'massage_people_cancelled'],
  ['cancelledLate', 'massage_people_cancelled_late'],
  ['yielded', 'massage_people_yielded'],
  ['streak', 'massage_people_streak'],
  ['lastAttended', 'massage_people_last_attended'],
]

function MassagePeopleStats() {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [data, setData] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data: sessions }, { data: signups }] = await Promise.all([
        supabase.from('massage_sessions').select('id, session_date, slot_count, drawn_at'),
        supabase.from('massage_signups').select(`
          user_id, session_id, draw_rank, promoted_at, added_at, released_at, released_late, yield_answer, attendance,
          user:users!massage_signups_user_id_fkey(full_name, department)
        `),
      ])
      if (!cancelled) setData({ sessions: sessions || [], signups: signups || [] })
    })()
    return () => { cancelled = true }
  }, [])

  const people = useMemo(() => (data ? buildPeople(data.sessions, data.signups) : []), [data])
  if (!data) return <Card><Skeleton height="120px" /></Card>

  const drawnCount = data.sessions.filter(s => s.drawn_at).length
  const q = query.trim()
  const visible = q ? people.filter(p => p.name.includes(q) || p.dept.includes(q)) : people
  const cell = (p, key) => (key === 'lastAttended' ? (p.lastAttended ? fmtDate(p.lastAttended, lang) : '—') : p[key])

  function exportExcel() {
    const rows = visible.map(p => Object.fromEntries(COLUMNS.map(([key, label]) => [t(label), cell(p, key)])))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), t('massage_sheet_people'))
    XLSX.writeFile(wb, `${t('massage_people_filename')}.xlsx`)
    showToast(t('massage_toast_exported'))
  }

  return (
    <Card>
      <div className="massage-toolbar">
        <h3 className="massage-card-title">{t('massage_people_title')}</h3>
        <Button size="sm" variant="outlined" onClick={exportExcel} disabled={visible.length === 0}>{t('massage_export_excel')}</Button>
      </div>
      <p className="massage-hint">{t('massage_people_hint', { n: drawnCount })}</p>
      <div className="massage-search">
        <TextField aria-label={t('massage_people_search')} placeholder={t('massage_people_search')} value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      {visible.length === 0 ? <p className="massage-hint">{t('massage_people_empty')}</p> : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead><tr>{COLUMNS.map(([key, label]) => <th key={key}>{t(label)}</th>)}</tr></thead>
            <tbody>
              {visible.map(p => (
                <tr key={p.userId}>
                  {COLUMNS.map(([key]) => <td key={key}>{cell(p, key)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export default MassagePeopleStats
