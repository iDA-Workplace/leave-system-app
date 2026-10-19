import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button } from './ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { callMassage, fmtDate, slotRange } from '../lib/massage'
import '../pages/benefits/Massage.css'

/**
 * 送出假單之後：如果這張假單撞到自己已經報名／排好的按摩，提醒他把名額釋出。
 *
 * 判斷「撞到」的規則在資料庫（massage_signups_hit_by_leave）：
 *   · 已排好時段 → 只看自己那個時段
 *   · 還沒有時段 → 只有整段都不能按才算（只撞到部分時段的，排時段時會自動避開）
 *
 * 只提醒、不自動取消：使用者確認由本人決定，按「釋出名額」才會真的釋出。
 * 沒有撞到任何按摩時，這個元件什麼都不顯示。
 */
function MassageLeaveReminder({ leaveId }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [hits, setHits] = useState([])
  const [sessions, setSessions] = useState({})
  const [done, setDone] = useState({})
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    if (!leaveId) return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.rpc('massage_signups_hit_by_leave', { p_leave_id: leaveId })
      const rows = data || []
      let byId = {}
      if (rows.length) {
        const { data: ss } = await supabase.from('massage_sessions')
          .select('id, start_time, slot_minutes, break_minutes')
          .in('id', rows.map(r => r.session_id))
        byId = Object.fromEntries((ss || []).map(s => [s.id, s]))
      }
      if (!cancelled) { setHits(rows); setSessions(byId) }
    })()
    return () => { cancelled = true }
  }, [leaveId])

  async function release(hit) {
    setBusyId(hit.signup_id)
    const res = await callMassage('massage_release', { p_signup_id: hit.signup_id })
    setBusyId(null)
    if (!res.ok) { showToast(t(res.errorKey), { tone: 'error' }); return }
    setDone(d => ({ ...d, [hit.signup_id]: true }))
    showToast(t('massage_toast_released'))
  }

  if (hits.length === 0) return null

  return (
    <div className="massage-leave-reminder" role="status">
      <strong>💆 {t('massage_leave_reminder_title')}</strong>
      {hits.map(hit => {
        const s = sessions[hit.session_id]
        const slot = hit.slot_no && s ? slotRange(s, hit.slot_no) : null
        return (
          <div key={hit.signup_id} className="massage-leave-reminder__row">
            <span>
              {fmtDate(hit.session_date, lang)}
              {slot ? ` ${slot.from}–${slot.to}` : ` ${t(hit.result === 'waitlist' ? 'massage_reminder_waitlist' : 'massage_reminder_signed_up')}`}
            </span>
            {done[hit.signup_id] ? (
              <span className="massage-muted">{t('massage_reminder_released')}</span>
            ) : (
              <Button size="sm" variant="danger-outlined" loading={busyId === hit.signup_id} onClick={() => release(hit)}>
                {t('massage_release')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default MassageLeaveReminder
