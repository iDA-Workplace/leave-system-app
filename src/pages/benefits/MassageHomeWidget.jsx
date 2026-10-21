import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Card, Chip, ConfirmDialog } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchSessionBundle, fmtDate, fmtDateTime, phaseTone, sessionPhase, sessionWindow,
} from '../../lib/massage'
import { MyStatus } from './MassageHome'
import './Massage.css'

/**
 * 系統首頁最上面的「報名按摩」。
 *
 * 只在報名期間顯示（還沒抽籤、報名還沒截止），沒有開放中的期數就整塊不出現。
 * 報名、取消報名、請假擋下的說明都直接用員工福利頁的 MyStatus，規則一模一樣。
 */
function MassageHomeWidget({ userProfile }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [items, setItems] = useState([])    // [{ session, signups, leave }]
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const reload = () => setTick(n => n + 1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: sessions } = await supabase.from('massage_sessions').select('*')
        .is('drawn_at', null).gt('signup_deadline', new Date().toISOString()).order('session_date')
      const loaded = await Promise.all((sessions || []).map(async s => {
        const [{ signups }, { data: leave }] = await Promise.all([
          fetchSessionBundle(s.id),
          supabase.rpc('massage_my_leave_status', { p_session_id: s.id }),
        ])
        return { session: s, signups, leave }
      }))
      if (!cancelled) setItems(loaded)
    })()
    return () => { cancelled = true }
  }, [tick])

  async function run(fn, args, successKey, params) {
    setBusy(true)
    const res = await callMassage(fn, args)
    setBusy(false)
    setConfirm(null)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else if (successKey) showToast(t(successKey, params))
    reload()
  }

  if (items.length === 0) return null
  const now = new Date()

  return (
    <>
      {items.map(({ session, signups, leave }) => (
        <OpenSessionCard
          key={session.id} session={session} signups={signups} leave={leave} now={now}
          myId={userProfile?.id} busy={busy} run={run} setConfirm={setConfirm}
        />
      ))}
      {confirm && (
        <ConfirmDialog
          title={t(confirm.titleKey)}
          description={t(confirm.descKey, confirm.params)}
          confirmLabel={t(confirm.confirmKey)}
          danger={confirm.danger}
          loading={busy}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  )
}

function OpenSessionCard({ session, signups, leave, now, myId, busy, run, setConfirm }) {
  const { t, lang } = useLanguage()
  const phase = sessionPhase(session, now)
  const win = sessionWindow(session)
  const mine = signups.find(s => s.user_id === myId)

  return (
    <Card className="massage-session massage-home-widget">
      <div className="massage-session__head">
        <div>
          <div className="massage-session__title">💆 {session.title}</div>
          <div className="massage-session__meta">{fmtDate(session.session_date, lang)} {win.from}–{win.to}</div>
        </div>
        <div className="massage-actions massage-actions--tight">
          <Chip tone={phaseTone(phase)}>{t(`massage_phase_${phase}`)}</Chip>
          <Link to="/benefits/massage" className="massage-link">{t('massage_home_widget_more')} →</Link>
        </div>
      </div>
      <dl className="massage-facts">
        <div><dt>{t('massage_signup_deadline')}</dt><dd>{fmtDateTime(session.signup_deadline, lang)}</dd></div>
        {session.draw_scheduled_at && (
          <div><dt>{t('massage_draw_time')}</dt><dd>{fmtDateTime(session.draw_scheduled_at, lang)}</dd></div>
        )}
        <div><dt>{t('massage_cancel_deadline')}</dt><dd>{fmtDateTime(session.cancel_deadline, lang)}</dd></div>
        <div><dt>{t('massage_capacity')}</dt><dd>{t('massage_capacity_value', { n: activeSignups(signups).length, cap: session.slot_count })}</dd></div>
      </dl>
      <MyStatus
        session={session} phase={phase} now={now} mine={mine} signups={signups} leave={leave}
        busy={busy} run={run} setConfirm={setConfirm} embedded
      />
    </Card>
  )
}

export default MassageHomeWidget
