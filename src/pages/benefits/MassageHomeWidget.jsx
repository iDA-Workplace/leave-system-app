import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, ConfirmDialog } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchSessionBundle, fmtDate, fmtDateTime, phaseTone, sessionPhase, sessionWindow,
  taipeiDate, taipeiToday,
} from '../../lib/massage'
import { MyStatus } from './MassageHome'
import './Massage.css'

/**
 * 系統首頁最上面的「報名按摩」。
 *
 * 報名期間（還沒抽籤、報名還沒截止）：完整的報名卡片。報名、取消報名、請假擋下
 * 的說明都直接用員工福利頁的 MyStatus，規則一模一樣。
 * 報名截止後到按摩結束：只留一張小卡和「按摩名單」按鈕，連到員工福利頁的
 * 公開名單（抽籤前是報名名單，抽籤後是時段表）。全部同仁都看得到。
 * 都不是（沒有期數、或已經按完）就整塊不出現。
 */
function MassageHomeWidget({ userProfile }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [items, setItems] = useState([])    // 報名中：[{ session, signups, leave }]
  const [closed, setClosed] = useState([])  // 報名截止、還沒按完的期數
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const reload = () => setTick(n => n + 1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: sessions } = await supabase.from('massage_sessions').select('*')
        .gte('session_date', taipeiToday()).order('session_date')
      const now = new Date()
      const open = (sessions || []).filter(s => sessionPhase(s, now) === 'open')
      const later = (sessions || []).filter(s => {
        const phase = sessionPhase(s, now)
        return (phase === 'closed' || phase === 'drawn') && now < taipeiDate(s.session_date, sessionWindow(s).to)
      })
      const loaded = await Promise.all(open.map(async s => {
        const [{ signups }, { data: leave }] = await Promise.all([
          fetchSessionBundle(s.id),
          supabase.rpc('massage_my_leave_status', { p_session_id: s.id }),
        ])
        return { session: s, signups, leave }
      }))
      if (!cancelled) { setItems(loaded); setClosed(later) }
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

  if (items.length === 0 && closed.length === 0) return null
  const now = new Date()

  return (
    <>
      {closed.map(session => <ClosedSessionCard key={session.id} session={session} now={now} />)}
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
          <Link to={`/benefits/massage?session=${session.id}#massage-rules`} className="massage-link">{t('massage_home_widget_more')} →</Link>
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

/** 報名截止後到按摩結束：小卡＋「按摩名單」 */
function ClosedSessionCard({ session, now }) {
  const { t, lang } = useLanguage()
  const navigate = useNavigate()
  const phase = sessionPhase(session, now)
  const win = sessionWindow(session)
  return (
    <Card className="massage-session massage-home-widget">
      <div className="massage-session__head">
        <div>
          <div className="massage-session__title">💆 {session.title}</div>
          <div className="massage-session__meta">{fmtDate(session.session_date, lang)} {win.from}–{win.to}</div>
        </div>
        <div className="massage-actions massage-actions--tight">
          <Chip tone={phaseTone(phase)}>{t(`massage_phase_${phase}`)}</Chip>
          <Button size="sm" onClick={() => navigate(`/benefits/massage?session=${session.id}#massage-lists`)}>{t('massage_home_list')}</Button>
        </div>
      </div>
    </Card>
  )
}

export default MassageHomeWidget
